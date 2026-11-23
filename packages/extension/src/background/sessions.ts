// Agent sessions (#5, D8-D10). Each session owns a labelled, coloured tab group.
// A tab belongs to at most one session (D9); that map is the only tab lock.
// State is persisted in chrome.storage.session and restored after a worker restart (D11).
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { detachTab } from "./cdp";
import { disposeDrivers } from "./driver";
import { broadcast } from "./feed";
import { clearGrants, prompts } from "./permissions";
import { getSettings } from "./settings";

type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface Session {
  meta: SessionMeta;
  tabIds: number[];
  /** Tabs adopted with tabs attach: ungrouped and left open on session end. */
  attached: number[];
  active?: number;
  groupId?: number;
  color: GroupColor;
  index: number;
  created: number;
  lastUsed: number;
}

export const COLORS: GroupColor[] = ["purple", "blue", "cyan", "green", "orange", "pink", "red", "yellow", "grey"];

const sessions = new Map<string, Session>();
const owner = new Map<number, string>();
/** Tabs we are grouping right now: their groupId change is ours, not a user drag. */
const grouping = new Set<number>();
let nextIndex = 0;
let restored: Promise<void> | null = null;

export function restoreSessions(): Promise<void> {
  restored ??= (async () => {
    let raw: { sessions?: Session[]; nextIndex?: number } = {};
    try {
      raw = (await chrome.storage.session.get(["sessions", "nextIndex"])) as typeof raw;
    } catch {
      /* no storage */
    }
    nextIndex = raw.nextIndex ?? 0;
    for (const s of raw.sessions ?? []) {
      const live: number[] = [];
      for (const id of s.tabIds) {
        try {
          await chrome.tabs.get(id);
          live.push(id);
        } catch {
          /* closed while the worker was asleep */
        }
      }
      s.tabIds = live;
      s.attached = (s.attached ?? []).filter((t) => live.includes(t));
      if (s.active != null && !live.includes(s.active)) s.active = live[live.length - 1];
      sessions.set(s.meta.id, s);
      for (const id of live) owner.set(id, s.meta.id);
    }
  })();
  return restored;
}

/** Test hook: forget in-memory state (simulates a service-worker restart). */
export function __resetForTests() {
  sessions.clear();
  owner.clear();
  grouping.clear();
  locks.clear();
  nextIndex = 0;
  restored = null;
}

let onChange: (() => void) | null = null;
/** index.ts hooks badge/UI refresh here. */
export function onSessionsChanged(fn: () => void) {
  onChange = fn;
}

async function persist() {
  await chrome.storage.session.set({ sessions: [...sessions.values()], nextIndex }).catch(() => {});
  onChange?.();
  broadcast({ type: "sessions", sessions: listSessions() });
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ id: s.meta.id, label: s.meta.label, tabs: s.tabIds.length, tabIds: s.tabIds.slice(), attached: s.attached.slice(), active: s.active, color: s.color, cap: s.meta.cap, lastUsed: s.lastUsed }));
}

/** @deprecated the badge is owned by index.ts (D40); kept for older imports. */
export function updateBadge() {
  onChange?.();
}

export async function getSession(meta: SessionMeta): Promise<Session> {
  await restoreSessions();
  let s = sessions.get(meta.id);
  if (!s) {
    const index = nextIndex++;
    s = { meta, tabIds: [], attached: [], color: COLORS[index % COLORS.length], index, created: Date.now(), lastUsed: Date.now() };
    sessions.set(meta.id, s);
    await persist();
  } else {
    s.meta = meta;
    s.lastUsed = Date.now();
  }
  return s;
}

export function sessionById(id: string) {
  return sessions.get(id);
}

export function ownerOf(tabId: number) {
  return owner.get(tabId);
}

export function groupTitle(label: string) {
  return `🤖 ${label}`;
}

async function groupTab(s: Session, tabId: number) {
  grouping.add(tabId);
  try {
    if (s.groupId != null) {
      try {
        await chrome.tabGroups.get(s.groupId);
        await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] });
        return;
      } catch {
        s.groupId = undefined;
      }
    }
    s.groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(s.groupId, { title: groupTitle(s.meta.label), color: s.color, collapsed: false });
  } catch {
    /* windows without tab-group support (popups) */
  } finally {
    // events for our own grouping carry s.groupId once it is set, so the guard can end here
    grouping.delete(tabId);
  }
}

