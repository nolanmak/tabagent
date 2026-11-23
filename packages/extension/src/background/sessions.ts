// Agent sessions: each owns a labelled, coloured tab group. A tab belongs to at
// most one session (that's the tab lock).
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { detachTab } from "./cdp";
import { disposeDrivers } from "./driver";
import { broadcast } from "./feed";
import { clearGrants } from "./permissions";
import { getSettings } from "./settings";

type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface Session {
  meta: SessionMeta;
  tabIds: number[];
  active?: number;
  groupId?: number;
  color: GroupColor;
  created: number;
  lastUsed: number;
}

const COLORS: GroupColor[] = ["purple", "blue", "cyan", "green", "orange", "pink", "red", "yellow", "grey"];
let colorIdx = 0;

const sessions = new Map<string, Session>();
const owner = new Map<number, string>();
let restored: Promise<void> | null = null;

export function restoreSessions(): Promise<void> {
  restored ??= (async () => {
    const raw = (await chrome.storage.session.get("sessions")).sessions as Session[] | undefined;
    for (const s of raw ?? []) {
      const live: number[] = [];
      for (const id of s.tabIds) {
        try {
          await chrome.tabs.get(id);
          live.push(id);
        } catch {
          /* closed */
        }
      }
      s.tabIds = live;
      if (s.active && !live.includes(s.active)) s.active = live[live.length - 1];
      sessions.set(s.meta.id, s);
      for (const id of live) owner.set(id, s.meta.id);
    }
  })();
  return restored;
}

async function persist() {
  await chrome.storage.session.set({ sessions: [...sessions.values()] });
  updateBadge();
  broadcast({ type: "sessions", sessions: listSessions() });
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ id: s.meta.id, label: s.meta.label, tabs: s.tabIds.length, active: s.active, color: s.color, cap: s.meta.cap, lastUsed: s.lastUsed }));
}

export function updateBadge() {
  const n = sessions.size;
  chrome.action.setBadgeText({ text: n ? String(n) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" }).catch(() => {});
}

export async function getSession(meta: SessionMeta): Promise<Session> {
  await restoreSessions();
  let s = sessions.get(meta.id);
  if (!s) {
    s = { meta, tabIds: [], color: COLORS[colorIdx++ % COLORS.length], created: Date.now(), lastUsed: Date.now() };
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

async function groupTab(s: Session, tabId: number) {
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
    await chrome.tabGroups.update(s.groupId, { title: `🤖 ${s.meta.label}`, color: s.color as any, collapsed: false });
  } catch {
    /* windows without tab-group support (popups, some browsers) */
  }
}

export async function addTab(s: Session, tabId: number) {
  const o = owner.get(tabId);
  if (o && o !== s.meta.id) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} is being driven by another agent session (${sessions.get(o)?.meta.label ?? o})`);
  if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
  owner.set(tabId, s.meta.id);
  s.active = tabId;
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
  const tab = await chrome.tabs.create({ url, active: true, windowId });
  await addTab(s, tab.id!);
  return tab;
}

/** Resolve the tab a command should act on. */
export async function resolveTab(s: Session, tabId?: number, create = false): Promise<number> {
  if (tabId != null) {
    const o = owner.get(tabId);
    if (o === s.meta.id) return tabId;
    if (o) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} belongs to another agent session (${sessions.get(o)?.meta.label ?? o})`);
    throw new TabAgentError("NOT_FOUND", `Tab ${tabId} is not in this session`, "Use tabs action=attach to adopt a user tab (asks the user), or tabs action=new.");
  }
  if (s.active != null && s.tabIds.includes(s.active)) return s.active;
  if (s.tabIds.length) return (s.active = s.tabIds[s.tabIds.length - 1]);
  if (create) return (await newTab(s)).id!;
  throw new TabAgentError("NOT_FOUND", "This session has no tabs yet", "Call nav.goto with a url, or tabs action=new.");
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
  if (s.active === tabId) s.active = s.tabIds[s.tabIds.length - 1];
  await persist();
}

export async function endSession(id: string, how?: "collapse" | "close" | "keep") {
  await restoreSessions();
  const s = sessions.get(id);
  if (!s) return false;
  const mode = how ?? (await getSettings()).onSessionEnd;
  sessions.delete(id);
  clearGrants(id);
  for (const t of s.tabIds) {
    owner.delete(t);
    disposeDrivers(t);
    await detachTab(t);
  }
  if (mode === "close" && s.tabIds.length) await chrome.tabs.remove(s.tabIds).catch(() => {});
  else if (s.groupId != null) {
    try {
      if (mode === "collapse") await chrome.tabGroups.update(s.groupId, { collapsed: true, title: `✓ ${s.meta.label}` });
      else await chrome.tabGroups.update(s.groupId, { title: `✓ ${s.meta.label}` });
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (owner.has(tabId)) removeTab(tabId).catch(() => {});
  else {
    disposeDrivers(tabId);
    detachTab(tabId).catch(() => {});
  }
});
