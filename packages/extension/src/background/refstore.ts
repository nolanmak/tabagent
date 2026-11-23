// Adapter: the shared ref table (D22) and diff baselines (D24) for this
// service worker. The ref counter lives in chrome.storage.session so numbers
// are never reused after a worker restart; the table and baselines do not
// survive a restart (D11), so old refs come back REF_STALE.
import { Baselines } from "./diff";
import { RefTable, type CounterStore } from "./refs";

const KEY = "refCounter";

const sessionStore: CounterStore = {
  async load() {
    try {
      const v = (await chrome.storage.session.get(KEY))[KEY];
      return typeof v === "number" ? v : 0;
    } catch {
      return 0;
    }
  },
  async save(n: number) {
    await chrome.storage.session.set({ [KEY]: n }).catch(() => {});
  },
};

export const refTable = new RefTable(sessionStore);
export const baselines = new Baselines();

/** Forget everything about a tab (closed, left the session). */
export function forgetTab(tabId: number) {
  refTable.dropTab(tabId);
  baselines.clearTab(tabId);
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
} catch {
  /* not in an extension context (unit tests) */
}
