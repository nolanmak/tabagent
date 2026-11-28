// The chat page (#151, spec §7a): transcript entries, sends in flight and the agent's state as plain data
// in, plain data or escaped HTML out. ui/chat.ts wires it to the DOM and the worker.
import type { Agent, AgentDeliveryState, AgentEntry, AgentHistoryCode, AgentRoute } from "@tabagent/protocol";
import { agentRowView, connectionState, groupAgents, vendorShown, remoteUrl, type AgentRowView, type ConnectionState } from "./agents";
import { esc } from "./html";
import { icon, toolIcon } from "./icons";
import { renderMarkdown } from "./markdown";

/** Entries kept in memory; older ones are dropped (and can be loaded again). */
export const CHAT_MAX_ENTRIES = 5_000;

/** A message sent from this page, shown at once and removed when the transcript shows it (confirmed). */
export interface PendingSend {
  requestId: string;
  text: string;
  ts: number;
  state: AgentDeliveryState | "sending";
  route?: AgentRoute;
  code?: string;
  detail?: string;
  /** A new session started from this page: the message went there, not to this transcript. */
  spawn?: boolean;
}

export interface ChatState {
  /** Oldest first; uuids are unique. */
  entries: AgentEntry[];
  hasMore: boolean;
  before?: string;
  pending: PendingSend[];
  loading: boolean;
  loadingOlder: boolean;
  /** Why history could not be loaded. */
  error?: { code?: AgentHistoryCode | string; detail: string };
}

export const initialChat = (): ChatState => ({ entries: [], hasMore: false, pending: [], loading: true, loadingOlder: false });

export type ChatAction =
  | { type: "loading" }
  | { type: "loadingOlder" }
  | { type: "history"; entries: AgentEntry[]; hasMore: boolean; before?: string; older?: boolean }
  | { type: "historyError"; code?: string; detail: string; older?: boolean }
  | { type: "entries"; entries: AgentEntry[] }
  | { type: "sending"; requestId: string; text: string; ts: number; spawn?: boolean }
  | { type: "sent"; msg: { requestId: string; route: AgentRoute; state: AgentDeliveryState; code?: string; detail?: string } }
  | { type: "status"; msg: { requestId: string; state: AgentDeliveryState; detail?: string } }
  | { type: "dismiss"; requestId: string };

/** Whitespace-insensitive match between what was sent and what the transcript recorded. */
const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Remove one pending send per fromTabAgent entry that matches its text (oldest first). */
function confirm(pending: PendingSend[], entries: AgentEntry[]): PendingSend[] {
  let out = pending;
  for (const e of entries) {
    if (e.role !== "user" || !e.fromTabAgent) continue;
    const t = norm(e.text);
    const i = out.findIndex((p) => !p.spawn && p.state !== "failed" && norm(p.text) === t);
    if (i >= 0) out = [...out.slice(0, i), ...out.slice(i + 1)];
  }
  return out;
}

function merge(cur: AgentEntry[], add: AgentEntry[], where: "before" | "after"): AgentEntry[] {
  const seen = new Set(cur.map((e) => e.uuid));
  const fresh = add.filter((e) => !seen.has(e.uuid) && (seen.add(e.uuid), true));
  if (!fresh.length) return cur;
  const next = where === "before" ? [...fresh, ...cur] : [...cur, ...fresh];
  return next.length > CHAT_MAX_ENTRIES ? (where === "before" ? next.slice(0, CHAT_MAX_ENTRIES) : next.slice(next.length - CHAT_MAX_ENTRIES)) : next;
}

