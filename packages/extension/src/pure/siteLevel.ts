// What choosing a level for a site in the side panel writes (#118, #131). Used by the add form and
// the row policy select. "full" means full access with no further toggling: it turns on sign-in,
// sign-in without asking (authAuto) and pre-approves every pre-approvable category, except that
// sign-in is never turned on where a hard rule forbids it (AUTH_DENY_HOSTS, VAULT_DENY_HOSTS, the
// user's denylist). Other levels change only the policy, so lowering from full never switches
// anything off silently. f, g, p and r stay non-pre-approvable (D18); authAuto is the per-site
// opt-in that lets g through without a prompt.
import { AUTH_DENY_HOSTS, hostMatches, VAULT_DENY_HOSTS, type PreapprovableCategory, type SiteEntry, type StoredPolicy } from "../background/policy";

export const FULL_PREAPPROVED: readonly PreapprovableCategory[] = ["a", "b", "c", "d", "e"];

/** Shown whenever sign-in without asking is turned on, and next to every site that has it (#131). */
export const AUTH_AUTO_WARNING = "Agents will sign in and enter codes on this site without asking you. Codes on this site may also confirm payments or transfers.";

export interface LevelContext {
  denylist: readonly string[];
}

export interface LevelResult {
  entry: SiteEntry;
  /** Why sign-in was not turned on, for the panel to show. */
  note?: string;
  /** Set when this change newly turned on sign-in without asking. */
  warning?: string;
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Reason sign-in can never be enabled for this origin, or undefined if it can. */
export function authBlockedReason(origin: string, ctx: LevelContext): string | undefined {
  const host = hostOfOrigin(origin);
  if (!host) return `Sign-in was not turned on: ${origin} is not a web origin.`;
  if (VAULT_DENY_HOSTS.some((g) => hostMatches(g, host))) return `Sign-in was not turned on: TabAgent never lets agents open ${host}.`;
  if (AUTH_DENY_HOSTS.some((g) => hostMatches(g, host))) return `Sign-in was not turned on: TabAgent never signs in on ${host}.`;
  if (ctx.denylist.some((g) => hostMatches(g, host))) return `Sign-in was not turned on: ${host} is on the denylist.`;
  return undefined;
}

export function applyLevel(entry: SiteEntry | undefined, level: StoredPolicy | "ask", origin: string, ctx: LevelContext): LevelResult {
  const next: SiteEntry = { ...(entry ?? {}) };
  if (level === "ask") {
    delete next.policy;
    return { entry: next };
  }
  next.policy = level;
  if (level !== "full") return { entry: next };
  next.preapproved = { ...next.preapproved, ...Object.fromEntries(FULL_PREAPPROVED.map((c) => [c, true as const])) };
  const note = authBlockedReason(origin, ctx);
  if (note) return { entry: next, note };
  const wasAuto = next.auth === true && next.authAuto === true;
  next.auth = true;
  next.authAuto = true;
  return wasAuto ? { entry: next } : { entry: next, warning: AUTH_AUTO_WARNING };
}