export async function addTab(s: Session, tabId: number, opts: { attached?: boolean; makeActive?: boolean } = {}) {
  const o = owner.get(tabId);
  if (o && o !== s.meta.id) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} belongs to another agent session (${sessions.get(o)?.meta.label ?? o})`);
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  if (opts.attached && !s.attached.includes(tabId)) s.attached.push(tabId);
  owner.set(tabId, s.meta.id);
  if (opts.makeActive !== false) s.active = tabId;
  await groupTab(s, tabId);
  await persist();
}

export async function newTab(s: Session, url = "about:blank"): Promise<chrome.tabs.Tab> {
  let windowId: number | undefined;
  const ref = s.tabIds[s.tabIds.length - 1];
  if (ref != null) {
    try {
      windowId = (await chrome.tabs.get(ref)).windowId;
    } catch {
      /* gone */
    }
  }
  if (windowId == null) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    windowId = (wins.find((w) => w.focused) ?? wins[0])?.id;
    if (windowId == null) windowId = (await chrome.windows.create({ url: "about:blank", focused: false }))?.id;
  }
  // D10: never bring a tab or window to the front.
  const tab = await chrome.tabs.create({ url, active: false, windowId });
  await addTab(s, tab.id!);
  return tab;
}

export const NO_TABS_HINT = "call tabs new (tabs action=new), or nav.goto with a url";

/** Resolve the tab a command should act on (D9, D10). */
export async function resolveTab(s: Session, tabId?: number, create = false): Promise<number> {
  await restoreSessions();
  if (tabId != null) {
    const o = owner.get(tabId);
    if (o === s.meta.id) return tabId;
    if (o) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} belongs to another agent session (${sessions.get(o)?.meta.label ?? o})`);
    throw new TabAgentError("NOT_FOUND", `Tab ${tabId} is not in this session`, "Use tabs action=attach to adopt a user tab (asks the user), or tabs action=new.");
  }
  if (s.active != null && s.tabIds.includes(s.active)) {
    return s.active;
  }
  if (s.tabIds.length) {
    s.active = s.tabIds[s.tabIds.length - 1];
    return s.active;
  }
  if (create) return (await newTab(s)).id!;
  throw new TabAgentError("NOT_FOUND", "This session has no tabs yet", NO_TABS_HINT);
}

/** tabs select: changes the session's active tab only. Never activates or focuses (D10). */
export async function selectTab(s: Session, tabId: number) {
  const id = await resolveTab(s, tabId);
  s.active = id;
  await persist();
  return id;
}

/** The tab a no-tabId attach adopts: the active tab of the last-focused window (D9). */
export async function userActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const w = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] }).catch(() => undefined);
  return w?.tabs?.find((t) => t.active);
}

export async function removeTab(tabId: number) {
  const o = owner.get(tabId);
  owner.delete(tabId);
  disposeDrivers(tabId);
  await detachTab(tabId);
  if (!o) return;
  const s = sessions.get(o);
  if (!s) return;
  s.tabIds = s.tabIds.filter((t) => t !== tabId);
  s.attached = s.attached.filter((t) => t !== tabId);
  if (s.active === tabId) s.active = s.tabIds[s.tabIds.length - 1];
  await persist();
}

export async function endSession(id: string, how?: "collapse" | "close" | "keep") {
  await restoreSessions();
  const s = sessions.get(id);
  if (!s) return false;
  const mode = how ?? (await getSettings()).onSessionEnd;
  sessions.delete(id);
  await clearGrants(id);
  prompts.dropSession(id);
  for (const t of s.tabIds) {
    owner.delete(t);
    disposeDrivers(t);
    await detachTab(t);
  }
  // Attached tabs were the user's: ungroup, never close.
  if (s.attached.length) await chrome.tabs.ungroup(s.attached as [number, ...number[]]).catch(() => {});
  const own = s.tabIds.filter((t) => !s.attached.includes(t));
  if (mode === "close" && own.length) await chrome.tabs.remove(own).catch(() => {});
  else if (s.groupId != null && own.length) {
    try {
      await chrome.tabGroups.update(s.groupId, { collapsed: mode === "collapse", title: `✓ ${s.meta.label}` });
    } catch {
      /* group gone */
    }
  }
  await persist();
  return true;
}

export async function endAllSessions() {
  for (const id of [...sessions.keys()]) await endSession(id);
}

// ---------------------------------------------------------------------------
// Serial queue: commands from one session to one tab run in arrival order (D9).
// ---------------------------------------------------------------------------
const locks = new Map<number, Promise<unknown>>();
export async function serialize<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(tabId, chain);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(tabId) === chain) locks.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// Tab events
// ---------------------------------------------------------------------------

/** A tab opened by a session tab (popup, target=_blank) joins that session (D9). */
export async function adoptOpened(openerTabId: number | undefined, tabId: number | undefined) {
  if (openerTabId == null || tabId == null) return;
  await restoreSessions();
  const sid = owner.get(openerTabId);
  if (!sid || owner.has(tabId)) return;
  const s = sessions.get(sid);
  if (!s) return;
  await addTab(s, tabId, { makeActive: false });
}

/** The user dragged a tab out of the session's group: it leaves the session (D9). */
export async function onGroupChanged(tabId: number, groupId: number) {
  await restoreSessions();
  const sid = owner.get(tabId);
  if (!sid || grouping.has(tabId)) return;
  const s = sessions.get(sid);
  if (!s || s.groupId == null || groupId === s.groupId) return;
  await removeTab(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (owner.has(tabId)) removeTab(tabId).catch(() => {});
  else {
    disposeDrivers(tabId);
    detachTab(tabId).catch(() => {});
  }
});

// Only page-initiated opens (window.open, target=_blank, modified clicks) join the opener's
// session. tabs.onCreated's openerTabId is also set for the user's own Ctrl+T / new-tab button
// while an agent tab is focused, which must never hand the user's tab to the agent.
chrome.webNavigation?.onCreatedNavigationTarget?.addListener((d) => {
  adoptOpened(d.sourceTabId, d.tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.groupId !== undefined) onGroupChanged(tabId, info.groupId).catch(() => {});
});
