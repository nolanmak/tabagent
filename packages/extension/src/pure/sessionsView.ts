// Side panel Sessions list (#133): each session's tabs and the click-to-view row, as plain data in and
// escaped HTML out. The worker builds the view (it has the tab titles); sidepanel.ts renders and wires it.
import { esc } from "./html";

/** Longest tab title shown in a session's tab list, ellipsis included. */
export const TITLE_MAX = 60;

export interface SessionTabView {
  tabId: number;
  title: string;
  /** The session's active tab: where a click on the row goes. */
  active: boolean;
}

/** One entry of the worker's listSessions(). */
export interface SessionSummary {
  id: string;
  label: string;
  color: string;
  cap: string;
  tabs: number;
  tabIds: number[];
  active?: number;
  lastUsed: number;
  [k: string]: unknown;
}

export interface SessionView extends SessionSummary {
  /** Active tab first, then the rest most recently added first. */
  tabList: SessionTabView[];
  /** The tab a click on the row focuses; absent when the session has no tabs. */
  viewTabId?: number;
}

export function truncateTitle(title: string, max = TITLE_MAX): string {
  const t = title.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function sessionTabs(s: { tabIds: number[]; active?: number }, titles: Record<number, string | undefined>): SessionTabView[] {
  const recent = s.tabIds.slice().reverse();
  const active = s.active != null && s.tabIds.includes(s.active) ? s.active : recent[0];
  const ordered = active == null ? recent : [active, ...recent.filter((t) => t !== active)];
  return ordered.map((tabId) => ({ tabId, title: titles[tabId]?.trim() || `Tab ${tabId}`, active: tabId === active }));
}

export function sessionView(s: SessionSummary, titles: Record<number, string | undefined>): SessionView {
  const tabList = sessionTabs(s, titles);
  return { ...s, tabList, viewTabId: tabList[0]?.tabId };
}

export function sessionRowHtml(s: SessionView): string {
  const n = s.tabList.length;
  const summary = `<span class="dot g-${esc(s.color)}" aria-hidden="true"></span><span><b class="session-label">${esc(s.label)}</b> <span class="muted small">${n} tab${n === 1 ? "" : "s"} · ${esc(s.cap)}</span></span>`;
  const head =
    s.viewTabId != null
      ? `<button type="button" class="session-view" data-view-tab="${Number(s.viewTabId)}" title="View this session's tab" aria-label="View tab of session ${esc(s.label)}">${summary}</button>`
      : `<span class="session-summary">${summary}</span>`;
  const tabs =
    n > 1
      ? `<ul class="session-tabs">${s.tabList
          .map((t) => `<li><button type="button" class="session-tab${t.active ? " active" : ""}" data-view-tab="${Number(t.tabId)}" title="${esc(truncateTitle(t.title, 300))}"${t.active ? ' aria-current="true"' : ""}>${esc(truncateTitle(t.title))}</button></li>`)
          .join("")}</ul>`
      : "";
  return `<li class="session" data-session="${esc(s.id)}"><div class="session-head">${head}<button type="button" class="ghost sm" data-end="${esc(s.id)}" aria-label="End session ${esc(s.label)}">End</button></div>${tabs}</li>`;
}

/** Why ui.focusTab must not focus this tab, or null when a TabAgent session owns it. */
export function focusRefusal(tabId: unknown, ownerOf: (tabId: number) => string | undefined): string | null {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) return "Invalid tab id";
  if (!ownerOf(tabId)) return `Tab ${tabId} is not a TabAgent session tab`;
  return null;
}
