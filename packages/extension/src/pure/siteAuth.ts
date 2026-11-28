// The side panel's Sign-in column (#131): sign-in allowed, sign in without asking (authAuto),
// always allow texted/emailed codes, and the per-account Always grants with a remove each.
// Pure: entry in, new entry out (the input is never mutated).
import { AUTH_DEFAULT_ON_ORIGINS, authAutoAllowed, type SiteEntry } from "../background/policy";
import { AUTH_AUTO_WARNING, authBlockedReason, type LevelContext } from "./siteLevel";

/** The pseudo-accounts auth.code uses for texted and emailed codes (auth/pure/flows.ts). */
export const CODE_SOURCE_IDS = ["code-source:sms", "code-source:email"] as const;

export interface SiteAuthContext extends LevelContext {
  yolo?: boolean;
}

export interface SiteAuthResult {
  entry: SiteEntry;
  /** Why the change was refused. */
  note?: string;
  warning?: string;
}

const WORDS: Record<string, string> = {
  "code-source:sms": "texted codes",
  "code-source:email": "emailed codes",
  "confirm-link:email": "email confirmation links",
  "chrome-autofill:saved": "Chrome saved password",
};

function mask(id: string): string {
  return id.length > 6 ? `${id.slice(0, 2)}•••${id.slice(-2)}` : "••••";
}

/** What an Always grant is called in the panel. Real account ids are masked. */
export function alwaysLabel(id: string): string {
  if (WORDS[id]) return WORDS[id];
  const i = id.indexOf(":");
  return i > 0 ? `${id.slice(0, i)} ${mask(id.slice(i + 1))}` : `account ${mask("")}`;
}

/** Sign-in allowed. Off also clears the Always grants and sign-in without asking. */
export function setSignIn(entry: SiteEntry | undefined, on: boolean, origin: string, ctx: SiteAuthContext): SiteEntry {
  const next: SiteEntry = { ...(entry ?? {}) };
  if (on) {
    next.auth = true;
    return next;
  }
  // A default-on origin (Google), or any origin under YOLO, needs an explicit false to stay off.
  if (ctx.yolo || AUTH_DEFAULT_ON_ORIGINS.includes(origin)) next.auth = false;
  else delete next.auth;
  delete next.authAlways;
  delete next.authAuto;
  return next;
}

/** Sign in without asking. On also turns sign-in on; refused where sign-in is never automated. */
export function setAuthAuto(entry: SiteEntry | undefined, on: boolean, origin: string, ctx: SiteAuthContext): SiteAuthResult {
  const next: SiteEntry = { ...(entry ?? {}) };
  if (!on) {
    delete next.authAuto;
    return { entry: next };
  }
  const note = authBlockedReason(origin, ctx);
  if (note) return { entry: next, note: note.replace("Sign-in was not turned on", "Sign-in without asking was not turned on") };
  next.auth = true;
  next.authAuto = true;
  return { entry: next, warning: AUTH_AUTO_WARNING };
}

export function hasCodesAlways(entry: SiteEntry | undefined): boolean {
  return CODE_SOURCE_IDS.every((id) => entry?.authAlways?.includes(id));
}

/** Always allow texted/emailed codes: adds or removes both code pseudo-accounts. On also turns sign-in on. */
export function setCodesAlways(entry: SiteEntry | undefined, on: boolean, origin: string, ctx: SiteAuthContext): SiteAuthResult {
  const next: SiteEntry = { ...(entry ?? {}) };
  if (on) {
    const note = authBlockedReason(origin, ctx);
    if (note) return { entry: next, note: note.replace("Sign-in was not turned on", "Codes were not allowed") };
    const list = next.authAlways ?? [];
    next.auth = true;
    next.authAlways = [...list, ...CODE_SOURCE_IDS.filter((id) => !list.includes(id))];
    return { entry: next };
  }
  const rest = (next.authAlways ?? []).filter((id) => !(CODE_SOURCE_IDS as readonly string[]).includes(id));
  if (rest.length) next.authAlways = rest;
  else delete next.authAlways;
  return { entry: next };
}

/** Remove one Always grant. */
export function revokeAlways(entry: SiteEntry | undefined, id: string): SiteEntry {
  const next: SiteEntry = { ...(entry ?? {}) };
  const rest = (next.authAlways ?? []).filter((x) => x !== id);
  if (rest.length) next.authAlways = rest;
  else delete next.authAlways;
  return next;
}

/** Whether the gate will honour this site's sign-in without asking right now. */
export function authAutoActive(entry: SiteEntry | undefined, origin: string, ctx: LevelContext): boolean {
  return authAutoAllowed(entry, origin, ctx.denylist);
}
