// Extension settings (D32, contract §7). Persistent settings live in
// chrome.storage.local (access level TRUSTED_CONTEXTS so content scripts can't
// read the secret, D7).
import { migrateSettings, type BeforeUnload, type OnSessionEnd } from "./settingsModel";

export { migrateSettings };
export type { BeforeUnload, OnSessionEnd };

export interface Settings {
  port: number;
  secret: string | null;
  devAllowSensitive: boolean;
  onSessionEnd: OnSessionEnd;
  beforeUnload: BeforeUnload;
  showOverlay: boolean;
  /** @deprecated derived from beforeUnload === "accept"; read by older cdp.ts. */
  autoAcceptBeforeUnload: boolean;
}

export type StoredSettings = Omit<Settings, "autoAcceptBeforeUnload">;

let cache: StoredSettings | null = null;
let accessSet = false;

async function ensureAccessLevel() {
  if (accessSet) return;
  accessSet = true;
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" as chrome.storage.AccessLevel });
  } catch {
    /* older Chrome: default is already trusted-only for MV3 local? best effort */
  }
}

function view(s: StoredSettings): Settings {
  return { ...s, autoAcceptBeforeUnload: s.beforeUnload === "accept" };
}

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    await ensureAccessLevel();
    const raw = (await chrome.storage.local.get("settings")).settings as Record<string, unknown> | undefined;
    cache = migrateSettings(raw);
  }
  return view(cache);
}

export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<Settings> {
  await getSettings();
  const { autoAcceptBeforeUnload: aa, ...rest } = patch;
  // legacy patch keys (old harness / UI) are folded into the new shape
  const merged = migrateSettings({ ...cache!, ...rest, ...(aa !== undefined && !("beforeUnload" in rest) ? { beforeUnload: aa ? "accept" : "dismiss" } : {}) });
  cache = merged;
  await chrome.storage.local.set({ settings: cache });
  return view(cache);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cache = migrateSettings(changes.settings.newValue as Record<string, unknown> | undefined);
});
