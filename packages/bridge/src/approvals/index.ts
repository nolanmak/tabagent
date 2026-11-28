// #108: bridge side of answering prompts outside the side panel.
//
//   extension --prompts.sync--> PendingPrompts (a view; the extension decides)
//   tabagent approve --POST /v1/approvals/answer--> presence check (Touch ID) --> submit() --prompt.answer--> extension
//   phone page (tailnet, one-time link + cookie) --POST /approve/<id>/answer--> submit() --prompt.answer--> extension
//
// submit() is the only code that sends `prompt.answer`, and it requires a proof: a verified presence
// challenge (CLI) or the cookie of a claimed phone link (which itself was handed out only after a presence
// check or a click in the side panel). The extension applies the answer through the same queue as a panel
// click, so the first answer wins and a late one never executes.
import { randomUUID } from "node:crypto";
import {
  answerLabel,
  ApprovalsLinkRequestSchema,
  HANDOFF_TIMEOUT_MIN_MAX,
  PROMPT_ANSWERS,
  PromptAnswerResultSchema,
  PromptsSyncSchema,
  type AnswerOutcome,
  type ApprovalChannel,
  type ErrorCode,
  type MirroredPrompt,
  type OutsideChannel,
  type PromptAnswer,
} from "@tabagent/protocol";
import { readHandoffConfig, type HandoffConfig } from "../handoff/config";
import { HandoffRegistry, type HandoffEntry } from "../handoff/registry";
import { PendingPrompts } from "./mirror";
import { PresenceGate, type PresenceProvider, type PresencePurpose } from "./presence";

export type ApproveOutcome = AnswerOutcome | "presence_failed" | "presence_unavailable" | "busy" | "no_extension" | "bad_request";

export interface ApproveResult {
  ok: boolean;
  outcome: ApproveOutcome;
  channel?: OutsideChannel;
  by?: ApprovalChannel;
  error?: { code: ErrorCode; message: string; hint?: string };
}

export type SubmitProof = { kind: "local"; challengeId: string; mac: string } | { kind: "phone"; linkId: string; cookie: string };

export interface RemoteHost {
  /** Bind (or reuse) the tailnet listener. */
  ensure(): Promise<{ ip: string; port: number }>;
  /** Close it if nothing (handoff or approval link) is live any more. */
  release(): void;
}

export interface ApprovalsOpts {
  presence: PresenceProvider;
  /** Send to the current extension socket; false when none is connected. */
  sendToExt: (m: unknown) => boolean;
  audit: { event(event: string, data: Record<string, unknown>): void };
  remote: RemoteHost;
  config?: () => HandoffConfig;
  now?: () => number;
  log?: (m: string) => void;
  answerTimeoutMs?: number;
  /** After a cancelled or failed presence check, further checks are refused this long (dialog spam). */
  cooldownMs?: number;
  presenceTimeoutMs?: number;
}

export const PHONE_LINK_DEFAULT_MIN = 60;
const PANEL_HINT = "Answer in the TabAgent side panel, or open a phone approval link from the side panel (Settings → Phone link for approvals).";

