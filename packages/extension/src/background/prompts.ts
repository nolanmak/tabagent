// Prompt queue (D15, D19): FIFO, identical pending requests share one prompt,
// 120s timeout, late answers are ignored. Pure: timers are injected.
import type { Answer, Level, SensitiveCategory } from "./policy";

export type PromptKind = "site" | "sensitive" | "attach";
export type PromptOutcome = Answer | "timeout" | "killed";

export const PROMPT_TIMEOUT_MS = 120_000;

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

export type PromptRequest = Omit<PromptInfo, "promptId" | "id" | "label" | "created" | "expires">;

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
  private listeners = new Set<(ev: { type: "added" | "removed"; info: PromptInfo; outcome?: PromptOutcome }) => void>();

  constructor(
    private t: Timers,
    private timeoutMs = PROMPT_TIMEOUT_MS,
  ) {}

  on(fn: (ev: { type: "added" | "removed"; info: PromptInfo; outcome?: PromptOutcome }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: "added" | "removed", info: PromptInfo, outcome?: PromptOutcome) {
    for (const l of this.listeners) l({ type, info, outcome });
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

  /** Returns false for unknown / already-settled prompts (late answers do nothing). */
  answer(id: string, answer: Answer): boolean {
    return this.settle(id, answer);
  }

  private settle(id: string, outcome: PromptOutcome): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.t.clearTimeout(p.timer);
    for (const w of p.waiters) w(outcome);
    this.emit("removed", p.info, outcome);
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
