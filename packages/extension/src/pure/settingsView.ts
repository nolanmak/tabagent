/** Pure agent-facing views of the extension settings: the settings.get snapshot (#105) and settings.change patches (#106). */
import { PREFERENCE_KEYS, type PreferenceChanges, type PreferenceKey, type SettingsSnapshot } from "@tabagent/protocol";
import { AUTH_DENY_HOSTS, authEnabled, VAULT_DENY_HOSTS, type SiteEntry } from "../background/policy";
import type { StoredShape } from "../background/settingsModel";

/** The stored fields the snapshot reads. Anything else (the pairing secret, the port, future keys) is never touched. */
export type SnapshotSource = Pick<StoredShape, "denylist" | "sites" | "yolo" | "devAllowSensitive" | "onSessionEnd" | "beforeUnload" | "showOverlay" | "forceLite" | "liteSites"> & { yoloExpiresAt?: number | null };

function siteView(entry: SiteEntry, origin: string, yolo: boolean): SettingsSnapshot["sites"][string] {
  const out: SettingsSnapshot["sites"][string] = { policy: entry.policy ?? "ask", auth: authEnabled(entry, origin, yolo), lite: !!entry.lite };
  const pre = Object.keys(entry.preapproved ?? {}).sort();
  if (pre.length) out.preapproved = pre;
  // Account ids name the user's vault items; only the count leaves the extension.
  if (entry.authAlways?.length) out.alwaysAccounts = entry.authAlways.length;
  return out;
}

/** settings.get: built field by field from an allowlist, so a new stored key never leaks by default. */
export function settingsSnapshot(s: SnapshotSource): SettingsSnapshot {
  const yolo = !!s.yolo;
  const sites: SettingsSnapshot["sites"] = {};
  for (const [origin, entry] of Object.entries(s.sites ?? {})) sites[origin] = siteView(entry, origin, yolo);
  return {
    denylist: [...s.denylist],
    sites,
    yolo,
    ...(yolo && typeof s.yoloExpiresAt === "number" ? { yoloExpiresAt: s.yoloExpiresAt } : {}),
    devAllowSensitive: !!s.devAllowSensitive,
    onSessionEnd: s.onSessionEnd,
    beforeUnload: s.beforeUnload,
    showOverlay: !!s.showOverlay,
    forceLite: !!s.forceLite,
    liteSites: [...s.liteSites],
    authDenyHosts: [...AUTH_DENY_HOSTS],
    vaultDenyHosts: [...VAULT_DENY_HOSTS],
  };
}

export type PreferenceApplied = { key: PreferenceKey; from: unknown; to: unknown };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * settings.change: the patch to store and what it changes. `changes` has already been checked by
 * checkPreferenceChanges; this still copies only PREFERENCE_KEYS, so nothing else can be patched.
 */
export function applyPreferences(current: Pick<StoredShape, PreferenceKey>, changes: PreferenceChanges): { patch: PreferenceChanges; applied: PreferenceApplied[] } {
  const patch: Record<string, unknown> = {};
  const applied: PreferenceApplied[] = [];
  for (const key of PREFERENCE_KEYS) {
    if (!Object.hasOwn(changes, key) || changes[key] === undefined) continue;
    const to = key === "liteSites" ? [...new Set((changes.liteSites ?? []).map((g) => g.trim().toLowerCase()))] : changes[key];
    patch[key] = to;
    if (!same(current[key], to)) applied.push({ key, from: current[key], to });
  }
  return { patch: patch as PreferenceChanges, applied };
}
