// Extension settings (D32, contract §7). Persistent settings live in
// chrome.storage.local (access level TRUSTED_CONTEXTS so content scripts can't
// read the secret, D7).
import { migrateSettings, type OnSessionEnd, type StoredShape } from "./settingsModel";

export { migrateSettings };
export type { OnSessionEnd };

export type Settings = StoredShape;

let cache: Settings | null = null;
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

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    await ensureAccessLevel();
    const raw = (await chrome.storage.local.get("settings")).settings as Record<string, unknown> | undefined;
    cache = migrateSettings(raw);
  }
  return { ...cache };
}

export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<Settings> {
  await getSettings();
  cache = migrateSettings({ ...cache!, ...patch });
  await chrome.storage.local.set({ settings: cache });
  return { ...cache };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cache = migrateSettings(changes.settings.newValue as Record<string, unknown> | undefined);
});
