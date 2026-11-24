// #7 auto-wait (pure): a state machine over driver observations.
// attached -> visible -> stable (same box on two consecutive frames) ->
// enabled -> [editable] -> in view (else scroll, then re-test) -> hit-test.
// After `timeout` the last failing condition is reported as NOT_ACTIONABLE
// with reason detached|hidden|moving|disabled|covered. `covered` quotes the
// covering element (page text), so the error is marked pageText.
import type { TabAgentError } from "@tabagent/protocol";
import { staleRef, taErr } from "./errors";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Observation {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  editable?: boolean;
  /** Box now and one animation frame later. */
  box: Box | null;
  box2?: Box | null;
  inView: boolean;
  /** Click point (frame-local CSS px). */
  point?: { x: number; y: number };
  hit?: { ok: boolean; by?: string };
  /** Why the element has no box (page text), e.g. "inside <div#S:0> which is display:none". */
  why?: string;
}

export type Reason = "detached" | "hidden" | "moving" | "disabled" | "covered";

export type Verdict = { ok: true; point: { x: number; y: number } } | { ok: false; reason: Reason; by?: string; scroll?: boolean } | { ok: false; fatal: "not-editable" };

const same = (a: Box | null | undefined, b: Box | null | undefined) =>
  !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;

export function judge(o: Observation, needEditable = false): Verdict {
  if (!o.attached) return { ok: false, reason: "detached" };
  if (!o.visible || !o.box || o.box.w <= 0 || o.box.h <= 0) return { ok: false, reason: "hidden", ...(o.why ? { by: o.why } : {}) };
  if (o.box2 !== undefined && !same(o.box, o.box2)) return { ok: false, reason: "moving" };
  if (!o.enabled) return { ok: false, reason: "disabled" };
  if (needEditable && o.editable === false) return { ok: false, fatal: "not-editable" };
  if (!o.inView) return { ok: false, reason: "covered", by: "nothing (outside the viewport)", scroll: true };
  if (o.hit && !o.hit.ok) return { ok: false, reason: "covered", by: o.hit.by };
  const p = o.point ?? { x: o.box.x + o.box.w / 2, y: o.box.y + o.box.h / 2 };
  return { ok: true, point: p };
}

const HINTS: Record<Reason, string> = {
  detached: "The element was removed from the page. Take a new page.snapshot.",
  hidden: "The element is hidden. If page.find returned several matches, use one without `hidden` (the rendered copy); otherwise open its parent menu/section or finish the earlier form step first; for custom checkboxes use act.check.",
  moving: "The element is still animating; try again.",
  disabled: "The element is disabled. Required fields may need filling first.",
  covered: "Another element is on top (modal, cookie banner, sticky header?). Close it first, or scroll.",
};

export function notActionable(ref: string, reason: Reason, by?: string): TabAgentError {
  if (reason === "covered" && by) {
    return taErr("NOT_ACTIONABLE", `${ref} is not actionable (reason: covered): covered by ${by}`, HINTS.covered, { pageText: true });
  }
  if (reason === "hidden" && by) {
    return taErr("NOT_ACTIONABLE", `${ref} is not actionable (reason: hidden): ${by}`, HINTS.hidden, { pageText: true });
  }
  return taErr("NOT_ACTIONABLE", `${ref} is not actionable (reason: ${reason})`, HINTS[reason]);
}

export interface WaitDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Observe the element; `scroll` asks the page to scroll it into view first. */
  observe(scroll: boolean): Promise<Observation>;
  /** Abort check between steps (debugger detached, dialog opened, ...). */
  check?(): void;
}

export async function autoWait(ref: string, deps: WaitDeps, opts: { timeout?: number; needEditable?: boolean; interval?: number } = {}): Promise<{ x: number; y: number }> {
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 100;
  const deadline = deps.now() + timeout;
  let scroll = false;
  let first = true;
  let scrolls = 0;
  for (;;) {
    deps.check?.();
    const o = await deps.observe(scroll);
    scroll = false;
    if (first && !o.attached) throw staleRef(ref, "the element is no longer in the page");
    first = false;
    const v = judge(o, opts.needEditable);
    if (v.ok) return v.point;
    if ("fatal" in v) throw taErr("NOT_ACTIONABLE", `${ref} is not a text field`, "Use act.select for selects, act.check for checkboxes, act.click for buttons.");
    if (v.scroll && scrolls < 3) {
      // scroll into view, then re-hit-test immediately
      scrolls++;
      scroll = true;
      continue;
    }
    if (deps.now() >= deadline) throw notActionable(ref, v.reason, v.by);
    await deps.sleep(interval);
  }
}