export class ApprovalsBridge {
  readonly prompts: PendingPrompts;
  readonly gate: PresenceGate;
  readonly links: HandoffRegistry;
  private waits = new Map<string, { resolve: (r: ApproveResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private presenceBusy = false;
  private cooldownUntil = 0;
  private now: () => number;
  private config: () => HandoffConfig;

  constructor(private o: ApprovalsOpts) {
    this.now = o.now ?? Date.now;
    this.config = o.config ?? (() => readHandoffConfig());
    this.prompts = new PendingPrompts(this.now);
    this.gate = new PresenceGate({ now: this.now });
    this.links = new HandoffRegistry({
      now: this.now,
      // A link is only good while the user keeps outside approvals on in the side panel.
      alive: () => this.prompts.enabled,
      onRevoke: (e) => this.auditLink("approval.phone.revoke", e),
      onChange: (n) => {
        if (n === 0) o.remote.release();
      },
    });
  }

  get presenceKind() {
    return this.o.presence.kind;
  }

  // -------------------------------------------------------------------------
  // Extension -> bridge
  // -------------------------------------------------------------------------
  /** True when the message was an approvals message. Only the current paired extension socket counts. */
  onExtMessage(msg: unknown, isCurrent: boolean, reply: (m: unknown) => void): boolean {
    const m = msg as { type?: string; event?: unknown; data?: { kind?: unknown } } | null;
    if (m?.type === "event" && (m.event === "killed" || m.event === "kill" || m.data?.kind === "kill")) {
      this.links.revokeAll();
      return false;
    }
    switch (m?.type) {
      case "prompts.sync": {
        const p = PromptsSyncSchema.safeParse(msg);
        if (!isCurrent || !p.success) return true;
        this.prompts.sync(p.data);
        if (!p.data.enabled) this.links.revokeAll();
        return true;
      }
      case "prompt.answer.result": {
        const p = PromptAnswerResultSchema.safeParse(msg);
        if (!isCurrent || !p.success) return true;
        const w = this.waits.get(p.data.id);
        if (!w) return true;
        this.waits.delete(p.data.id);
        clearTimeout(w.timer);
        w.resolve({ ok: p.data.ok, outcome: p.data.outcome, ...(p.data.by ? { by: p.data.by } : {}) });
        return true;
      }
      case "approvals.link": {
        const p = ApprovalsLinkRequestSchema.safeParse(msg);
        if (!isCurrent || !p.success) return true;
        // A click in the side panel (only extension pages can ask) is the presence proof for this link.
        void this.mintLink("panel", PHONE_LINK_DEFAULT_MIN).then((r) => reply({ type: "approvals.link.result", id: p.data.id, ...r }));
        return true;
      }
    }
    return false;
  }

  /** The extension socket closed or went silent. */
  onExtGone() {
    this.prompts.clear();
    for (const [id, w] of this.waits) {
      clearTimeout(w.timer);
      this.waits.delete(id);
      w.resolve({ ok: false, outcome: "no_extension", error: { code: "NO_EXTENSION", message: "The TabAgent extension disconnected before it answered" } });
    }
  }

  stop() {
    this.links.revokeAll();
    this.onExtGone();
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------
  private async withPresence(purpose: PresencePurpose, binding: string, reason: string): Promise<{ ok: true; challengeId: string; mac: string } | { ok: false; result: ApproveResult }> {
    if (this.presenceBusy) return { ok: false, result: { ok: false, outcome: "busy", error: { code: "BAD_REQUEST", message: "Another approval is waiting for Touch ID or your password" } } };
    if (this.now() < this.cooldownUntil) return { ok: false, result: { ok: false, outcome: "busy", error: { code: "BAD_REQUEST", message: `The last presence check was not confirmed; wait ${Math.ceil((this.cooldownUntil - this.now()) / 1000)}s and try again` } } };
    this.presenceBusy = true;
    try {
      const c = this.gate.issue(purpose, binding);
      const r = await this.o.presence.prove({ reason, message: c.message, key: c.key, timeoutMs: this.o.presenceTimeoutMs ?? 60_000 });
      if (!r.ok) {
        this.audit("approval.presence", { purpose, outcome: r.error, provider: this.o.presence.kind });
        if (r.error === "unavailable") return { ok: false, result: { ok: false, outcome: "presence_unavailable", error: { code: "UNSUPPORTED", message: r.detail ?? "Presence cannot be checked on this machine", hint: PANEL_HINT } } };
        this.cooldownUntil = this.now() + (this.o.cooldownMs ?? 10_000);
        return { ok: false, result: presenceFailed(r.error === "timeout" ? "Touch ID or password was not confirmed in time" : "Touch ID or password was not confirmed") };
      }
      this.audit("approval.presence", { purpose, outcome: "ok", provider: this.o.presence.kind });
      return { ok: true, challengeId: c.challengeId, mac: r.mac };
    } finally {
      this.presenceBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // CLI: GET /v1/approvals, POST /v1/approvals/answer, POST /v1/approvals/phone
  // -------------------------------------------------------------------------
  view() {
    return { enabled: this.prompts.enabled, presence: this.o.presence.kind, prompts: this.prompts.list() };
  }

  /** Checks that need no presence, so a doomed request never pops a dialog. */
  private precheck(promptId: unknown, answer: unknown): { ok: true; prompt: MirroredPrompt; answer: PromptAnswer } | { ok: false; result: ApproveResult } {
    if (typeof promptId !== "string" || !promptId || typeof answer !== "string" || !(PROMPT_ANSWERS as readonly string[]).includes(answer)) {
      return { ok: false, result: { ok: false, outcome: "bad_request", error: { code: "BAD_REQUEST", message: "Expected {promptId, answer: once|always|deny}" } } };
    }
    if (!this.prompts.enabled) return { ok: false, result: { ok: false, outcome: "disabled", error: { code: "PERMISSION_DENIED", message: "Answering prompts outside the side panel is off", hint: "Turn on “Answer prompts outside this panel” in the TabAgent side panel settings." } } };
    const prompt = this.prompts.get(promptId);
    if (!prompt) {
      if (this.prompts.expired(promptId)) return { ok: false, result: { ok: false, outcome: "expired", error: { code: "PROMPT_TIMEOUT", message: "The prompt timed out; the answer was not applied" } } };
      if (this.prompts.recentlyResolved(promptId)) return { ok: false, result: { ok: false, outcome: "already_answered", error: { code: "BAD_REQUEST", message: "The prompt was already answered or has ended" } } };
      return { ok: false, result: { ok: false, outcome: "not_found", error: { code: "NOT_FOUND", message: "No pending prompt with that id" } } };
    }
    if (!prompt.answers.includes(answer as PromptAnswer)) return { ok: false, result: { ok: false, outcome: "not_offered", error: { code: "BAD_REQUEST", message: `This prompt offers ${prompt.answers.join(", ")}` } } };
    return { ok: true, prompt, answer: answer as PromptAnswer };
  }

  async answerWithPresence(promptId: unknown, answer: unknown): Promise<ApproveResult> {
    const pre = this.precheck(promptId, answer);
    if (!pre.ok) return pre.result;
    const label = answerLabel(pre.answer, pre.prompt.alwaysLabel);
    const reason = clip(`answer a TabAgent prompt with “${label}”: ${pre.prompt.title}`, 180);
    const p = await this.withPresence("answer", binding(pre.prompt.promptId, pre.answer), reason);
    if (!p.ok) return p.result;
    return this.submit(pre.prompt.promptId, pre.answer, { kind: "local", challengeId: p.challengeId, mac: p.mac });
  }

  async phoneLinkWithPresence(ttlMin: unknown): Promise<{ ok: boolean; url?: string; expiresAt?: number; error?: ApproveResult["error"]; outcome?: ApproveOutcome }> {
    const cfg = this.config();
    if (!cfg.remote) return { ok: false, outcome: "bad_request", error: { code: "BAD_REQUEST", message: "The phone page needs remote handoff", hint: "Run `tabagent config handoff.remote on` (Tailscale must be up)." } };
    if (!this.prompts.enabled) return { ok: false, outcome: "disabled", error: { code: "PERMISSION_DENIED", message: "Answering prompts outside the side panel is off", hint: "Turn on “Answer prompts outside this panel” in the TabAgent side panel settings." } };
    const min = clampMin(ttlMin);
    const p = await this.withPresence("phone-link", `phone-link|${min}`, clip(`open a one-time phone page that can answer TabAgent prompts for ${min} minutes`, 180));
    if (!p.ok) return { ok: false, outcome: p.result.outcome, error: p.result.error };
    const v = this.gate.verify({ challengeId: p.challengeId, mac: p.mac }, "phone-link", `phone-link|${min}`);
    if (!v.ok) {
      this.audit("approval.presence", { purpose: "phone-link", outcome: `bad_proof:${v.reason}` });
      return presenceFailed("The presence proof was not valid");
    }
    return this.mintLink("cli-presence", min);
  }

  private async mintLink(source: "panel" | "cli-presence", min: number): Promise<{ ok: boolean; url?: string; expiresAt?: number; error?: ApproveResult["error"] }> {
    const cfg = this.config();
    if (!cfg.remote) return { ok: false, error: { code: "BAD_REQUEST", message: "The phone page needs remote handoff", hint: "Run `tabagent config handoff.remote on` (Tailscale must be up)." } };
    if (!this.prompts.enabled) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Answering prompts outside the side panel is off" } };
    let l: { ip: string; port: number };
    try {
      l = await this.o.remote.ensure();
    } catch (e) {
      this.o.remote.release();
      return { ok: false, error: { code: "UNSUPPORTED", message: `The phone page is unavailable: ${(e as Error).message}` } };
    }
    const c = this.links.create({ commandId: `approvals:${randomUUID()}`, ws: null, origin: "", reason: "approvals", sessionLabel: "", ttlMs: min * 60_000 });
    this.auditLink("approval.phone.link", c.entry, { source, ttlMin: min });
    return { ok: true, url: `http://${l.ip}:${l.port}/approve/${c.entry.id}?t=${c.token}`, expiresAt: c.entry.expiresAt };
  }

  // -------------------------------------------------------------------------
  // The one path to the extension
  // -------------------------------------------------------------------------
  async submit(promptId: string, answer: PromptAnswer, proof: SubmitProof): Promise<ApproveResult> {
    const pre = this.precheck(promptId, answer);
    let channel: OutsideChannel;
    const pr = proof as Partial<SubmitProof> | null | undefined;
    if (pr?.kind === "local") {
      // Checked even when the precheck fails, so a proof is always used up by its first attempt.
      const v = this.gate.verify({ challengeId: (pr as { challengeId?: unknown }).challengeId, mac: (pr as { mac?: unknown }).mac }, "answer", binding(String(promptId), String(answer)));
      if (!v.ok) {
        this.audit("approval.presence", { purpose: "answer", outcome: `bad_proof:${v.reason}` });
        return presenceFailed("The presence proof was not valid");
      }
      channel = "cli-presence";
    } else if (pr?.kind === "phone") {
      const { linkId, cookie } = pr as { linkId?: unknown; cookie?: unknown };
      if (typeof linkId !== "string" || typeof cookie !== "string" || !this.links.checkCookie(linkId, cookie)) return presenceFailed("The phone link is not valid");
      channel = "phone";
    } else {
      return presenceFailed("No presence proof");
    }
    if (!pre.ok) return pre.result;
    const r = await this.toExtension(pre.prompt.promptId, pre.answer, channel);
    this.audit("approval.answer", { channel, promptId: pre.prompt.promptId, answer: pre.answer, outcome: r.outcome, ...(r.by ? { by: r.by } : {}) });
    return { ...r, channel };
  }

  private toExtension(promptId: string, answer: PromptAnswer, channel: OutsideChannel): Promise<ApproveResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        resolve({ ok: false, outcome: "no_extension", error: { code: "TIMEOUT", message: "The extension did not answer in time" } });
      }, this.o.answerTimeoutMs ?? 10_000);
      this.waits.set(id, { resolve, timer });
      if (!this.o.sendToExt({ type: "prompt.answer", id, promptId, answer, channel })) {
        clearTimeout(timer);
        this.waits.delete(id);
        resolve({ ok: false, outcome: "no_extension", error: { code: "NO_EXTENSION", message: "The TabAgent extension is not connected" } });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Phone page backend (remote.ts)
  // -------------------------------------------------------------------------
  remoteList(): MirroredPrompt[] {
    return this.prompts.list();
  }

  remoteAnswer(e: HandoffEntry, cookie: string, promptId: unknown, answer: unknown): Promise<ApproveResult> {
    return this.submit(String(promptId ?? ""), answer as PromptAnswer, { kind: "phone", linkId: e.id, cookie });
  }

  status(r: { ok: boolean; outcome?: string }): number {
    return approveStatus(r as { ok: boolean; outcome?: ApproveOutcome });
  }

  remoteEnd(e: HandoffEntry) {
    this.auditLink("approval.phone.end", e);
    this.links.revoke(e.id);
  }

  auditLink(event: string, e: HandoffEntry, data: Record<string, unknown> = {}) {
    // Never the token, the cookie or the link.
    this.audit(event, { kind: "approval", link: e.id.slice(0, 8), ...data });
  }

  private audit(event: string, data: Record<string, unknown>) {
    this.o.audit.event(event, data);
  }
}

const binding = (promptId: string, answer: string) => `${promptId}|${answer}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const presenceFailed = (message: string): ApproveResult => ({ ok: false, outcome: "presence_failed", error: { code: "PERMISSION_DENIED", message } });

function clampMin(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : PHONE_LINK_DEFAULT_MIN;
  return Math.min(HANDOFF_TIMEOUT_MIN_MAX, Math.max(1, n));
}

/** HTTP status for an approval result. */
export function approveStatus(r: { ok: boolean; outcome?: ApproveOutcome }): number {
  if (r.ok) return 200;
  switch (r.outcome) {
    case "already_answered":
      return 409;
    case "expired":
      return 410;
    case "not_found":
      return 404;
    case "not_offered":
    case "bad_request":
      return 400;
    case "disabled":
    case "presence_failed":
      return 403;
    case "presence_unavailable":
      return 501;
    case "busy":
      return 429;
    case "no_extension":
      return 503;
    default:
      return 500;
  }
}
