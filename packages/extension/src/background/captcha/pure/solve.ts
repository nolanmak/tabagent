// #61 solve orchestration. Pure: the page, the driver and the bridge are injected (index.ts wires
// them), so every path is unit-tested with stubs.
//
//   1. detect the widget (humanCheck) and pick one: by ref, else the first unsolved one that blocks
//   2. already solved                         -> method "already"
//   3. checkbox widget: trusted CDP click inside the vendor frame, poll ~6s -> method "click"
//   4. ask the bridge, which runs its providers in the configured order:
//        token (capsolver / 2captcha) -> write it into the response field, fire the callback, re-check
//        vision hand-over             -> up to N rounds: screenshot the challenge, ask the model, tap
//                                        the answer with trusted clicks, submit, re-check; then go back
//                                        to the bridge with `exclude` so the order continues
//   5. otherwise CAPTCHA_UNSOLVED with the reason.
// One audit event per solve: vendor, origin, outcome, method, provider, reason, ms. Never the token.
import {
  CAPTCHA_CLICK_POLL_MS,
  captchaUnsolved,
  TabAgentError,
  type CaptchaProviderName,
  type CaptchaReason,
  type CaptchaToken,
  type CaptchaVendor,
  type CaptchaVisionAnswer,
  type VisionAnswer,
} from "@tabagent/protocol";
import type { TokenRequest, VisionRequest } from "./channel";

export interface WidgetInfo {
  vendor: CaptchaVendor;
  sitekey: string | null;
  invisible: boolean;
  enterprise: boolean;
  version?: "v2" | "v3";
  passive?: boolean;
  action?: string;
  cdata?: string;
  callback?: string;
  solved: boolean;
  visible: boolean;
  challengeVisible: boolean;
  /** Ref of the widget (container or iframe). */
  ref: string;
  frameKey?: string;
  challengeRef?: string;
}

export interface ChallengeInfo {
  vendor: CaptchaVendor;
  prompt: string;
  kind: "grid" | "canvas";
  rows?: number;
  cols?: number;
  /** Tile refs, row-major (grid). */
  tiles: string[];
  /** Ref to screenshot (the grid view or the canvas). */
  areaRef: string;
  submitRef: string | null;
}

export interface SolveDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  detect(): Promise<{ url: string; widgets: WidgetInfo[] }>;
  /** Trusted click on the widget's checkbox (inside its frame). false = nothing to click. */
  clickCheckbox(w: WidgetInfo): Promise<boolean>;
  requestToken(req: TokenRequest): Promise<CaptchaToken>;
  /** Write the token into the response field(s) and fire the page's callback. */
  inject(w: WidgetInfo, token: string): Promise<{ written: number; callback: boolean }>;
  challenge(w: WidgetInfo): Promise<ChallengeInfo | null>;
  screenshot(ch: ChallengeInfo): Promise<{ imageBase64: string; mime: "image/png" | "image/jpeg" }>;
  askVision(round: VisionRequest): Promise<CaptchaVisionAnswer>;
  tap(ch: ChallengeInfo, answer: VisionAnswer): Promise<void>;
  submitChallenge(ch: ChallengeInfo): Promise<void>;
  event(name: string, data: Record<string, unknown>): void;
}

export interface SolveResult {
  vendor: CaptchaVendor;
  solved: true;
  method: "already" | "click" | "solver";
  provider?: CaptchaProviderName;
  ms: number;
}

const POLL_STEP_MS = 300;
const AFTER_SUBMIT_MS = 1_500;
const MAX_BRIDGE_TURNS = 5;

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A widget that stops the user: unsolved, not score-only. */
const blocking = (w: WidgetInfo) => !w.solved && !w.passive;

function pick(widgets: WidgetInfo[], ref?: string): WidgetInfo {
  if (ref) {
    const w = widgets.find((x) => x.ref === ref);
    if (!w) throw new TabAgentError("NOT_FOUND", `${ref} is not a CAPTCHA widget`, "Call captcha.solve without ref, or pass the widget's ref from page.snapshot.");
    return w;
  }
  const open = widgets.filter(blocking);
  const w = open.find((x) => x.challengeVisible) ?? open.find((x) => x.visible) ?? open[0] ?? widgets.find((x) => !x.passive && x.solved);
  if (!w) throw new TabAgentError("NOT_FOUND", "No CAPTCHA on this page", "Nothing to solve. If the page still blocks you, take a page.screenshot.");
  return w;
}

async function current(deps: SolveDeps, w: WidgetInfo): Promise<WidgetInfo | undefined> {
  const { widgets } = await deps.detect();
  return widgets.find((x) => x.ref === w.ref) ?? widgets.find((x) => x.vendor === w.vendor && x.sitekey === w.sitekey);
}

type VisionOutcome = { ok: true } | { ok: false; reason: CaptchaReason };

