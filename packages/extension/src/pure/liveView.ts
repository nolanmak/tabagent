// #164: which linked agents are working in the browser, and the chat page's live view strip. Plain data in,
// plain data or escaped HTML out. The worker enriches agents (it knows sessions, tabs and running commands);
// ui/chat.ts and ui/sidepanel.ts render; background/screencast.ts streams the frames.
//
// The join: a linked agent's `tabagentSessionId` (from the bridge: its inbox stream's SessionMeta.id) is the
// session id every command from that agent carries, which is the key of the worker's session map (sessions.ts)
// and of the router's feed events. So agent -> session -> tabIds, and agent -> session -> running commands.
import { BROWSER_BUSY_WINDOW_MS, type Agent, type AgentBrowser } from "@tabagent/protocol";
import { esc } from "./html";

// ---------------------------------------------------------------------------
// Activity: running commands and the last finished one, per session (from the router's feed events)
// ---------------------------------------------------------------------------

export interface ActivityState {
  /** Feed ids of commands that started and have not finished, per session. */
  running: Record<string, number[]>;
  /** Epoch ms when the session's last command finished (or was refused). */
  last: Record<string, number>;
}

export const initialActivity: ActivityState = { running: {}, last: {} };

export type ActivityEvent = { sessionId: string; id: number; status: "running" | "ok" | "error" | "denied"; ts: number } | { forget: string };

export function activityReducer(s: ActivityState, e: ActivityEvent): ActivityState {
  if ("forget" in e) {
    const { [e.forget]: _r, ...running } = s.running;
    const { [e.forget]: _l, ...last } = s.last;
    return { running, last };
  }
  const cur = s.running[e.sessionId] ?? [];
  if (e.status === "running") return cur.includes(e.id) ? s : { ...s, running: { ...s.running, [e.sessionId]: [...cur, e.id] } };
  const rest = cur.filter((x) => x !== e.id);
  const { [e.sessionId]: _drop, ...others } = s.running;
  return { running: rest.length ? { ...others, [e.sessionId]: rest } : others, last: { ...s.last, [e.sessionId]: e.ts } };
}

// ---------------------------------------------------------------------------
// agentBrowser: an agent's tabs and busy state
// ---------------------------------------------------------------------------

export interface BrowserContext {
  /** The worker's listSessions(): session id -> owned tabs and the active one. */
  sessions: { id: string; tabIds: number[]; active?: number }[];
  /** Titles and URLs of those tabs (chrome.tabs). */
  tabs: Record<number, { title?: string; url?: string } | undefined>;
  activity: ActivityState;
}

/** Absent unless the agent is linked through a TabAgent session. Never another session's tabs. */
export function agentBrowser(a: Pick<Agent, "linked" | "tabagentSessionId">, ctx: BrowserContext, now: number): AgentBrowser | undefined {
  const sid = a.tabagentSessionId;
  if (!a.linked || !sid) return undefined;
  const s = ctx.sessions.find((x) => x.id === sid);
  const tabs = (s?.tabIds ?? []).map((tabId) => {
    const t = ctx.tabs[tabId];
    const url = t?.url ?? "";
    return { tabId, title: t?.title?.trim() || url || `Tab ${tabId}`, url };
  });
  const lastActionAt = ctx.activity.last[sid];
  const busy = (ctx.activity.running[sid]?.length ?? 0) > 0 || (lastActionAt != null && now - lastActionAt < BROWSER_BUSY_WINDOW_MS);
  const activeTabId = s?.active != null && s.tabIds.includes(s.active) ? s.active : undefined;
  return { tabs, ...(activeTabId != null ? { activeTabId } : {}), busy, ...(lastActionAt != null ? { lastActionAt } : {}) };
}

export function enrichAgents(agents: Agent[], ctx: BrowserContext, now: number): Agent[] {
  return agents.map((a) => {
    const browser = agentBrowser(a, ctx, now);
    return browser ? { ...a, browser } : a;
  });
}

/** The tab the agent is on: its active tab, else the newest. */
export function focusTab(b: AgentBrowser): AgentBrowser["tabs"][number] | undefined {
  return b.tabs.find((t) => t.tabId === b.activeTabId) ?? b.tabs[b.tabs.length - 1];
}

const plural = (n: number) => `${n} tab${n === 1 ? "" : "s"}`;

/** Busy: a pulsing "Working in browser" and the tab's title. Idle with tabs: the tab count. Else nothing. */
export function browserBadgeHtml(b: AgentBrowser | undefined): string {
  if (!b) return "";
  if (b.busy) {
    const t = focusTab(b);
    const title = t ? `<span class="browser-tab">${esc(t.title)}</span>` : "";
    return `<span class="browser-badge busy" title="${esc(t ? `Working in browser: ${t.title}` : "Working in browser")}"><span class="pulse" aria-hidden="true"></span><span class="browser-word">Working in browser</span>${title}</span>`;
  }
  if (!b.tabs.length) return "";
  return `<span class="browser-badge" title="${esc(b.tabs.map((t) => t.title).join("\n"))}">${plural(b.tabs.length)}</span>`;
}

// ---------------------------------------------------------------------------
// The live view strip (chat page): off -> starting -> live, or ended / unavailable
// ---------------------------------------------------------------------------

