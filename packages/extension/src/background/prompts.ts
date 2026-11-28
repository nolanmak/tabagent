// Prompt queue (D15, D19): FIFO, identical pending requests share one prompt,
// 120s timeout, late answers are ignored. Pure: timers are injected.
import type { AnswerOutcome, ApprovalChannel } from "@tabagent/protocol";
import type { Answer, Level, SensitiveCategory } from "./policy";
import { offeredAnswers } from "../pure/promptView";

export type PromptKind = "site" | "sensitive" | "attach";
export type PromptOutcome = Answer | "timeout" | "killed";

export const PROMPT_TIMEOUT_MS = 120_000;
/** #108: how long (and how many) settled prompts are remembered, to tell a late answer "already answered". */
const SETTLED_TTL_MS = 10 * 60_000;
const SETTLED_MAX = 200;

export interface AnswerResult {
  ok: boolean;
  outcome: AnswerOutcome;
  /** For already_answered: the channel that won. */
  by?: ApprovalChannel;
}

export const CATEGORY_TEXT: Record<SensitiveCategory, string> = {
  a: "Submit a form with password, card or SSN fields",
  b: "Click that looks like a purchase, delete, send or transfer",
  c: "Run arbitrary JavaScript in the page",
  d: "Read credentials (cookies, web storage, network bodies)",
  e: "Transfer a local file (upload or read a download)",
  f: "Take over a tab you opened",
  g: "Sign in to a site with one of your saved accounts",
  p: "Change TabAgent policy (the denylist, a site's settings, YOLO or developer mode)",
  r: "Accept a proposed workflow repair",
};

export interface PromptInfo {
  promptId: string;
  /** Alias of promptId kept for older UI code. */
  id: string;
  kind: PromptKind;
  sessionId: string;
  sessionLabel: string;
  /** Alias of sessionLabel. */
  label: string;
  origin: string;
  level?: Level;
  sensitive?: { category: SensitiveCategory; description: string };
  /** Category g: which account and provider (masked, never the secret). */
  auth?: { accountId: string; accountMasked: string; provider: string; signup?: boolean };
  tool: string;
  summary: string;
  reasons: string[];
  tabId?: number;
  created: number;
  expires: number;
}

export interface PromptEvent {
  type: "added" | "removed";
  info: PromptInfo;
  outcome?: PromptOutcome;
  /** Set when a person answered (not on timeout, kill or session end). */
  channel?: ApprovalChannel;
}

export type PromptRequest =Omit<PromptInfo, "promptId" | "id" | "label" | "created" | "expires">;

interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  newId(): string;
}

interface Pending {
  info: PromptInfo;
  key: string;
  waiters: ((o: PromptOutcome) => void)[];
  timer: unknown;
}

export function promptKey(r: PromptRequest): string {
  return [r.kind, r.sessionId, r.origin, r.level ?? "", r.sensitive?.category ?? "", r.kind === "site" ? "" : r.summary, r.auth?.accountId ?? ""].join("|");
}

export class PromptQueue {
  private pending = new Map<string, Pending>();
  private listeners = new Set<(ev: PromptEvent) => void>();
  private settled = new Map<string, { outcome: PromptOutcome; channel?: ApprovalChannel; at: number }>();

  constructor(
    private t: Timers,
    private timeoutMs = PROMPT_TIMEOUT_MS,
  ) {}

  on(fn: (ev: PromptEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: "added" | "removed", info: PromptInfo, outcome?: PromptOutcome, channel?: ApprovalChannel) {
    for (const l of this.listeners) l({ type, info, outcome, ...(channel ? { channel } : {}) });
  }

  /** FIFO order (insertion order of a Map). */
  list(): PromptInfo[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  get(id: string): PromptInfo | undefined {
    return this.pending.get(id)?.info;
  }

  get size() {
    return this.pending.size;
  }

  request(r: PromptRequest): { promptId: string; outcome: Promise<PromptOutcome>; shared: boolean } {
    const key = promptKey(r);
    for (const p of this.pending.values()) {
      if (p.key === key) {
        return { promptId: p.info.promptId, shared: true, outcome: new Promise((res) => p.waiters.push(res)) };
      }
    }
    const id = this.t.newId();
    const now = this.t.now();
    const info: PromptInfo = { ...r, promptId: id, id, label: r.sessionLabel, created: now, expires: now + this.timeoutMs };
    const p: Pending = { info, key, waiters: [], timer: null };
    const outcome = new Promise<PromptOutcome>((res) => p.waiters.push(res));
    p.timer = this.t.setTimeout(() => this.settle(id, "timeout"), this.timeoutMs);
    this.pending.set(id, p);
    this.emit("added", info);
    return { promptId: id, outcome, shared: false };
  }

  /** The panel's answer. Returns false for unknown / already-settled / expired prompts (late answers do nothing). */
  answer(id: string, answer: Answer): boolean {
    return this.answerAs(id, answer, "panel").ok;
  }

  /**
   * #108: the one way an answer is applied, from any channel. Synchronous, so the first answer wins:
   * a later one (any channel) gets already_answered. An answer at or after the prompt's expiry never
   * executes, even if the timeout timer has not fired yet; an answer the prompt does not offer is refused.
   */
  answerAs(id: string, answer: Answer, channel: ApprovalChannel): AnswerResult {
    const p = this.pending.get(id);
    if (!p) {
      this.prune();
      const s = this.settled.get(id);
      if (!s) return { ok: false, outcome: "not_found" };
      if (s.outcome === "timeout") return { ok: false, outcome: "expired" };
      return { ok: false, outcome: "already_answered", ...(s.channel ? { by: s.channel } : {}) };
    }
    if (this.t.now() >= p.info.expires) {
      this.settle(id, "timeout");
      return { ok: false, outcome: "expired" };
    }
    if (!offeredAnswers(p.info).includes(answer)) return { ok: false, outcome: "not_offered" };
    this.settle(id, answer, channel);
    return { ok: true, outcome: "applied" };
  }

  /** Settled prompts still remembered (bounded). */
  get settledCount() {
    return this.settled.size;
  }

  private prune() {
    const now = this.t.now();
    for (const [id, s] of this.settled) if (now - s.at > SETTLED_TTL_MS) this.settled.delete(id);
    while (this.settled.size > SETTLED_MAX) this.settled.delete(this.settled.keys().next().value!);
  }

  private settle(id: string, outcome: PromptOutcome, channel?: ApprovalChannel): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.t.clearTimeout(p.timer);
    this.settled.set(id, { outcome, channel, at: this.t.now() });
    this.prune();
    for (const w of p.waiters) w(outcome);
    this.emit("removed", p.info, outcome, channel);
    return true;
  }

  /** Kill switch: drop everything. */
  dropAll(outcome: PromptOutcome = "killed") {
    for (const id of [...this.pending.keys()]) this.settle(id, outcome);
  }

  /** Session ended: its prompts go away. */
  dropSession(sessionId: string) {
    for (const [id, p] of [...this.pending]) if (p.info.sessionId === sessionId) this.settle(id, "deny");
  }
}
