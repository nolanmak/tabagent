// Bridge side of the CAPTCHA solve wire (#61). Mirrors the auth secret channel (../auth/bridge.ts):
// the bridge answers only for an in-flight command that may solve (captcha.solve, or act.click /
// form.submit on a session whose token has autoCaptcha), on the socket the command went out on.
//
// Providers run in the configured fallback order (default: capsolver). A token provider's token goes
// back to the extension and nowhere else; when the order reaches `vision`, the bridge hands over to the
// extension's vision rounds (captcha.vision.request), and the extension comes back with `exclude` to
// continue after it. Audit: one event per provider call with vendor, origin, provider, outcome, ms and
// reason. Never the token, the key, the image or the prompt.
import {
  AUTO_CAPTCHA_TOOLS,
  CaptchaSolveRequestSchema,
  CaptchaVisionRequestSchema,
  captchaReasonOf,
  captchaUnsolved,
  toTabAgentError,
  type CaptchaProviderName,
  type CaptchaReason,
  type CaptchaToken,
  type CaptchaVisionAnswer,
} from "@tabagent/protocol";
import type { CaptchaSettings, TokenProviderName } from "./config";
import type { CaptchaProvider, VisionSolver } from "./provider";

export interface CaptchaInFlight {
  tool: string;
  ws?: unknown;
  meta?: { id: string; label: string; autoCaptcha?: boolean };
}

export interface CaptchaAuditSink {
  event(event: string, data: Record<string, unknown> | undefined, who?: { caller: string; session?: string }): void;
}

export interface CaptchaBridgeOpts {
  inFlight: (commandId: string) => CaptchaInFlight | undefined;
  settings: () => CaptchaSettings;
  tokenProvider: (name: TokenProviderName, key: string) => CaptchaProvider;
  visionProvider: (v: { baseUrl: string; model: string; key?: string }) => VisionSolver;
  audit: CaptchaAuditSink;
  log?: (m: string) => void;
  now?: () => number;
}

/** Token-provider calls one command may make (spend cap per call). */
export const MAX_SOLVES_PER_COMMAND = 3;
/** Vision rounds one command may make. */
export const MAX_VISION_ROUNDS_PER_COMMAND = 10;

type Send = (m: CaptchaToken | CaptchaVisionAnswer) => void;