export type LiveStateName = "off" | "starting" | "live" | "ended" | "unavailable";

export interface LiveState {
  /** The strip is expanded (watching); collapsed stops the screencast. */
  open: boolean;
  /** The bigger view. */
  expanded: boolean;
  tabId?: number;
  /** The user chose this tab; otherwise the strip follows the agent's active tab. */
  picked: boolean;
  state: LiveStateName;
  reason?: string;
  /** The tabs the agent owns, as last seen. */
  tabIds: number[];
}

export const initialLive: LiveState = { open: true, expanded: false, picked: false, state: "off", tabIds: [] };

export type LiveAction =
  | { type: "agent"; browser: AgentBrowser | undefined }
  | { type: "pick"; tabId: number }
  | { type: "toggle" }
  | { type: "expand" }
  | { type: "state"; tabId: number; state: "starting" | "live" | "ended" | "unavailable"; reason?: string }
  | { type: "frame"; tabId: number };

/** A new target tab starts over. */
const retarget = (s: LiveState, tabId: number | undefined, picked: boolean): LiveState => {
  if (tabId === s.tabId) return { ...s, picked };
  if (tabId == null) return { ...s, tabId: undefined, picked: false, state: s.state === "off" ? "off" : "ended", reason: undefined };
  return { ...s, tabId, picked, state: s.open ? "starting" : "off", reason: undefined };
};

export function liveReducer(s: LiveState, a: LiveAction): LiveState {
  switch (a.type) {
    case "agent": {
      const b = a.browser;
      const tabIds = b?.tabs.map((t) => t.tabId) ?? [];
      const next = { ...s, tabIds };
      if (s.picked && s.tabId != null && tabIds.includes(s.tabId)) return next;
      const want = b ? focusTab(b)?.tabId : undefined;
      // The tab being watched closed: say so, then follow the next one.
      return retarget(next, want, false);
    }
    case "pick":
      if (!s.tabIds.includes(a.tabId)) return s;
      return retarget(s, a.tabId, true);
    case "toggle":
      if (s.open) return { ...s, open: false, expanded: false, state: s.tabId != null ? "off" : s.state };
      return { ...s, open: true, state: s.tabId != null ? "starting" : s.state, reason: undefined };
    case "expand":
      return { ...s, expanded: !s.expanded, open: true };
    case "state":
      if (a.tabId !== s.tabId || !s.open) return s;
      return { ...s, state: a.state, reason: a.reason };
    case "frame":
      if (a.tabId !== s.tabId || !s.open) return s;
      return s.state === "live" ? s : { ...s, state: "live", reason: undefined };
  }
}

/** The tab the page should be screencasting now, or null (collapsed, no tab, ended, unavailable). */
export function liveWant(s: LiveState): { tabId: number } | null {
  return s.open && s.tabId != null && (s.state === "starting" || s.state === "live") ? { tabId: s.tabId } : null;
}

const STATE_WORDS: Record<LiveStateName, string> = { off: "Paused", starting: "Starting live view…", live: "Live", ended: "Tab closed", unavailable: "Live view not available" };

/**
 * The strip above the composer. Empty when the agent has no tabs. Read-only: the picture is an <img>; nothing
 * the user does on it reaches the page. ui/chat.ts sets the <img> src for each frame.
 */
export function liveStripHtml(s: LiveState, b: AgentBrowser | undefined): string {
  if (!b?.tabs.length) return "";
  const cur = b.tabs.find((t) => t.tabId === s.tabId);
  const words = s.state === "unavailable" && s.reason ? s.reason : STATE_WORDS[s.state];
  const dot = `<span class="live-dot live-${s.state}" aria-hidden="true"></span>`;
  const picker =
    b.tabs.length > 1
      ? `<select class="live-pick" data-live-pick aria-label="Tab to watch">${b.tabs.map((t) => `<option value="${t.tabId}"${t.tabId === s.tabId ? " selected" : ""}>${esc(t.title.slice(0, 80))}</option>`).join("")}</select>`
      : `<span class="live-title" title="${esc(cur?.url ?? "")}">${esc(cur?.title ?? "")}</span>`;
  const head = `<div class="live-head"><button type="button" class="live-toggle" data-live-toggle aria-expanded="${s.open}" aria-controls="liveBody"><span class="live-label">Live view</span></button>${dot}<span class="live-state" role="status">${esc(words)}</span>${picker}${s.open ? `<button type="button" class="link live-expand" data-live-expand aria-pressed="${s.expanded}">${s.expanded ? "Smaller" : "Larger"}</button>` : ""}</div>`;
  if (!s.open) return `<div class="live-strip collapsed">${head}</div>`;
  const showImg = s.state === "live" || s.state === "starting";
  const body = `<div id="liveBody" class="live-body"><img id="liveImg" class="live-img" alt="${esc(cur ? `Live view of ${cur.title}` : "Live view")}" data-live-expand${showImg ? "" : " hidden"} />${showImg ? "" : `<div class="live-empty muted small">${esc(words)}</div>`}</div>`;
  return `<div class="live-strip${s.expanded ? " live-expanded" : ""}">${head}${body}</div>`;
}
