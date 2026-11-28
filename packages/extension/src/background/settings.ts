// Extension settings (D32, contract §7). Persistent settings live in
// chrome.storage.local (access level TRUSTED_CONTEXTS so content scripts can't
// read the secret, D7). The paused flag is session state (chrome.storage.session, D11).
import { hostMatches, hostOf, isBlank, originOf, type SiteEntry } from "./policy";
import { migrateSettings, SEEDED_DENYLIST, type BeforeUnload, type OnSessionEnd } from "./settingsModel";
import { yoloExpired } from "../pure/modeChange";

export { SEEDED_DENYLIST, migrateSettings };
export type { BeforeUnload, OnSessionEnd };

export interface Settings {
  port: number;
  secret: string | null;
  sites: Record<string, SiteEntry>;
  denylist: string[];
  devAllowSensitive: boolean;
  yolo: boolean;
  /** Epoch ms when YOLO switches itself off (#109); null = no expiry. */
  yoloExpiresAt: number | null;
  onSessionEnd: OnSessionEnd;
  beforeUnload: BeforeUnload;
  showOverlay: boolean;
  /** Kill switch engaged (session state, not persisted across browser restarts). */
  paused: boolean;
  /** Lite mode everywhere (debug aid; per-origin lite lives in `sites`). */
  forceLite: boolean;
  /** @deprecated host globs in lite mode; use sites[origin].lite. Still honoured by liteForUrl. */
  liteSites: string[];
  /** @deprecated derived from beforeUnload === "accept"; read by older cdp.ts. */
  autoAcceptBeforeUnload: boolean;
  /** @deprecated derived: origins with any pre-approval. */
  sensitiveAllowed: Record<string, boolean>;
}

export type StoredSettings = Omit<Settings, "paused" | "autoAcceptBeforeUnload" | "sensitiveAllowed">;

let cache: StoredSettings | null = null;
/** e2e only (#109): shifts the clock YOLO expiry is checked against. */
let clockOffset = 0;
let yoloExpiredListener: ((expiresAt: number) => void) | null = null;

/** The clock YOLO expiry uses. */
export function settingsNow(): number {
  return Date.now() + clockOffset;
}
export function setSettingsClockOffset(ms: number) {
  clockOffset = Number(ms) || 0;
}
/** Called once each time a timed YOLO switches itself off. */
export function onYoloExpired(fn: (expiresAt: number) => void) {
  yoloExpiredListener = fn;
}

/**
 * A timed YOLO is off once its expiry has passed, whether or not the alarm has fired yet (#109). The
 * expiry is a stored timestamp, so this also holds after a worker or browser restart.
 */
async function enforceYoloExpiry() {
  if (!cache || !yoloExpired(cache, settingsNow())) return;
  const expiresAt = cache.yoloExpiresAt as number;
  cache = { ...cache, yolo: false, yoloExpiresAt: null };
  await chrome.storage.local.set({ settings: cache });
  yoloExpiredListener?.(expiresAt);
}
let paused: boolean | null = null;
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
  const sensitiveAllowed: Record<string, boolean> = {};
  for (const [o, e] of Object.entries(s.sites)) if (e.preapproved && Object.keys(e.preapproved).length) sensitiveAllowed[o] = true;
  // older driver code reads liteSites host globs: expose per-origin lite there too
  const liteHosts = Object.entries(s.sites)
    .filter(([, e]) => e.lite)
    .map(([o]) => hostOf(o))
    .filter(Boolean);
  const liteSites = [...new Set([...s.liteSites, ...liteHosts])];
  return { ...s, liteSites, paused: !!paused, autoAcceptBeforeUnload: s.beforeUnload === "accept", sensitiveAllowed };
}

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    await ensureAccessLevel();
    const raw = (await chrome.storage.local.get("settings")).settings as Record<string, unknown> | undefined;
    cache = migrateSettings(raw);
  }
  await enforceYoloExpiry();
  if (paused == null) {
    try {
      paused = !!(await chrome.storage.session.get("paused")).paused;
    } catch {
      paused = false;
    }
  }
  return view(cache);
}

/** The stored settings as persisted (no derived fields, liteSites exactly as stored). A copy. */
export async function getStoredSettings(): Promise<StoredSettings> {
  await getSettings();
  return structuredClone(cache!);
}

export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<Settings> {
  await getSettings();
  const { paused: p, autoAcceptBeforeUnload: aa, sensitiveAllowed: _sa, ...rest } = patch;
  if (p !== undefined) {
    paused = !!p;
    await chrome.storage.session.set({ paused });
  }
  // legacy patch keys (old harness / UI) are folded into the new shape
  const merged = migrateSettings({ ...cache!, ...rest, ...(aa !== undefined && !("beforeUnload" in rest) ? { beforeUnload: aa ? "accept" : "dismiss" } : {}) });
  cache = merged;
  await chrome.storage.local.set({ settings: cache });
  return view(cache);
}

export async function isPaused(): Promise<boolean> {
  return (await getSettings()).paused;
}

/** Whether a URL should be driven in lite mode (no chrome.debugger). Used by driverFor. */
export async function liteForUrl(url: string): Promise<boolean> {
  const s = await getSettings();
  if (s.forceLite) return true;
  if (isBlank(url)) return false;
  const o = originOf(url);
  if (o && s.sites[o]?.lite) return true;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return !!host && s.liteSites.some((g) => hostMatches(g, host));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cache = migrateSettings(changes.settings.newValue as Record<string, unknown> | undefined);
  if (area === "session" && changes.paused) paused = !!changes.paused.newValue;
});