const isToken = (p: CaptchaProviderName): p is TokenProviderName => p === "capsolver" || p === "2captcha";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class CaptchaBridge {
  private perCommand = new Map<string, { solves: number; rounds: number }>();
  private recent: number[] = [];
  private aborters = new Set<AbortController>();
  private now: () => number;
  constructor(private o: CaptchaBridgeOpts) {
    this.now = o.now ?? Date.now;
  }

  /** Returns true when the message was a captcha request (fully handled here). Kill aborts solves. */
  onExtMessage(msg: unknown, ws: unknown, send: Send): boolean {
    const m = msg as { type?: string; event?: unknown; data?: { kind?: unknown } } | null;
    if (m?.type === "captcha.solve.request") {
      void this.onSolve(msg, ws, send).catch((e) => this.o.log?.(`captcha: solve failed (${toTabAgentError(e).code})`));
      return true;
    }
    if (m?.type === "captcha.vision.request") {
      void this.onVision(msg, ws, send).catch((e) => this.o.log?.(`captcha: vision failed (${toTabAgentError(e).code})`));
      return true;
    }
    if (m?.type === "event" && (m.event === "killed" || m.event === "kill" || m.data?.kind === "kill")) this.abortAll();
    return false;
  }

  abortAll() {
    for (const a of this.aborters) a.abort();
    this.aborters.clear();
  }

  /** Is this command allowed to spend a solve? */
  private allowed(commandId: string, ws: unknown): CaptchaInFlight | null {
    const f = this.o.inFlight(commandId);
    if (!f || (f.ws !== undefined && ws !== undefined && f.ws !== ws)) return null;
    if (f.tool === "captcha.solve") return f;
    if (AUTO_CAPTCHA_TOOLS.includes(f.tool) && f.meta?.autoCaptcha === true) return f;
    return null;
  }

  private counters(commandId: string) {
    // Commands that ended leave counters behind: drop them.
    for (const k of this.perCommand.keys()) if (!this.o.inFlight(k)) this.perCommand.delete(k);
    let c = this.perCommand.get(commandId);
    if (!c) this.perCommand.set(commandId, (c = { solves: 0, rounds: 0 }));
    return c;
  }

  /** Sliding one-hour window over provider calls (token solves and vision rounds). */
  private takeHourly(max: number): boolean {
    const t = this.now();
    this.recent = this.recent.filter((x) => t - x < 3_600_000);
    if (this.recent.length >= max) return false;
    this.recent.push(t);
    return true;
  }

  private who(f: CaptchaInFlight) {
    return f.meta ? { caller: f.meta.label, session: f.meta.id } : undefined;
  }

  private async onSolve(raw: unknown, ws: unknown, send: Send) {
    const p = CaptchaSolveRequestSchema.safeParse(raw);
    if (!p.success) return;
    const r = p.data;
    const reply = (m: Omit<CaptchaToken, "type" | "id" | "commandId">) => send({ type: "captcha.token", id: r.id, commandId: r.commandId, ...m });
    const fail = (reason: CaptchaReason, tried?: CaptchaProviderName[]) => reply({ ok: false, reason, error: captchaUnsolved(reason, r.vendor).toJSON(), ...(tried ? { tried } : {}) });
    const base = { kind: "captcha", vendor: r.vendor, origin: originOf(r.url) };
    const f = this.allowed(r.commandId, ws);
    if (!f) {
      this.o.audit.event("captcha.provider", { ...base, outcome: "denied", reason: "not_allowed" });
      return fail("not_allowed");
    }
    const who = this.who(f);
    if (r.vendor === "arkose") return fail("unsupported_vendor");
    const s = this.o.settings();
    const tried: CaptchaProviderName[] = [...(r.exclude ?? [])];
    let last: CaptchaReason | undefined;
    for (const name of s.providers) {
      if (tried.includes(name)) continue;
      if (name === "vision") {
        if (!s.vision.baseUrl || !s.vision.model) {
          tried.push(name);
          last ??= "no_provider";
          continue;
        }
        return reply({ ok: false, vision: true, rounds: s.vision.rounds, tried, ...(last ? { reason: last } : {}) });
      }
      if (!isToken(name)) continue;
      tried.push(name);
      const key = s.keys[name]?.key;
      if (!key) {
        last ??= "no_provider";
        continue;
      }
      const c = this.counters(r.commandId);
      if (c.solves >= MAX_SOLVES_PER_COMMAND || !this.takeHourly(s.maxPerHour)) {
        this.o.audit.event("captcha.provider", { ...base, tool: f.tool, provider: name, outcome: "denied", reason: "rate_limited" }, who);
        return fail("rate_limited", tried);
      }
      c.solves++;
      const started = this.now();
      const ac = new AbortController();
      this.aborters.add(ac);
      try {
        const token = await this.o.tokenProvider(name, key).solve({ vendor: r.vendor, sitekey: r.sitekey, url: r.url, invisible: r.invisible, enterprise: r.enterprise, version: r.version, action: r.action, cdata: r.cdata }, ac.signal);
        this.o.audit.event("captcha.provider", { ...base, tool: f.tool, provider: name, outcome: "ok", ms: this.now() - started }, who);
        return reply({ ok: true, token, provider: name });
      } catch (e) {
        const err = toTabAgentError(e);
        last = captchaReasonOf(err.message) ?? "provider_error";
        this.o.audit.event("captcha.provider", { ...base, tool: f.tool, provider: name, outcome: "error", reason: last, ms: this.now() - started }, who);
        this.o.log?.(`captcha: ${name} failed (${last})`);
      } finally {
        this.aborters.delete(ac);
      }
    }
    return fail(last ?? "no_provider", tried);
  }

  private async onVision(raw: unknown, ws: unknown, send: Send) {
    const p = CaptchaVisionRequestSchema.safeParse(raw);
    if (!p.success) return;
    const r = p.data;
    const reply = (m: Omit<CaptchaVisionAnswer, "type" | "id">) => send({ type: "captcha.vision.answer", id: r.id, ...m });
    const fail = (reason: CaptchaReason) => reply({ ok: false, reason, error: captchaUnsolved(reason, r.vendor).toJSON() });
    const f = this.allowed(r.commandId, ws);
    if (!f) return fail("not_allowed");
    const who = this.who(f);
    const s = this.o.settings();
    if (!s.providers.includes("vision") || !s.vision.baseUrl || !s.vision.model) return fail("no_provider");
    const c = this.counters(r.commandId);
    const base = { kind: "captcha", tool: f.tool, vendor: r.vendor, provider: "vision", challenge: r.kind };
    if (c.rounds >= MAX_VISION_ROUNDS_PER_COMMAND || !this.takeHourly(s.maxPerHour)) {
      this.o.audit.event("captcha.provider", { ...base, outcome: "denied", reason: "rate_limited" }, who);
      return fail("rate_limited");
    }
    c.rounds++;
    const started = this.now();
    const ac = new AbortController();
    this.aborters.add(ac);
    try {
      const ans = await this.o.visionProvider({ baseUrl: s.vision.baseUrl, model: s.vision.model, key: s.vision.key?.key }).answer({ vendor: r.vendor, prompt: r.prompt, kind: r.kind, rows: r.rows, cols: r.cols, imageBase64: r.imageBase64, mime: r.mime }, ac.signal);
      this.o.audit.event("captcha.provider", { ...base, outcome: "ok", ms: this.now() - started }, who);
      return reply({ ok: true, ...ans });
    } catch (e) {
      const reason = captchaReasonOf(toTabAgentError(e).message) ?? "provider_error";
      this.o.audit.event("captcha.provider", { ...base, outcome: "error", reason, ms: this.now() - started }, who);
      return fail(reason);
    } finally {
      this.aborters.delete(ac);
    }
  }
}
