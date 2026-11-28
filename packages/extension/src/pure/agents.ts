// Send to agent P1c (docs/specs/agent-inbox.md §7, AD6, AD7, AD13): the side panel's Agents section,
// composer and send feed as plain data in, plain data or escaped HTML out. sidepanel.ts wires it to the DOM.
import { agentSendOverLimit, isRemoteControlUrl, type Agent, type AgentDeliveryState, type AgentRoute, type AgentSendCode, type AgentSources, type AgentVendor } from "@tabagent/protocol";
import { esc } from "./html";

/** §5: the panel asks when it opens and every 5 s while visible. */
export const AGENTS_REFRESH_MS = 5_000;

/** §7: the route as words. */
export const ROUTE_WORDS: Record<AgentRoute, string> = {
  channel: "instant",
  piggyback: "on its next browser action",
  queue: "queued (Codex)",
  spawn: "starts a new session",
  none: "cannot take messages",
};

const VENDOR_LABEL: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

export function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return cwd ? cwd.slice(0, 1) : "";
  return trimmed.split(/[\\/]/).pop()!;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** #137: the docs section that explains how to connect a session so it can be messaged. */
export const CONNECT_DOCS_URL = "https://github.com/nolanmak/tabagent/blob/main/docs/send-to-agent.md#connect-a-session";
export const NOT_CONNECTED = "Not connected";
export const CONNECT_HINT = "How to connect";
/** #152: what connecting takes, as the link's tooltip. */
export const CONNECT_STEPS = "Run tabagent setup claude, then restart this session";

/** #151: how this session can be reached, in the same words on the panel row and the chat page. */
export type ConnectionTone = "instant" | "next" | "queue" | "remote" | "off" | "error";
export interface ConnectionState {
  label: string;
  tone: ConnectionTone;
}

/** The Remote Control link, only when it is one the bridge could have made (claude.ai/code/session_…). */
export function remoteUrl(a: Pick<Agent, "remoteControlUrl">): string | null {
  return isRemoteControlUrl(a.remoteControlUrl) ? a.remoteControlUrl : null;
}

export function connectionState(a: Agent): ConnectionState {
  if (a.linked && a.delivery === "channel") return { label: "Connected · instant", tone: "instant" };
  if (a.linked && a.delivery === "piggyback") return { label: "Connected · on next browser action", tone: "next" };
  if (a.vendor === "codex") return a.delivery === "queue" ? { label: "Codex · queued", tone: "queue" } : { label: a.status === "error" ? `Can't take messages (${a.statusLabel ?? "error"})` : "Can't take messages", tone: "error" };
  if (remoteUrl(a)) return { label: "Remote Control only", tone: "remote" };
  return { label: NOT_CONNECTED, tone: "off" };
}

/** Why a `none` agent cannot be sent to; matches the bridge's NO_ROUTE detail. */
function noneReason(a: Agent): string {
  return a.status === "error" ? `This agent cannot take messages (${a.statusLabel ?? "error"})` : "No way to deliver to this agent";
}

export interface AgentRowView {
  id: string;
  vendor: AgentVendor;
  vendorLabel: string;
  /** Primary label (#137): the session title, else the vendor name, else `cwd basename · age` (§5). */
  title: string;
  /** A real title (a rename or a generated one), not just the vendor's auto name. */
  titled: boolean;
  cwd: string;
  cwdBase: string;
  age: string;
  startedAt: number;
  pid?: number;
  /** busy/idle, or the vendor's statusLabel when present. */
  status: string;
  route: AgentRoute;
  routeWords: string;
  linked: boolean;
  sendable: boolean;
  /** #137: an unlinked Claude session. It cannot be messaged; only an explicit new session is offered. */
  notConnected: boolean;
  /** The primary button's label. Always "Send": a spawn is never the primary action (#137). */
  actionLabel: string;
  /** #137: label of the separate "Start a new session in <folder>" button (Claude with a cwd), else unset. */
  spawnLabel?: string;
  /** Set when not sendable. */
  reason?: string;
  badges: string[];
  /** Glossary canDriveTab: a Send with the tab grants it to this agent (AD11). */
  canDriveTab: boolean;
  /** #151: the row's connection words ("Connected · instant", "Remote Control only", …). */
  connection: ConnectionState;
  /** #151: Claude's Remote Control page for this session, when it has one. */
  remoteControlUrl: string | null;
  busy: boolean;
}

