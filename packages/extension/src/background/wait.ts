// #26 nav.wait + page.find helpers (pure).
import { taErr } from "./errors";

export const NAV_WAIT_DEFAULT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const FIND_LIMIT = 20;

export type WaitKind = "load" | "networkidle" | "selector" | "text" | "url" | "fn";

export interface WaitSpec {
  kind: WaitKind;
  value?: string;
  timeout: number;
}

export function normalizeWait(p: { for?: string; value?: string; timeout?: number }): WaitSpec {
  const kind = p.for as WaitKind;
  if (!["load", "networkidle", "selector", "text", "url", "fn"].includes(kind)) throw taErr("BAD_REQUEST", `nav.wait: unknown for="${p.for}"`, "Use load, networkidle, selector, text, url or fn.");
  if (["selector", "text", "url", "fn"].includes(kind) && !p.value) throw taErr("BAD_REQUEST", `nav.wait for=${kind} needs value`);
  const timeout = Math.min(p.timeout ?? NAV_WAIT_DEFAULT_MS, MAX_TIMEOUT_MS);
  if (kind === "url") urlMatcher(p.value!); // validate early
  return { kind, value: p.value, timeout };
}

/** Substring match, or a regex when the value is wrapped in slashes: `/a\d+/`. */
export function urlMatcher(value: string): (url: string) => boolean {
  if (value.length >= 2 && value.startsWith("/") && value.endsWith("/")) {
    let re: RegExp;
    try {
      re = new RegExp(value.slice(1, -1));
    } catch (e) {
      throw taErr("BAD_REQUEST", `nav.wait url: invalid regex ${value}: ${(e as Error).message}`, "Wrap a regex in slashes, e.g. /\\/item\\/\\d+$/; anything else is a substring.");
    }
    return (u) => re.test(u);
  }
  return (u) => u.includes(value);
}

export function describeWait(w: WaitSpec): string {
  return `${w.kind}${w.value ? ` ${JSON.stringify(w.value.slice(0, 120))}` : ""}`;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Poll `pred` every `interval` ms until true or timeout. Errors count as "not yet". */
export async function pollUntil(pred: () => Promise<boolean> | boolean, timeout: number, clock: Clock, interval = 100): Promise<boolean> {
  const end = clock.now() + timeout;
  for (;;) {
    try {
      if (await pred()) return true;
    } catch {
      /* navigating, context gone: retry */
    }
    if (clock.now() >= end) return false;
    await clock.sleep(Math.min(interval, Math.max(1, end - clock.now())));
  }
}

/**
 * D35 networkidle: the driver's own in-flight counter. Idle = zero requests in
 * flight for `quiet` ms. Requests stuck longer than `stuckMs` (long-poll,
 * streaming) are ignored.
 */
export class InflightCounter {
  private inflight = new Map<string, number>();
  private lastChange: number;
  constructor(
    private clock: Pick<Clock, "now">,
    private stuckMs = 10_000,
  ) {
    this.lastChange = clock.now();
  }
  start(id: string) {
    this.inflight.set(id, this.clock.now());
    this.lastChange = this.clock.now();
  }
  end(id: string) {
    if (this.inflight.delete(id)) this.lastChange = this.clock.now();
  }
  /** Drop ids matching a predicate (e.g. a frame handed its request to a child session). */
  endWhere(pred: (id: string) => boolean) {
    for (const k of [...this.inflight.keys()]) if (pred(k)) this.end(k);
  }
  clear() {
    this.inflight.clear();
    this.lastChange = this.clock.now();
  }
  count(): number {
    const now = this.clock.now();
    for (const [k, t] of this.inflight) if (now - t > this.stuckMs) this.inflight.delete(k);
    return this.inflight.size;
  }
  ids() {
    return [...this.inflight.keys()];
  }
  isIdle(quiet: number): boolean {
    return this.count() === 0 && this.clock.now() - this.lastChange >= quiet;
  }
  async waitIdle(quiet: number, timeout: number, clock: Clock, interval = 25): Promise<boolean> {
    return pollUntil(() => this.isIdle(quiet), timeout, clock, interval);
  }
}

// ---------------------------------------------------------------------------
// page.find
// ---------------------------------------------------------------------------
export type FindBy = "text" | "role" | "label" | "css" | "xpath";

export interface FindSpec {
  by: FindBy;
  value: string;
  name?: string;
  root?: string;
}

/** Accepts the D-spec shape `{by, value, name?, root?}` and the spike's `{text|role|label|css|xpath, name}`. */
export function normalizeFind(p: Record<string, unknown>): FindSpec {
  const root = typeof p.root === "string" ? p.root : undefined;
  const name = typeof p.name === "string" && p.name ? p.name : undefined;
  if (typeof p.by === "string") {
    if (!["text", "role", "label", "css", "xpath"].includes(p.by)) throw taErr("BAD_REQUEST", `page.find: unknown by="${p.by}"`, "Use by: text | role | label | css | xpath.");
    if (typeof p.value !== "string" || !p.value) throw taErr("BAD_REQUEST", "page.find needs a non-empty value");
    return { by: p.by as FindBy, value: p.value, name, root };
  }
  for (const by of ["css", "xpath", "label", "role", "text"] as FindBy[]) {
    if (typeof p[by] === "string" && p[by]) return { by, value: p[by] as string, name, root };
  }
  if (name) return { by: "text", value: name, root };
  throw taErr("BAD_REQUEST", "page.find needs {by, value}", 'Example: {"by":"role","value":"button","name":"Save"}');
}

export interface FindMatch {
  ref: string;
  role: string;
  name: string;
  /** Set when the element has no rendered box, with why (page text). Rendered matches come first. */
  hidden?: string;
}

type RawMatch = { ref: string | null; role: string; name: string; hidden?: string };
/** pagelib findNodes matches (refs already minted) -> FindMatch, dropping unmapped nodes. */
export function toMatches(raw: RawMatch[]): FindMatch[] {
  return raw.filter((m) => m.ref).map((m) => ({ ref: m.ref!, role: m.role, name: m.name, ...(m.hidden ? { hidden: m.hidden } : {}) }));
}

/** Merge per-frame matches (already in document order) and cap at the limit. */
export function capMatches(perFrame: FindMatch[][], limit = FIND_LIMIT): { matches: FindMatch[]; truncated: boolean } {
  const all = perFrame.flat();
  return { matches: all.slice(0, limit), truncated: all.length > limit };
}