/** Immediate states rank below final ones, so a late agent.sent never undoes an agent.status. */
const RANK: Record<PendingSend["state"], number> = { sending: 0, sent: 1, held: 1, queued: 1, started: 1, delivered: 2, expired: 2, failed: 2 };

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "loading":
      return { ...s, loading: true, error: undefined };
    case "loadingOlder":
      return { ...s, loadingOlder: true };
    case "history": {
      if (a.older) return { ...s, loadingOlder: false, entries: merge(s.entries, a.entries, "before"), hasMore: a.hasMore, before: a.before };
      // The newest page replaces what was shown (first load, or a reload after a reset).
      return { ...s, loading: false, error: undefined, entries: merge([], a.entries, "after"), hasMore: a.hasMore, before: a.before, pending: confirm(s.pending, a.entries) };
    }
    case "historyError":
      if (a.older) return { ...s, loadingOlder: false };
      return { ...s, loading: false, error: { code: a.code, detail: a.detail } };
    case "entries": {
      const entries = merge(s.entries, a.entries, "after");
      const pending = confirm(s.pending, a.entries);
      return entries === s.entries && pending === s.pending ? s : { ...s, entries, pending };
    }
    case "sending":
      if (s.pending.some((p) => p.requestId === a.requestId)) return s;
      return { ...s, pending: [...s.pending, { requestId: a.requestId, text: a.text, ts: a.ts, state: "sending", ...(a.spawn ? { spawn: true } : {}) }] };
    case "sent":
    case "status": {
      const i = s.pending.findIndex((p) => p.requestId === a.msg.requestId);
      if (i < 0) return s;
      const cur = s.pending[i];
      const upd: PendingSend = { ...cur };
      if (a.type === "sent") {
        upd.route = a.msg.route;
        if (a.msg.code) upd.code = a.msg.code;
      }
      if (RANK[a.msg.state] >= RANK[cur.state]) upd.state = a.msg.state;
      if (a.msg.detail) upd.detail = a.msg.detail;
      const pending = s.pending.slice();
      pending[i] = upd;
      return { ...s, pending };
    }
    case "dismiss":
      return { ...s, pending: s.pending.filter((p) => p.requestId !== a.requestId) };
  }
}

// ---------------------------------------------------------------------------
// Items: entries as the chat shows them (tool results folded into their call)
// ---------------------------------------------------------------------------

export type ChatItem =
  | { kind: "msg"; key: string; role: "user" | "assistant"; text: string; ts: number; fromTabAgent?: boolean }
  | { kind: "tool"; key: string; name: string; summary: string; ts: number; result?: { summary: string; error?: boolean } };

export function chatItems(entries: AgentEntry[]): ChatItem[] {
  const out: ChatItem[] = [];
  const calls = new Map<string, number>();
  for (const e of entries) {
    if (e.role === "tool" && e.tool) {
      const t = e.tool;
      if (t.result) {
        const at = t.id ? calls.get(t.id) : undefined;
        if (at !== undefined) {
          const call = out[at] as Extract<ChatItem, { kind: "tool" }>;
          out[at] = { ...call, result: { summary: t.summary, ...(t.error ? { error: true } : {}) } };
          continue;
        }
        // A result whose call is on an older page: its own chip.
        out.push({ kind: "tool", key: e.uuid, name: "Result", summary: "", ts: e.ts, result: { summary: t.summary, ...(t.error ? { error: true } : {}) } });
        continue;
      }
      if (t.id) calls.set(t.id, out.length);
      out.push({ kind: "tool", key: e.uuid, name: t.name, summary: t.summary, ts: e.ts });
      continue;
    }
    if ((e.role === "user" || e.role === "assistant") && e.text) out.push({ kind: "msg", key: e.uuid, role: e.role, text: e.text, ts: e.ts, ...(e.fromTabAgent ? { fromTabAgent: true } : {}) });
  }
  return out;
}