export function agentRowView(a: Agent, now: number): AgentRowView {
  const cwdBase = cwdBasename(a.cwd);
  const age = formatAge(now - a.startedAt);
  // An older bridge still lists unlinked Claude as `spawn`; treat it the same, so Send never spawns.
  const notConnected = a.vendor === "claude" && !a.linked && (a.delivery === "none" || a.delivery === "spawn");
  const sendable = !notConnected && a.delivery !== "none" && a.delivery !== "spawn";
  const badges: string[] = [];
  if (a.linked) badges.push("linked");
  if (a.canDriveTab) badges.push("can drive tab");
  const title = a.title?.trim() || a.name?.trim() || `${cwdBase} · ${age}`;
  const reason = notConnected ? NOT_CONNECTED : sendable ? undefined : noneReason(a);
  return {
    id: a.id,
    vendor: a.vendor,
    vendorLabel: VENDOR_LABEL[a.vendor],
    title,
    titled: !!a.title?.trim() && a.title.trim() !== a.name?.trim(),
    cwd: a.cwd,
    cwdBase,
    age,
    startedAt: a.startedAt,
    pid: a.pid,
    status: a.statusLabel || a.status,
    route: a.delivery,
    routeWords: notConnected ? NOT_CONNECTED : ROUTE_WORDS[a.delivery],
    linked: a.linked,
    sendable,
    notConnected,
    actionLabel: "Send",
    spawnLabel: a.vendor === "claude" && a.cwd ? `Start a new session in ${cwdBase}${a.linked ? " instead" : ""}` : undefined,
    reason,
    badges,
    canDriveTab: a.canDriveTab,
    connection: connectionState(a),
    remoteControlUrl: remoteUrl(a),
    busy: a.status === "busy",
  };
}

/** §7: the Share label says what the agent gets. Only canDriveTab targets get the tab itself (AD11). */
export function shareTabLabel(v: AgentRowView | null): string {
  return v?.canDriveTab && (v.route === "piggyback" || v.route === "channel") ? "Share this tab (agent can use it)" : "Share this tab's title and link";
}

/** The chat page for an agent (#151). The id is the only parameter; the page asks the worker for the rest. */
export function chatPageUrl(base: string, agentId: string): string {
  return `${base}chat.html?agent=${encodeURIComponent(agentId)}`;
}

/**
 * One row (a listbox option). Clicking it opens the agent's chat page (#151); "Quick send" opens the
 * composer right under the row; "Open in Claude" is the Remote Control page. Every agent string goes
 * through esc(). `selected`: the Quick send composer is open under this row.
 */
export function agentRowHtml(v: AgentRowView, selected: boolean): string {
  const meta = [v.cwdBase, v.age, v.pid != null ? `pid ${v.pid}` : null, v.status].filter((x) => x != null).map(esc).join(" · ");
  const badges = v.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("");
  const conn = `<span class="conn conn-${v.connection.tone}">${esc(v.connection.label)}</span>`;
  const hint = v.notConnected ? ` <a class="connect-hint" href="${esc(CONNECT_DOCS_URL)}" target="_blank" rel="noopener noreferrer" title="${esc(CONNECT_STEPS)}">${esc(CONNECT_HINT)}</a>` : "";
  const rc = v.remoteControlUrl ? `<a class="rc-link" href="${esc(v.remoteControlUrl)}" target="_blank" rel="noopener noreferrer" title="Open this session in Claude (Remote Control)">Open in Claude ↗</a>` : "";
  const quick = v.sendable ? `<button type="button" class="quick-btn" data-quick-send="${esc(v.id)}" aria-expanded="${selected}">${selected ? "Close" : "Quick send"}</button>` : "";
  const busy = v.busy ? `<span class="busy-dot" title="Working" aria-label="Working"></span>` : "";
  const label = `${v.title} — open chat`;
  return `<li class="agent${v.sendable ? "" : " agent-none"}${selected ? " selected" : ""}" role="option" tabindex="0" aria-selected="${selected}" aria-label="${esc(label)}" data-agent-id="${esc(v.id)}" title="${esc(v.cwd)}"><span class="agent-main"><span class="agent-line"><span class="vendor vendor-${esc(v.vendor)}">${esc(v.vendorLabel)}</span> <b class="agent-title">${esc(v.title)}</b>${busy}${badges}</span><span class="muted small agent-meta">${meta}</span><span class="small agent-conn">${conn}${hint}</span></span><span class="agent-actions">${rc}${quick}<span class="chev" aria-hidden="true">›</span></span></li>`;
}

