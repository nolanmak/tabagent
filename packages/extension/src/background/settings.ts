import { DEFAULT_DENYLIST, DEFAULT_PORT, type SitePolicy } from "@tabagent/protocol";

export interface Settings {
  port: number;
  secret: string | null;
  /** Explicit per-origin policies set by the user. */
  policies: Record<string, SitePolicy>;
  /** Origins where sensitive actions are pre-approved. */
  sensitiveAllowed: Record<string, boolean>;
  /** Policy for origins without an explicit entry. */
  defaultPolicy: SitePolicy;
  denylist: string[];
  /** Host globs driven in lite mode (no chrome.debugger). */
  liteSites: string[];
  forceLite: boolean;
  showOverlay: boolean;
  onSessionEnd: "collapse" | "close" | "keep";
  /** Kill switch engaged. */
  paused: boolean;
  autoAcceptBeforeUnload: boolean;
}

export const DEFAULTS: Settings = {
  port: DEFAULT_PORT,
  secret: null,
  policies: {},
  sensitiveAllowed: {},
  defaultPolicy: "ask",
  denylist: DEFAULT_DENYLIST,
  liteSites: [],
  forceLite: false,
  showOverlay: true,
  onSessionEnd: "collapse",
  paused: false,
  autoAcceptBeforeUnload: true,
};

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const raw = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  cache = { ...DEFAULTS, ...(raw ?? {}) };
  return cache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  cache = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: cache });
  return cache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cache = { ...DEFAULTS, ...(changes.settings.newValue ?? {}) };
});
