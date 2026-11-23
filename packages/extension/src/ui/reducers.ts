// Pure reducers for the side panel. The panel is a view over worker state.
export const FEED_MAX = 200;

export interface FeedEntry {
  id: number;
  ts: number;
  sessionId: string;
  label: string;
  tool: string;
  action?: string;
  origin: string | null;
  /** Redacted params (from the audit record). */
  params: unknown;
  status: "running" | "ok" | "error" | "denied";
  errorCode?: string;
  ms?: number;
  resultSummary?: { bytes: number; sha256: string };
}

/** Insert or replace by id; cap at FEED_MAX (oldest dropped). */
export function feedReducer(feed: FeedEntry[], entry: FeedEntry): FeedEntry[] {
  const i = feed.findIndex((e) => e.id === entry.id);
  let next: FeedEntry[];
  if (i >= 0) {
    next = feed.slice();
    next[i] = entry;
  } else next = [...feed, entry];
  return next.length > FEED_MAX ? next.slice(next.length - FEED_MAX) : next;
}

export interface PromptView {
  promptId: string;
  [k: string]: unknown;
}

export type PromptAction = { type: "added"; prompt: PromptView } | { type: "removed"; promptId: string } | { type: "replace"; prompts: PromptView[] };

/** FIFO list; removal on answer or timeout. */
export function promptReducer(list: PromptView[], a: PromptAction): PromptView[] {
  switch (a.type) {
    case "added":
      return list.some((p) => p.promptId === a.prompt.promptId) ? list : [...list, a.prompt];
    case "removed":
      return list.filter((p) => p.promptId !== a.promptId);
    case "replace":
      return a.prompts.slice();
  }
}

/** One-line rendering of redacted params for the feed. */
export function summarizeParams(params: unknown, max = 60): string {
  if (!params || typeof params !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    parts.push(`${k}=${s}`);
  }
  return parts.join(" ");
}

export function promptTitle(p: { kind: string; sessionLabel?: string; label?: string; level?: string; origin: string; summary?: string; sensitive?: { category: string }; auth?: { accountMasked: string; provider: string } }): string {
  const who = p.sessionLabel ?? p.label ?? "An agent";
  if (p.sensitive?.category === "g" && p.auth) return `Sign in to ${p.origin} as ${p.auth.accountMasked} with ${p.auth.provider}?`;
  if (p.kind === "site") return `${who} wants ${p.level === "read" ? "to read" : p.level === "act" ? "to act on" : "full access to"} ${p.origin}`;
  return `${who} wants to ${p.summary ?? "do something sensitive"}`;
}
