// Send to agent P2c (#92, spec AD14, §7): the "Send to agent ▸" context menu. A thin adapter over
// ../pure/sendIntent. The menu never sends: a click writes a pending intent to chrome.storage.session and opens
// the side panel, which reads the intent, applies it and clears it. Only a panel click can send.
import { intentFromClick, menuItems, RECENT_AGENTS_KEY, sanitizeRecent, SEND_INTENT_KEY, type MenuItem } from "../pure/sendIntent";

/** The current agent list as id and display title, or null when it cannot be read. */
export type CurrentAgents = () => Promise<{ id: string; title: string }[] | null>;

let built: MenuItem[] = [];
let chain: Promise<unknown> = Promise.resolve();

/** The items of the last rebuild (Chrome has no getter); e2e reads them. */
export const menuItemsBuilt = () => built;

/** Rebuild the static menu from the recent list. Serialized, so two rebuilds never race on item ids. */
export function rebuildMenus(current: CurrentAgents): Promise<MenuItem[]> {
  const run = chain.then(async () => {
    const recent = sanitizeRecent((await chrome.storage.local.get(RECENT_AGENTS_KEY))[RECENT_AGENTS_KEY]);
    const list = recent.length ? await current().catch(() => null) : null;
    const items = menuItems(recent, list);
    await chrome.contextMenus.removeAll();
    for (const { id, parentId, title, type, contexts } of items) {
      chrome.contextMenus.create({ id, parentId, title: type ? undefined : title, type: type ?? "normal", contexts: contexts as [chrome.contextMenus.ContextType, ...chrome.contextMenus.ContextType[]] }, () => void chrome.runtime.lastError);
    }
    built = items;
    return items;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * chrome.contextMenus.onClicked. sidePanel.open must run inside the click's user gesture, so it is called
 * before anything is awaited; the panel also watches storage, so the write may land after it opens.
 */
export async function onMenuClick(info: { menuItemId: unknown; selectionText?: string }, tab: { id?: number; windowId?: number } | undefined): Promise<void> {
  const intent = intentFromClick(info, tab, Date.now());
  if (!intent) return;
  const write = chrome.storage.session.set({ [SEND_INTENT_KEY]: intent });
  let open: Promise<unknown> = Promise.resolve();
  try {
    if (typeof tab?.windowId === "number") open = chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    /* no gesture (tests) or no panel: the intent still waits for the next panel open */
  }
  await Promise.all([write, open.catch(() => {})]);
}

export function wireContextMenu(current: CurrentAgents) {
  chrome.contextMenus.onClicked.addListener((info, tab) => void onMenuClick(info, tab));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && RECENT_AGENTS_KEY in changes) void rebuildMenus(current).catch(() => {});
  });
  void rebuildMenus(current).catch(() => {});
}
