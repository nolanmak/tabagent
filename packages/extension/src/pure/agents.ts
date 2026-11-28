// Send to agent P1c (docs/specs/agent-inbox.md §7, AD6, AD7, AD13): the side panel's Agents section,
// composer and send feed as plain data in, plain data or escaped HTML out. sidepanel.ts wires it to the DOM.
import { agentSendOverLimit, type Agent, type AgentDeliveryState, type AgentRoute, type AgentSendCode, type AgentSources, type AgentVendor } from "@tabagent/protocol";
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

/** Why a `none` agent cannot be sent to; matches the bridge's NO_ROUTE detail. */
function noneReason(a: Agent): string {
  return a.status === "error" ? `This agent cannot take messages (${a.statusLabel ?? "error"})` : "No way to deliver to this agent";
}

export interface AgentRowView {
  id: string;
  vendor: AgentVendor;
  vendorLabel: string;
  /** The vendor name, or `cwd basename · age` when it has none (§5). */
  title: string;
  cwd: string;
  cwdBase: string;
  age: string;
  pid?: number;
  /** busy/idle, or the vendor's statusLabel when present. */
  status: string;
  route: AgentRoute;
  routeWords: string;
  sendable: boolean;
  /** §7: "Start new session" for spawn targets. */
  actionLabel: string;
  /** Set when not sendable. */
  reason?: string;
  badges: string[];
}

export function agentRowView(a: Agent, now: number): AgentRowView {
  const cwdBase = cwdBasename(a.cwd);
  const age = formatAge(now - a.startedAt);
  const sendable = a.delivery !== "none";
  const badges: string[] = [];
  if (a.linked) badges.push("linked");
  if (a.canDriveTab) badges.push("can drive tab");
  return {
    id: a.id,
    vendor: a.vendor,
    vendorLabel: VENDOR_LABEL[a.vendor],
    title: a.name?.trim() ? a.name : `${cwdBase} · ${age}`,
    cwd: a.cwd,
    cwdBase,
    age,
    pid: a.pid,
    status: a.statusLabel || a.status,
    route: a.delivery,
    routeWords: ROUTE_WORDS[a.delivery],
    sendable,
    actionLabel: a.delivery === "spawn" ? "Start new session" : "Send",
    reason: sendable ? undefined : noneReason(a),
    badges,
  };
}

/** One clickable row (a listbox option). Every agent-supplied string goes through esc(). */
export function agentRowHtml(v: AgentRowView, selected: boolean): string {
  const meta = [v.cwdBase, v.age, v.pid != null ? `pid ${v.pid}` : null, v.status].filter((x) => x != null).map(esc).join(" · ");
  const badges = v.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("");
  const route = v.sendable ? `<span class="agent-route">${esc(v.routeWords)}</span>` : `<span class="err">${esc(v.reason)}</span>`;
  return `<li class="agent${v.sendable ? "" : " agent-none"}${selected ? " selected" : ""}" role="option" tabindex="0" aria-selected="${selected}" data-agent-id="${esc(v.id)}" title="${esc(v.cwd)}"><span><span class="vendor vendor-${esc(v.vendor)}">${esc(v.vendorLabel)}</span> <b>${esc(v.title)}</b>${badges}<br><span class="muted small">${meta}</span><br><span class="small">${route}</span></span></li>`;
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

/** The tab fields a send shares (AD12). P1 sends title and URL as text; there is no tab grant yet. */
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
}

const FIELD_WORDS = { prompt: "message", title: "tab title", url: "tab URL", selection: "selection" } as const;
const n = (x: number) => x.toLocaleString("en-US");

export function composerState(c: { agent: AgentRowView | null; prompt: string; share: SharedTab | null }): ComposerState {
  if (!c.agent) return { canSend: false, label: "Send", note: "Select an agent above." };
  const label = c.agent.actionLabel;
  if (!c.agent.sendable) return { canSend: false, label, note: c.agent.reason ?? "" };
  // AD13: pre-check; never truncate.
  const over = agentSendOverLimit({ prompt: c.prompt, title: c.share?.title, url: c.share?.url });
  if (over) {
    const tail = over.field === "prompt" ? "" : " Untick Share this tab to send without it.";
    return { canSend: false, label, note: `The ${FIELD_WORDS[over.field]} is ${n(over.length)} characters; the limit is ${n(over.limit)}.${tail}` };
  }
  if (!c.prompt.trim()) return { canSend: false, label, note: "" };
  return { canSend: true, label, note: "" };
}

export function buildAgentSend(c: { requestId: string; agentId: string; prompt: string; share: SharedTab | null }) {
  const base = { type: "ui.agent_send" as const, requestId: c.requestId, agentId: c.agentId, prompt: c.prompt };
  return c.share ? { ...base, includeTab: true, tabId: c.share.tabId, title: c.share.title, url: c.share.url } : { ...base, includeTab: false };
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
}

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
  if (a.msg.detail) upd.detail = a.msg.detail;
  const next = feed.slice();
  next[i] = upd;
  return next;
}

const STATE_CLASS: Record<AgentFeedEntry["state"], string> = { sending: "running", sent: "ok", held: "running", queued: "running", started: "ok", delivered: "ok", expired: "denied", failed: "error" };

export function agentFeedLineHtml(e: AgentFeedEntry): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const state = `${e.state}${e.code ? ` ${e.code}` : ""}`;
  const detail = e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : "";
  return `<li data-request-id="${esc(e.requestId)}"><span class="muted">${esc(t)}</span> <b>${esc(e.agentName)}</b> <span class="muted">· ${esc(ROUTE_WORDS[e.route])} ·</span> <span class="agent-state ${STATE_CLASS[e.state]}">${esc(state)}</span>${detail}</li>`;
}
