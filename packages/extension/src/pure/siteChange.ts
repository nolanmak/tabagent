/** Pure validation and application for user-approved per-site settings changes (#104). */
import { TabAgentError } from "@tabagent/protocol";
import { AUTH_DENY_HOSTS, authEnabled, hostMatches, isDenylisted, isHardDenied, isVaultDenied, type SiteEntry, type StoredPolicy } from "../background/policy";

/** `policy: "ask"` means "no stored policy", which is how the side panel represents ask. */
export type SitePolicyChoice = StoredPolicy | "ask";
export type SiteChanges = { auth?: boolean; policy?: SitePolicyChoice; lite?: boolean };
export type SiteField = "auth" | "policy" | "lite";
export type SiteChangeApplied = { field: SiteField; from: boolean | SitePolicyChoice; to: boolean | SitePolicyChoice };
export type EffectiveSite = { policy: SitePolicyChoice; lite: boolean; auth: boolean };
export interface SiteChangeState {
  sites: Record<string, SiteEntry>;
  denylist: readonly string[];
  /** Under YOLO, sign-in is on for every origin without an explicit choice (#110). */
  yolo?: boolean;
}

const FIELDS: SiteField[] = ["auth", "policy", "lite"];
const ORIGIN_EXAMPLE = "Pass the exact origin, like https://app.example.com";

/** Exact http(s) origin only: no wildcards, paths, queries, fragments or credentials. */
export function normalizeSiteOrigin(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || /[*?\s]/.test(raw)) throw new TabAgentError("BAD_REQUEST", `policy.site_change needs an exact origin, not a pattern: ${JSON.stringify(raw)}`, ORIGIN_EXAMPLE);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TabAgentError("BAD_REQUEST", `policy.site_change needs an exact origin: ${JSON.stringify(raw)} is not a URL`, ORIGIN_EXAMPLE);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) throw new TabAgentError("BAD_REQUEST", `policy.site_change needs an exact http(s) origin: ${JSON.stringify(raw)}`, ORIGIN_EXAMPLE);
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || /[?#]/.test(raw)) throw new TabAgentError("BAD_REQUEST", `policy.site_change needs an exact origin without a path, query or credentials: ${JSON.stringify(raw)}`, ORIGIN_EXAMPLE);
  return u.origin;
}

export function effectiveSite(entry: SiteEntry | undefined, origin: string, yolo = false): EffectiveSite {
  return { policy: entry?.policy ?? "ask", lite: !!entry?.lite, auth: authEnabled(entry, origin, yolo) };
}

function diff(before: EffectiveSite, changes: SiteChanges): SiteChangeApplied[] {
  return FIELDS.filter((f) => changes[f] !== undefined && changes[f] !== before[f]).map((f) => ({ field: f, from: before[f], to: changes[f]! }));
}

/**
 * Check a request against the hard boundaries and compute what it would change. Runs before the
 * prompt (so the user is never asked about a refused request) and again after approval.
 */
export function checkSiteChange(state: SiteChangeState, rawOrigin: string, changes: SiteChanges): { origin: string; applied: SiteChangeApplied[] } {
  const origin = normalizeSiteOrigin(rawOrigin);
  if (!changes || !FIELDS.some((f) => changes[f] !== undefined)) throw new TabAgentError("BAD_REQUEST", "policy.site_change needs at least one of changes.auth, changes.policy or changes.lite");
  const host = new URL(origin).hostname;
  if (isHardDenied(origin)) throw new TabAgentError("PERMISSION_DENIED", `TabAgent cannot act on ${host}, so its site settings cannot be changed`);
  if (isVaultDenied(origin)) throw new TabAgentError("PERMISSION_DENIED", `TabAgent never lets agents open ${host} (saved passwords, account or mail); its site settings cannot be changed`);
  if (AUTH_DENY_HOSTS.some((g) => hostMatches(g, host))) throw new TabAgentError("PERMISSION_DENIED", `TabAgent never signs in on ${host}; its site settings cannot be changed by an agent`, "The user can still change this site in the TabAgent side panel.");
  if (isDenylisted(origin, [...state.denylist])) {
    throw new TabAgentError("PERMISSION_DENIED", `${host} is on the TabAgent denylist; its site settings cannot be changed while it is blocked`, "Request a policy.denylist_change that removes it first, then request this site change again.");
  }
  const applied = diff(effectiveSite(state.sites[origin], origin, !!state.yolo), changes);
  if (!applied.length) throw new TabAgentError("BAD_REQUEST", `Nothing to change: ${origin} already has these settings`, "Check session.permissions for the current site settings.");
  return { origin, applied };
}

/** Apply exactly like the side panel does. Returns new objects; the input is not mutated. */
export function applySiteChange(sites: Record<string, SiteEntry>, origin: string, changes: SiteChanges, yolo = false): { sites: Record<string, SiteEntry>; site: EffectiveSite; applied: SiteChangeApplied[] } {
  const before = effectiveSite(sites[origin], origin, yolo);
  const entry: SiteEntry = structuredClone(sites[origin] ?? {});
  if (changes.policy !== undefined) {
    if (changes.policy === "ask") delete entry.policy;
    else entry.policy = changes.policy;
  }
  if (changes.lite !== undefined) {
    if (changes.lite) entry.lite = true;
    else delete entry.lite;
  }
  if (changes.auth !== undefined) {
    if (changes.auth) entry.auth = true;
    else {
      // A default-on origin (or any origin under YOLO) needs an explicit false to stay off (#79, #110);
      // "Always" accounts go with it.
      if (authEnabled({}, origin, yolo)) entry.auth = false;
      else delete entry.auth;
      delete entry.authAlways;
    }
  }
  const next = { ...sites };
  if (Object.keys(entry).length) next[origin] = entry;
  else delete next[origin];
  return { sites: next, site: effectiveSite(entry, origin, yolo), applied: diff(before, changes) };
}

/** What the approval was shown against: this origin's entry, the denylist (which gates it) and YOLO (which changes effective sign-in). */
export function siteChangeSnapshot(state: SiteChangeState, origin: string): string {
  const e = state.sites[origin] ?? {};
  const pre = e.preapproved ? Object.keys(e.preapproved).sort() : [];
  const entry = { policy: e.policy ?? null, lite: !!e.lite, auth: e.auth ?? null, authAlways: [...(e.authAlways ?? [])].sort(), preapproved: pre };
  const denylist = state.denylist.map((g) => g.trim().toLowerCase()).filter(Boolean).sort();
  return JSON.stringify([origin, entry, denylist, !!state.yolo]);
}

/** The text the approval prompt shows: the origin, each change and the reason. */
export function describeSiteChange(p: { origin?: unknown; changes?: SiteChanges; reason?: unknown }): string {
  let origin = String(p.origin ?? "");
  try {
    origin = normalizeSiteOrigin(origin);
  } catch {
    /* show what the agent sent; the precheck has already refused it */
  }
  const c = p.changes ?? {};
  const parts: string[] = [];
  if (c.auth !== undefined) parts.push(`turn sign-in ${c.auth ? "on" : "off"}`);
  if (c.policy !== undefined) parts.push(c.policy === "ask" ? "set policy to ask (remove the saved policy)" : `set policy to ${c.policy}`);
  if (c.lite !== undefined) parts.push(`turn lite mode ${c.lite ? "on" : "off"}`);
  return `change site settings for ${origin}: ${parts.join(", ")}; reason: ${String(p.reason ?? "").slice(0, 160)}`;
}
