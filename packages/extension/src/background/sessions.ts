// Agent sessions and tab ownership (D8-D10). A tab belongs to at most one session (D9).
// State is persisted in chrome.storage.session and restored after a worker restart (D11).
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";

export interface Session {
  meta: SessionMeta;
  tabIds: number[];
  active?: number;
  created: number;
  lastUsed: number;
}

const sessions = new Map<string, Session>();
const owner = new Map<number, string>();
let restored: Promise<void> | null = null;

export function restoreSessions(): Promise<void> {
  restored ??= (async () => {
    let raw: { sessions?: Session[] } = {};
    try {
      raw = (await chrome.storage.session.get(["sessions"])) as typeof raw;
    } catch {
      /* no storage */
    }
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
  restored = null;
}

async function persist() {
  await chrome.storage.session.set({ sessions: [...sessions.values()] }).catch(() => {});
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ id: s.meta.id, label: s.meta.label, tabs: s.tabIds.length, tabIds: s.tabIds.slice(), active: s.active, lastUsed: s.lastUsed }));
}

export async function getSession(meta: SessionMeta): Promise<Session> {
  await restoreSessions();
  let s = sessions.get(meta.id);
  if (!s) {
    s = { meta, tabIds: [], created: Date.now(), lastUsed: Date.now() };
    sessions.set(meta.id, s);
    await persist();
  } else {
    s.meta = meta;
    s.lastUsed = Date.now();
  }
  return s;
}

export function ownerOf(tabId: number) {
  return owner.get(tabId);
}

export async function addTab(s: Session, tabId: number) {
  const o = owner.get(tabId);
  if (o && o !== s.meta.id) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} belongs to another agent session (${sessions.get(o)?.meta.label ?? o})`);
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  owner.set(tabId, s.meta.id);
  s.active = tabId;
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
    throw new TabAgentError("NOT_FOUND", `Tab ${tabId} is not in this session`, "Use tabs action=new to open a tab for this session.");
  }
  if (s.active != null && s.tabIds.includes(s.active)) return s.active;
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

export async function removeTab(tabId: number) {
  const o = owner.get(tabId);
  owner.delete(tabId);
  if (!o) return;
  const s = sessions.get(o);
  if (!s) return;
  s.tabIds = s.tabIds.filter((t) => t !== tabId);
  if (s.active === tabId) s.active = s.tabIds[s.tabIds.length - 1];
  await persist();
}

/** The bridge closed the session (D8): its tabs are released and left open. */
export async function endSession(id: string) {
  await restoreSessions();
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  for (const t of s.tabIds) owner.delete(t);
  await persist();
  return true;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (owner.has(tabId)) removeTab(tabId).catch(() => {});
});