function time(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** One line for a chip: "Bash: npm test". */
export function toolLine(item: Extract<ChatItem, { kind: "tool" }>): string {
  const sum = firstLine(item.summary);
  return sum ? `${item.name}: ${sum}` : item.name;
}

/** #156: the chip's line as markup: the tool name, then its first argument line in mono ("Bash: npm test"). */
function toolLineHtml(item: Extract<ChatItem, { kind: "tool" }>): string {
  const sum = firstLine(item.summary);
  return sum ? `<span class="tool-name">${esc(item.name)}:</span> <span class="tool-arg">${esc(sum)}</span>` : `<span class="tool-name">${esc(item.name)}</span>`;
}

/** One message bubble or tool chip. `open`: the chip was expanded by the user (kept across re-renders). */
export function chatItemHtml(item: ChatItem, open = false): string {
  if (item.kind === "msg") {
    const who = item.role === "user" ? "You" : "Claude";
    const via = item.fromTabAgent ? ` <span class="via">via TabAgent</span>` : "";
    const t = time(item.ts);
    return `<div class="msg msg-${item.role}" data-key="${esc(item.key)}"><div class="bubble md">${renderMarkdown(item.text)}</div><div class="msg-meta"><span>${who}</span>${via}${t ? ` <span>· ${esc(t)}</span>` : ""}</div></div>`;
  }
  const err = item.result?.error ? ` <span class="tool-err">error</span>` : "";
  const hasBody = !!(item.summary.trim() || item.result?.summary.trim());
  const body = hasBody
    ? `${item.summary.trim() ? `<pre class="tool-pre">${esc(item.summary)}</pre>` : ""}${item.result?.summary.trim() ? `<div class="tool-label">Result</div><pre class="tool-pre">${esc(item.result.summary)}</pre>` : ""}`
    : `<div class="tool-label">No details</div>`;
  return `<details class="tool-chip${item.result?.error ? " tool-chip-err" : ""}" data-key="${esc(item.key)}"${open ? " open" : ""}><summary><span class="tool-icon" aria-hidden="true">${icon(toolIcon(item.name))}</span><span class="tool-text" title="${esc(toolLine(item))}">${toolLineHtml(item)}</span>${err}</summary><div class="tool-body">${body}</div></details>`;
}

const PENDING_WORDS: Record<PendingSend["state"], string> = {
  sending: "Sending…",
  sent: "Sent · waiting for the agent",
  held: "Waiting for its next browser action",
  queued: "Queued",
  started: "Started a new session",
  delivered: "Delivered",
  expired: "Expired: not picked up",
  failed: "Not sent",
};

export function pendingHtml(p: PendingSend): string {
  const failed = p.state === "failed" || p.state === "expired";
  const label = `${PENDING_WORDS[p.state]}${p.code && failed ? ` (${p.code})` : ""}`;
  const detail = p.detail ? `<div class="pending-detail">${esc(p.detail)}</div>` : "";
  const actions = failed ? ` <button type="button" class="link" data-edit="${esc(p.requestId)}">Edit and resend</button> <button type="button" class="link" data-dismiss="${esc(p.requestId)}">Dismiss</button>` : "";
  const spinner = !failed && p.state !== "delivered" && p.state !== "started" ? `<span class="spinner" aria-hidden="true"></span>` : "";
  return `<div class="msg msg-user pending${failed ? " pending-failed" : ""}" data-request-id="${esc(p.requestId)}"><div class="bubble md">${renderMarkdown(p.text)}</div><div class="msg-meta">${spinner}<span class="pending-state">${esc(label)}</span>${p.spawn ? ` <span class="via">new session</span>` : ""}${actions}${detail}</div></div>`;
}

// ---------------------------------------------------------------------------
// Header, composer mode and the not-connected card
// ---------------------------------------------------------------------------

export interface ChatHeaderView {
  title: string;
  folder: string;
  vendorLabel: string;
  busy: boolean;
  statusText: string;
  connection: ConnectionState;
  remoteControlUrl: string | null;
}

export function chatHeaderView(a: Agent, now: number): ChatHeaderView {
  const v = agentRowView(a, now);
  const busy = a.status === "busy";
  const statusText = busy ? "Working…" : a.status === "error" ? `Error${a.statusLabel ? `: ${a.statusLabel}` : ""}` : a.statusLabel && a.statusLabel !== "idle" ? a.statusLabel : "Idle";
  return { title: v.title, folder: a.cwd, vendorLabel: v.vendorLabel, busy, statusText, connection: connectionState(a), remoteControlUrl: remoteUrl(a) };
}

/**
 * What sits at the bottom of the page. `send`: the composer (linked Claude, Codex queue). `card`: the
 * session is not connected to TabAgent (Open in Claude when it has Remote Control). `spawn`: the user chose
 * "Start a new session" from the card. `gone`: the agent stopped. `none`: it cannot take messages.
 */
export type ComposerMode = "loading" | "send" | "card" | "spawn" | "gone" | "none";

export function composerMode(a: Agent | null, o: { loaded: boolean; spawnChosen: boolean }): ComposerMode {
  if (!a) return o.loaded ? "gone" : "loading";
  const v = agentRowView(a, Date.now());
  if (v.notConnected) return o.spawnChosen && v.spawnLabel ? "spawn" : "card";
  return v.sendable ? "send" : "none";
}

/** The not-connected card (#151). Remote Control is the primary action when the session has it. */
export function notConnectedCardHtml(a: Agent): string {
  const v = agentRowView(a, Date.now());
  const rc = remoteUrl(a);
  const spawn = v.spawnLabel ? `<button type="button" class="secondary" data-spawn-start>${esc(v.spawnLabel)}</button>` : "";
  const connect = `<details class="card-more"><summary>Connect it to TabAgent instead</summary><ol><li>Run <code>tabagent setup claude</code> (or <code>npx -y @nolmak/tabagent@latest setup claude</code>).</li><li>Restart this session (<code>claude --resume</code> keeps the conversation).</li><li>For instant delivery, start it with <code>--dangerously-load-development-channels server:tabagent</code>.</li></ol></details>`;
  if (rc)
    return `<div class="nc-card"><p class="nc-title">This session isn't connected to TabAgent.</p><p class="muted"><b>Open in Claude</b> to talk to it now (Remote Control): the full conversation, live, in your browser.</p><div class="nc-actions"><a class="btn primary" data-rc href="${esc(rc)}" target="_blank" rel="noopener noreferrer">Open in Claude ↗</a>${spawn}</div>${connect}</div>`;
  return `<div class="nc-card"><p class="nc-title">This session isn't connected to TabAgent.</p><p class="muted">Start the session with <code>--remote-control</code> to open it in Claude, or connect TabAgent.</p><div class="nc-actions">${spawn}</div>${connect}</div>`;
}

/** Why history is not shown, as the page says it. */
export function historyErrorText(e: { code?: string; detail: string }): string {
  if (e.code === "UNSUPPORTED") return "History isn't available for Codex yet. Messages you send are still queued on the thread.";
  if (e.code === "NO_TRANSCRIPT") return "No conversation found for this session yet.";
  if (e.code === "AGENT_GONE") return "This session is no longer running.";
  return `Couldn't load the conversation: ${e.detail}`;
}

/** The pill to show instead of jumping: the user scrolled up and something new arrived. */
export function atBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** The most recently used normal web tab other than this page: what "Share a tab" offers first. */
export function recentWebTabs<T extends { id?: number; url?: string; title?: string; lastAccessed?: number }>(tabs: T[]): T[] {
  return tabs.filter((t) => typeof t.id === "number" && /^https?:\/\//i.test(t.url ?? "")).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

/**
 * #156: the chat page's left rail. Every running session (same order as the side panel), the current one marked.
 * Each row links to that session's chat page, so switching stays in this tab.
 */
export function chatRailHtml(views: AgentRowView[], currentId: string): string {
  const { main, other } = groupAgents(views);
  const rows = [...main, ...other].map((v) => {
    const cur = v.id === currentId;
    const meta = [...(vendorShown(v) ? [v.vendorLabel] : []), v.connection.label, v.age].map(esc).join(" · ");
    return `<li><a href="chat.html?agent=${encodeURIComponent(v.id)}" data-rail-agent="${esc(v.id)}"${cur ? ' aria-current="page"' : ""} title="${esc(v.cwd)}"><span class="status-dot tone-${v.connection.tone}${v.busy ? " busy-dot" : ""}" aria-hidden="true"></span><span class="rail-text"><span class="rail-title">${esc(v.title)}</span><span class="rail-meta">${meta}</span></span></a></li>`;
  });
  return rows.join("") || `<li class="rail-empty">No sessions running.</li>`;
}