async function visionRounds(deps: SolveDeps, w: WidgetInfo, rounds: number): Promise<VisionOutcome> {
  for (let i = 0; i < rounds; i++) {
    const now = await current(deps, w);
    if (now?.solved) return { ok: true };
    const ch = await deps.challenge(w);
    if (!ch) return { ok: false, reason: i === 0 ? "vision_unsupported" : "unsolvable" };
    const shot = await deps.screenshot(ch);
    const ans = await deps.askVision({ vendor: ch.vendor, prompt: ch.prompt, kind: ch.kind, ...(ch.rows ? { rows: ch.rows } : {}), ...(ch.cols ? { cols: ch.cols } : {}), ...shot });
    // Refusals and unparseable answers fail fast: another round would get the same answer.
    if (!ans.ok) return { ok: false, reason: ans.reason ?? "provider_error" };
    const answer: VisionAnswer = ch.kind === "grid" ? { cells: ans.cells ?? [] } : { points: ans.points ?? [] };
    await deps.tap(ch, answer);
    await deps.submitChallenge(ch);
    await deps.sleep(AFTER_SUBMIT_MS);
    if ((await current(deps, w))?.solved) return { ok: true };
  }
  return { ok: false, reason: "unsolvable" };
}

export async function solveCaptcha(deps: SolveDeps, o: { ref?: string; widget?: WidgetInfo }): Promise<SolveResult> {
  const started = deps.now();
  const { url, widgets } = await deps.detect();
  const w = o.widget ? (widgets.find((x) => x.ref === o.widget!.ref) ?? o.widget) : pick(widgets, o.ref);
  const base = { vendor: w.vendor, origin: origin(url) };
  let method: SolveResult["method"] | undefined;
  let provider: CaptchaProviderName | undefined;
  let reason: CaptchaReason | undefined;
  let rounds = 0;
  const done = (m: SolveResult["method"], p?: CaptchaProviderName): SolveResult => {
    method = m;
    provider = p;
    return { vendor: w.vendor, solved: true, method: m, ...(p ? { provider: p } : {}), ms: deps.now() - started };
  };
  const fail = (r: CaptchaReason): never => {
    reason = r;
    throw captchaUnsolved(r, w.vendor);
  };
  try {
    if (w.solved) return done("already");
    if (w.vendor === "arkose") fail("unsupported_vendor");

    // Free path: a trusted click on the checkbox, then poll the solved state.
    if (!w.invisible && !w.passive && !w.challengeVisible && (await deps.clickCheckbox(w))) {
      const until = deps.now() + CAPTCHA_CLICK_POLL_MS;
      while (deps.now() < until) {
        await deps.sleep(POLL_STEP_MS);
        const now = await current(deps, w);
        if (now?.solved) return done("click");
        if (now?.challengeVisible) break; // an image challenge: no point waiting it out
      }
    }

    // Solver path, in the bridge's provider order.
    // Token providers need the site key; without one only vision can help.
    const exclude: CaptchaProviderName[] = w.sitekey ? [] : ["capsolver", "2captcha"];
    let visionReason: CaptchaReason | undefined = w.sitekey ? undefined : "no_sitekey";
    for (let turn = 0; turn < MAX_BRIDGE_TURNS; turn++) {
      const reply = await deps.requestToken({
        vendor: w.vendor,
        sitekey: w.sitekey ?? "unknown",
        url,
        invisible: w.invisible,
        enterprise: w.enterprise,
        ...(w.version ? { version: w.version } : {}),
        ...(w.action ? { action: w.action } : {}),
        ...(w.cdata ? { cdata: w.cdata } : {}),
        ...(exclude.length ? { exclude: [...exclude] } : {}),
      });
      if (reply.ok && typeof reply.token === "string" && reply.token) {
        await deps.inject(w, reply.token);
        if ((await current(deps, w))?.solved) return done("solver", reply.provider);
        fail("not_accepted");
      }
      if (reply.vision) {
        const r = await visionRounds(deps, w, reply.rounds ?? 3);
        rounds += 1;
        if (r.ok) return done("solver", "vision");
        visionReason = r.reason;
        for (const p of [...(reply.tried ?? []), "vision" as const]) if (!exclude.includes(p)) exclude.push(p);
        continue;
      }
      const r = reply.reason ?? "provider_error";
      fail(visionReason && (r === "no_provider" || r === "provider_error") ? visionReason : r);
    }
    return fail(visionReason ?? "provider_error");
  } finally {
    deps.event("captcha.solve", { ...base, outcome: method ? "ok" : "error", ...(method ? { method } : {}), ...(provider ? { provider } : {}), ...(reason ? { reason } : {}), ...(rounds ? { visionSolves: rounds } : {}), ms: deps.now() - started });
  }
}

/**
 * autoCaptcha around act.click / form.submit. before: a visible checkbox widget that is still
 * unsolved gets solved first. after: a challenge the action opened (invisible widgets) gets solved.
 * null when there was nothing to do.
 */
export async function autoCaptchaStep(deps: SolveDeps, phase: "before" | "after"): Promise<SolveResult | null> {
  let { widgets } = await deps.detect();
  const solvable = (w: WidgetInfo) => blocking(w) && w.vendor !== "arkose";
  if (phase === "before") {
    const w = widgets.find((x) => solvable(x) && x.visible && !x.invisible);
    return w ? solveCaptcha(deps, { widget: w }) : null;
  }
  if (!widgets.some(solvable)) return null;
  for (let i = 0; i < 5; i++) {
    const w = widgets.find((x) => solvable(x) && x.challengeVisible);
    if (w) return solveCaptcha(deps, { widget: w });
    await deps.sleep(400);
    ({ widgets } = await deps.detect());
  }
  return null;
}