/**
 * #137: linked agents first, then the most recently started. Sessions that cannot be messaged and have no
 * real title go in `other`, shown collapsed, so the list stays short.
 */
export function groupAgents(views: AgentRowView[]): { main: AgentRowView[]; other: AgentRowView[] } {
  const sorted = views.slice().sort((a, b) => Number(b.linked) - Number(a.linked) || b.startedAt - a.startedAt);
  // A Remote Control session can be opened in Claude, so it stays in the main list.
  const collapsed = (v: AgentRowView) => v.notConnected && !v.titled && !v.remoteControlUrl;
  return { main: sorted.filter((v) => !collapsed(v)), other: sorted.filter(collapsed) };
}

/** The list's rows; collapsed sessions sit under an "N other sessions" disclosure, open when asked or selected. */
export function agentListHtml(views: AgentRowView[], selectedId: string | null, otherOpen: boolean): string {
  const { main, other } = groupAgents(views);
  const rows = main.map((v) => agentRowHtml(v, v.id === selectedId)).join("");
  if (!other.length) return rows;
  const open = otherOpen || other.some((v) => v.id === selectedId);
  const label = `${other.length} other session${other.length === 1 ? "" : "s"}`;
  return `${rows}<li class="agents-other"><details${open ? " open" : ""}><summary>${label}</summary><ul class="list agents" role="group">${other.map((v) => agentRowHtml(v, v.id === selectedId)).join("")}</ul></details></li>`;
}

