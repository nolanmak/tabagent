// Live activity feed for the side panel + UI state broadcasts.

export interface FeedEntry {
  id: number;
  ts: number;
  session: string;
  label: string;
  tool: string;
  summary: string;
  status: "running" | "ok" | "error" | "denied";
  ms?: number;
  error?: string;
  url?: string;
}

const MAX = 200;
const entries: FeedEntry[] = [];
let n = 0;

export function feedStart(e: Omit<FeedEntry, "id" | "ts" | "status">): FeedEntry {
  const entry: FeedEntry = { ...e, id: ++n, ts: Date.now(), status: "running" };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  broadcast({ type: "feed", entry });
  return entry;
}

export function feedEnd(entry: FeedEntry, patch: Partial<FeedEntry>) {
  Object.assign(entry, patch, { ms: Date.now() - entry.ts });
  broadcast({ type: "feed", entry });
}

export function feedAll(): FeedEntry[] {
  return entries.slice();
}

export function broadcast(msg: unknown) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no UI open */
  });
}

export function summarize(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (/pass|secret|token|card|cvv|ssn/i.test(k)) s = "•••";
    if (k === "fields" && v && typeof v === "object") s = Object.keys(v).join(", ");
    if (s.length > 60) s = s.slice(0, 57) + "…";
    parts.push(`${k}=${s}`);
  }
  return parts.join(" ");
}
