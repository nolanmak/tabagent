// Interim permission policy (D17). Pure: plain data in, plain data out. No chrome.*, no I/O.
//
// Until #12 (site policies + prompts) and #13 (sensitive detection) replace this policy, every
// command that reaches the router's authorize() chokepoint is decided by these rules, in order:
//   1. the tab must be owned by the calling session (D9)
//   2. hard denylist: browser pages (chrome://, devtools, ...), extension pages, the Chrome Web Store
//   3. only http(s), file and blank pages
//   4. D18 gated effects (categories a-f) are refused with PERMISSION_DENIED unless the
//      extension setting `devAllowSensitive` is on (off by default; the e2e harness turns it on)
// Everything else is allowed. #12 and #13 replace this policy, not the hook.

export type Level = "read" | "act" | "full";
/** D18 categories: a sensitive form submit, b risky click, c arbitrary JS, d credential read, e local file transfer, f tabs attach. */
export type SensitiveCategory = "a" | "b" | "c" | "d" | "e" | "f";

export const CATEGORY_TEXT: Record<SensitiveCategory, string> = {
  a: "Submitting a form with password, card or SSN-like fields",
  b: "Click that looks like purchase, delete, send or transfer",
  c: "Running arbitrary JavaScript in the page",
  d: "Reading credentials (cookies, storage, network headers/bodies)",
  e: "Transferring a local file (upload or reading a download)",
  f: "Taking over one of your tabs",
};

export interface PolicyState {
  devAllowSensitive?: boolean;
}

/** Who owns the tab a command targets. "none" = the command targets no tab. */
export type TabOwnership = "own" | "other" | "nobody" | "none";

export interface PolicyRequest {
  /** URL being acted on (the tab's current URL or a nav target). "" = no page. */
  url: string;
  /** Required level (D16). Recorded, not enforced: there are no site policies before #12. */
  level: Level | null;
  sensitive?: SensitiveCategory;
  tab: TabOwnership;
}

export type DenyCode = "PERMISSION_DENIED" | "NOT_FOUND" | "TAB_BUSY";

export type Decision = { decision: "allow"; origin: string | null } | { decision: "deny"; code: DenyCode; message: string; hint?: string; origin: string | null };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Hosts that are hard-denied (Chrome blocks extensions there anyway). */
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

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function resolve(state: PolicyState, req: PolicyRequest): Decision {
  const origin = originOf(req.url);
  if (req.tab === "other") {
    return { decision: "deny", code: "TAB_BUSY", origin, message: "The tab belongs to another agent session" };
  }
  if (req.tab === "nobody") {
    return { decision: "deny", code: "NOT_FOUND", origin, message: "The tab is not in this session", hint: "Use tabs action=new to open a tab for this session." };
  }
  if (isHardDenied(req.url)) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent cannot act on browser pages, extension pages or the Chrome Web Store" };
  }
  if (!isBlank(req.url) && !origin) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent only works on http(s) and file pages" };
  }
  if (req.sensitive && !state.devAllowSensitive) {
    return {
      decision: "deny",
      code: "PERMISSION_DENIED",
      origin,
      message: `Refused: ${CATEGORY_TEXT[req.sensitive].toLowerCase()} needs the user's approval, and this TabAgent build cannot ask yet`,
      hint: "Ask the user to do this step by hand.",
    };
  }
  return { decision: "allow", origin };
}