/** A source that could not be read is a muted note, never an error (§5). */
export function sourcesNotes(sources: AgentSources | undefined): string[] {
  if (!sources) return [];
  const out: string[] = [];
  if (sources.claude === "unavailable") out.push("Claude Code: not available");
  if (sources.codex === "unavailable") out.push("Codex: not running");
  return out;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** The tab fields a send shares (AD12). A canDriveTab target is also granted the tab itself (AD11). */
export interface SharedTab {
  tabId: number;
  title: string;
  url: string;
}

/** Only normal web pages are shared; extension and browser pages are not. */
export function shareableTab(tab: { id?: number; title?: string; url?: string } | undefined): SharedTab | null {
  if (!tab || typeof tab.id !== "number" || !/^https?:\/\//i.test(tab.url ?? "")) return null;
  return { tabId: tab.id, title: tab.title ?? "", url: tab.url! };
}

export interface ComposerState {
  canSend: boolean;
  label: string;
  /** Why Send is disabled, or "". */
  note: string;
  /** #137: label of the separate Start a new session button, or null when it is hidden. */
  spawnLabel: string | null;
  canSpawn: boolean;
}

const FIELD_WORDS = { prompt: "message", title: "tab title", url: "tab URL", selection: "selection" } as const;
const n = (x: number) => x.toLocaleString("en-US");

/** `selection` is the selection that would be sent (only with a shared tab), or null. */
export function composerState(c: { agent: AgentRowView | null; prompt: string; share: SharedTab | null; selection?: string | null }): ComposerState {
  if (!c.agent) return { canSend: false, label: "Send", note: "Select an agent above.", spawnLabel: null, canSpawn: false };
  const v = c.agent;
  const spawnLabel = v.spawnLabel ?? null;
  // AD13: pre-check; never truncate. The limits apply to a new session too.
  const over = agentSendOverLimit({ prompt: c.prompt, title: c.share?.title, url: c.share?.url, selection: c.share ? (c.selection ?? undefined) : undefined });
  const ready = !over && !!c.prompt.trim();
  let note = "";
  if (over) {
    const tail = over.field === "prompt" ? "" : over.field === "selection" ? " Untick Include selection to send without it." : " Untick Share this tab to send without it.";
    note = `The ${FIELD_WORDS[over.field]} is ${n(over.length)} characters; the limit is ${n(over.limit)}.${tail}`;
  } else if (v.notConnected) {
    note = `This session is not connected to TabAgent, so it can't get messages.${spawnLabel ? ` You can start a new session in ${v.cwdBase} instead.` : ""}`;
  } else if (!v.sendable) note = v.reason ?? "";
  return { canSend: v.sendable && ready, label: v.actionLabel, note, spawnLabel, canSpawn: !!spawnLabel && ready };
}

/** The feed line's name and route for a send. A new session is named by its folder, not the agent (#137). */
export function sendTarget(v: AgentRowView, forceSpawn: boolean): { agentName: string; route: AgentRoute } {
  return forceSpawn ? { agentName: `New session in ${v.cwdBase}`, route: "spawn" } : { agentName: v.title, route: v.route };
}

/**
 * The selection rides with the tab (AD12): the bridge composes it into the page paragraph, never alone.
 * `forceSpawn` only from the explicit Start a new session button (#137); it is omitted otherwise.
 */
export function buildAgentSend(c: { requestId: string; agentId: string; prompt: string; share: SharedTab | null; selection?: string | null; forceSpawn?: boolean }) {
  const base = { type: "ui.agent_send" as const, requestId: c.requestId, agentId: c.agentId, prompt: c.prompt, ...(c.forceSpawn ? { forceSpawn: true as const } : {}) };
  if (!c.share) return { ...base, includeTab: false };
  const tab = { ...base, includeTab: true, tabId: c.share.tabId, title: c.share.title, url: c.share.url };
  return c.selection ? { ...tab, selection: c.selection } : tab;
}

// ---------------------------------------------------------------------------
// Send feed (AD7): one line per requestId
// ---------------------------------------------------------------------------

export const AGENT_FEED_MAX = 50;

export interface AgentFeedEntry {
  requestId: string;
  ts: number;
  agentName: string;
  vendor: AgentVendor;
  /** The route the agent was listed with, then the route the bridge used (agent.sent). */
  route: AgentRoute;
  state: AgentDeliveryState | "sending";
  code?: AgentSendCode | string;
  detail?: string;
  /** AD11: "tab not shared: <code>" when the tab grant was refused or timed out. */
  tabNote?: string;
}

/** The prefix of the bridge's agent.sent detail for a refused tab grant (AD11). */
export const TAB_NOTE = "tab not shared: ";

export type AgentFeedAction =
  | { type: "sending"; requestId: string; ts: number; agentName: string; vendor: AgentVendor; route: AgentRoute }
  | { type: "sent"; msg: { requestId: string; route: AgentRoute; state: AgentDeliveryState; code?: string; detail?: string } }
  | { type: "status"; msg: { requestId: string; state: AgentDeliveryState; detail?: string } };

/** Immediate states rank below final ones, so a late agent.sent never undoes an agent.status. */
const RANK: Record<AgentFeedEntry["state"], number> = { sending: 0, sent: 1, held: 1, queued: 1, started: 1, delivered: 2, expired: 2, failed: 2 };

export function agentFeedReducer(feed: AgentFeedEntry[], a: AgentFeedAction): AgentFeedEntry[] {
  if (a.type === "sending") {
    if (feed.some((e) => e.requestId === a.requestId)) return feed;
    const next = [...feed, { requestId: a.requestId, ts: a.ts, agentName: a.agentName, vendor: a.vendor, route: a.route, state: "sending" as const }];
    return next.length > AGENT_FEED_MAX ? next.slice(next.length - AGENT_FEED_MAX) : next;
  }
  const i = feed.findIndex((e) => e.requestId === a.msg.requestId);
  // Broadcasts reach every panel; a requestId this panel never sent is not ours.
  if (i < 0) return feed;
  const cur = feed[i];
  const upd: AgentFeedEntry = { ...cur };
  if (a.type === "sent") {
    upd.route = a.msg.route;
    if (a.msg.code) upd.code = a.msg.code;
  }
  if (RANK[a.msg.state] >= RANK[cur.state]) upd.state = a.msg.state;
  // AD11: the grant result stays on the line even when a later state brings its own detail.
  if (a.type === "sent" && a.msg.detail?.startsWith(TAB_NOTE)) upd.tabNote = a.msg.detail;
  else if (a.msg.detail) upd.detail = a.msg.detail;
  const next = feed.slice();
  next[i] = upd;
  return next;
}

const STATE_CLASS: Record<AgentFeedEntry["state"], string> = { sending: "running", sent: "ok", held: "running", queued: "running", started: "ok", delivered: "ok", expired: "denied", failed: "error" };

export function agentFeedLineHtml(e: AgentFeedEntry): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const state = `${e.state}${e.code ? ` ${e.code}` : ""}`;
  const detail = [e.tabNote, e.detail]
    .filter(Boolean)
    .map((d) => `<br><span class="muted">${esc(d!)}</span>`)
    .join("");
  return `<li data-request-id="${esc(e.requestId)}"><span class="muted">${esc(t)}</span> <b>${esc(e.agentName)}</b> <span class="muted">· ${esc(ROUTE_WORDS[e.route])} ·</span> <span class="agent-state ${STATE_CLASS[e.state]}">${esc(state)}</span>${detail}</li>`;
}
