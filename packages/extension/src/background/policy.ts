// Pure interim permission policy (D17). No chrome.*, no I/O: plain data in, plain data out.
//
// Until the permission engine (#12) and sensitive confirmation (#13) land, the
// policy behind the router's authorize() chokepoint is:
//   hard deny (chrome://, extension pages, Web Store) -> only http(s)/file pages
//   -> D18 gated effects refused with PERMISSION_DENIED unless devAllowSensitive.
// Session-owned tabs only is enforced by the router's tab resolution (D9).
// #12 and #13 replace this policy, not the hook.

export type Level = "read" | "act" | "full";
/** D18 categories. a/b are detected dynamically by handlers; c-f are static per registry. */
export type SensitiveCategory = "a" | "b" | "c" | "d" | "e" | "f";

export const LEVELS: Level[] = ["read", "act", "full"];

export interface PolicyState {
  /** Extension setting (D32), off by default; the e2e harness turns it on. */
  devAllowSensitive?: boolean;
}

export interface PolicyRequest {
  /** URL being acted on (the tab's current URL, a nav target, or a download's URL). */
  url: string;
  /** Required level; null = not site-scoped. Every level is allowed until #12. */
  level: Level | null;
  sensitive?: SensitiveCategory;
}

export type Decision = { decision: "allow"; origin: string | null } | { decision: "deny"; code: "PERMISSION_DENIED"; message: string; hint?: string; origin: string | null };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Hosts that are hard-denied and cannot be unlocked (Chrome blocks extensions there anyway). */
export const HARD_DENY_HOSTS = ["chromewebstore.google.com"];
const HARD_DENY_SCHEMES = /^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|view-source|about):/i;

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    if (u.protocol === "file:") return "file://";
    return null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Blank pages carry no site data; they are allowed for anything that needs a tab. */
export function isBlank(url: string): boolean {
  return !url || /^about:blank\b/i.test(url) || /^about:srcdoc\b/i.test(url);
}

/** chrome://, extension pages, devtools, the Web Store. Never unlockable. */
export function isHardDenied(url: string): boolean {
  if (isBlank(url)) return false;
  if (HARD_DENY_SCHEMES.test(url)) return true;
  const host = hostOf(url);
  if (HARD_DENY_HOSTS.includes(host)) return true;
  try {
    const u = new URL(url);
    if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** D18 text for a refused gated effect. */
export const CATEGORY_TEXT: Record<SensitiveCategory, string> = {
  a: "Submitting a form with password, card or SSN-like fields",
  b: "Click that looks like purchase, delete, send or transfer",
  c: "Running arbitrary JavaScript in the page",
  d: "Reading credentials (cookies, storage, network headers/bodies)",
  e: "Transferring a local file (upload or reading a download)",
  f: "Taking over one of your tabs",
};

export const SENSITIVE_HINT = "Gated actions are refused until TabAgent can ask the user. A developer can turn on devAllowSensitive in the extension settings.";

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function resolve(state: PolicyState, req: PolicyRequest): Decision {
  const origin = originOf(req.url);
  if (isHardDenied(req.url)) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent cannot act on browser pages, extension pages or the Chrome Web Store" };
  }
  if (!isBlank(req.url) && !origin) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent only works on http(s) and file pages" };
  }
  const cat = req.sensitive;
  if (!cat || state.devAllowSensitive) return { decision: "allow", origin };
  return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `Refused: ${CATEGORY_TEXT[cat].toLowerCase()} (D18 ${cat})`, hint: SENSITIVE_HINT };
}

/** Effective access for display (session.permissions). */
export function effectiveLevel(state: PolicyState, url: string): { origin: string | null; level: Level | "deny"; source: string; sensitiveAllowed: boolean } {
  const origin = originOf(url);
  const sensitiveAllowed = !!state.devAllowSensitive;
  if (isBlank(url)) return { origin: null, level: "full", source: "blank page", sensitiveAllowed };
  if (isHardDenied(url) || !origin) return { origin, level: "deny", source: "restricted browser page", sensitiveAllowed };
  return { origin, level: "full", source: "interim policy (D17): session tabs allowed, gated actions refused unless devAllowSensitive", sensitiveAllowed };
}
