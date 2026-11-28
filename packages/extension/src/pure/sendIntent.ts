// Send to agent P2c (#92, docs/specs/agent-inbox.md AD14, §7): the "Send to agent" context menu, the pending
// intent it hands the side panel, the recent-agents list and the composer's selection. Plain data in and out;
// background/contextMenu.ts and ui/sidepanel.ts wire it to chrome.*.

/** chrome.storage.session: the menu's pending intent, read and cleared by the panel. */
export const SEND_INTENT_KEY = "agentSendIntent";
/** chrome.storage.local: agents the panel sent to successfully, latest first. */
export const RECENT_AGENTS_KEY = "recentAgents";
export const INTENT_MAX_AGE_MS = 120_000;
export const RECENT_AGENTS_MAX = 5;
/** The panel applies an intent stamped a little ahead of its own clock, not one from the far future. */
const CLOCK_SKEW_MS = 5_000;

export const MENU_ROOT_ID = "tabagent-send";
export const MENU_CHOOSE_ID = "tabagent-send:choose";
const MENU_AGENT_PREFIX = "tabagent-send:agent:";
const CONTEXTS = ["page", "selection"] as const;
const MENU_TITLE_MAX = 60;
const PREVIEW_MAX = 80;

/** AD14: what the menu records. It never sends. */
export interface SendIntent {
  /** null for "Choose…". */
  agentId: string | null;
  tabId: number;
  selection: string | null;
  at: number;
}

export interface RecentAgent {
  id: string;
  name: string;
}

export interface MenuItem {
  id: string;
  parentId?: string;
  title: string;
  type?: "separator";
  contexts: ("page" | "selection")[];
}

/** The selection as the panel holds it: tied to the tab it was made in. */
export interface HeldSelection {
  tabId: number;
  text: string;
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Chrome replaces %s in a selection-context title with the selected text. */
const menuTitle = (name: string) => shorten(name, MENU_TITLE_MAX).replace(/%s/g, "%​s");

/** The agent id for one of our agent items, null for "Choose…", undefined for anything else. */
export function menuAgentId(menuItemId: unknown): string | null | undefined {
  if (menuItemId === MENU_CHOOSE_ID) return null;
  if (typeof menuItemId === "string" && menuItemId.startsWith(MENU_AGENT_PREFIX) && menuItemId.length > MENU_AGENT_PREFIX.length) return menuItemId.slice(MENU_AGENT_PREFIX.length);
  return undefined;
}

/**
 * "Send to agent ▸": up to 5 recent agents, then "Choose…". `current` is the agent list as id and display
 * title; when given, agents that are gone are left out and current names win. null means the list could not
 * be read, so stored names are shown (the panel re-validates on use).
 */
export function menuItems(recent: RecentAgent[], current: { id: string; title: string }[] | null): MenuItem[] {
  const contexts = [...CONTEXTS];
  const items: MenuItem[] = [{ id: MENU_ROOT_ID, title: "Send to agent", contexts }];
  const byId = current ? new Map(current.map((a) => [a.id, a.title])) : null;
  const shown = recent
    .filter((r) => !byId || byId.has(r.id))
    .slice(0, RECENT_AGENTS_MAX)
    .map((r) => ({ id: r.id, name: (byId?.get(r.id) ?? r.name).trim() || r.id }));
  for (const a of shown) items.push({ id: MENU_AGENT_PREFIX + a.id, parentId: MENU_ROOT_ID, title: menuTitle(a.name), contexts });
  if (shown.length) items.push({ id: `${MENU_ROOT_ID}:sep`, parentId: MENU_ROOT_ID, title: "", type: "separator", contexts });
  items.push({ id: MENU_CHOOSE_ID, parentId: MENU_ROOT_ID, title: "Choose…", contexts });
  return items;
}

/** The intent for a menu click, or null when the click was not ours or had no tab. */
export function intentFromClick(info: { menuItemId: unknown; selectionText?: string }, tab: { id?: number } | undefined, now: number): SendIntent | null {
  const agentId = menuAgentId(info.menuItemId);
  if (agentId === undefined || typeof tab?.id !== "number" || tab.id < 0) return null;
  return { agentId, tabId: tab.id, selection: info.selectionText || null, at: now };
}

/** A well-formed intent no older than 2 minutes, or null. */
export function parseIntent(raw: unknown, now: number): SendIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const agentOk = r.agentId === null || (typeof r.agentId === "string" && r.agentId.length > 0);
  const selOk = r.selection === null || typeof r.selection === "string";
  if (!agentOk || !selOk || !Number.isInteger(r.tabId) || typeof r.at !== "number") return null;
  const age = now - r.at;
  if (age > INTENT_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return null;
  return { agentId: r.agentId as string | null, tabId: r.tabId as number, selection: (r.selection as string | null) || null, at: r.at };
}

/**
 * How the panel applies an intent. `select`: the agent to select, null to clear the choice (the agent is no
 * longer listed), undefined to leave it ("Choose…").
 */
export function intentOutcome(intent: SendIntent, listedIds: string[]): { select: string | null | undefined; notice: string; selection: HeldSelection | null } {
  const selection = intent.selection ? { tabId: intent.tabId, text: intent.selection } : null;
  if (intent.agentId === null) return { select: undefined, notice: "", selection };
  if (listedIds.includes(intent.agentId)) return { select: intent.agentId, notice: "", selection };
  return { select: null, notice: "That agent is no longer running.", selection };
}

/**
 * AD14: the selection belongs to the tab it was made in. Another active tab (or none) drops it; an unknown
 * active tab (`undefined`, not read yet) keeps it.
 */
export function reconcileSelection(sel: HeldSelection | null, activeTabId: number | null | undefined): { selection: HeldSelection | null; dropped: boolean } {
  if (!sel) return { selection: null, dropped: false };
  if (activeTabId === undefined || activeTabId === sel.tabId) return { selection: sel, dropped: false };
  return { selection: null, dropped: true };
}

/** Display only: the sent selection is never truncated. */
export function selectionPreview(text: string): string {
  return shorten(text.replace(/\s+/g, " ").trim(), PREVIEW_MAX);
}

/** The "Include selection" checkbox: enabled only with a held selection while the tab is shared. */
export function selectionView(s: { selection: HeldSelection | null; dropped: boolean; shareOn: boolean }): { enabled: boolean; text: string } {
  if (s.selection) return s.shareOn ? { enabled: true, text: `“${selectionPreview(s.selection.text)}”` } : { enabled: false, text: "(sent only with the tab)" };
  if (s.dropped) return { enabled: false, text: "(dropped: you switched tabs)" };
  return { enabled: false, text: "(select text on the page, then right-click Send to agent)" };
}

/** Latest first, one entry per agent, at most 5. */
export function updateRecent(list: RecentAgent[], agent: RecentAgent): RecentAgent[] {
  return [agent, ...list.filter((a) => a.id !== agent.id)].slice(0, RECENT_AGENTS_MAX);
}

/** Whatever is in storage, as a clean recent list. */
export function sanitizeRecent(raw: unknown): RecentAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentAgent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || out.some((o) => o.id === r.id)) continue;
    out.push({ id: r.id, name: typeof r.name === "string" && r.name ? r.name : r.id });
    if (out.length === RECENT_AGENTS_MAX) break;
  }
  return out;
}
