// Pure permission engine (D16). No chrome.*, no I/O: plain data in, plain data out.
//
// Evaluation order for every command:
//   paused (D12) -> hard deny -> denylist -> token scope (D3) -> site policy / session grant / ask -> sensitive gate (D18)
// "ask" is not a stored level: it is the absence of a policy.

export type Level = "read" | "act" | "full";
export type StoredPolicy = Level | "deny";
/** D18 categories. a/b are detected dynamically by handlers; c-f are static per registry. */
export type SensitiveCategory = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "p" | "r";
/** a-e pre-approve per origin; f (attach), g (auth), p (policy) never persist a grant. */
export type PreapprovableCategory = Exclude<SensitiveCategory, "f" | "g" | "p" | "r">;

export const LEVELS: Level[] = ["read", "act", "full"];
export const RANK: Record<StoredPolicy, number> = { deny: 0, read: 1, act: 2, full: 3 };

export interface SiteEntry {
  policy?: StoredPolicy;
  lite?: boolean;
  preapproved?: Partial<Record<PreapprovableCategory, true>>;
  /** M6: sign-in (category g) is enabled for this origin. Off by default. */
  auth?: boolean;
  /** M6: account ids the user said "Always" to for sign-in on this origin. */
  authAlways?: string[];
  /**
   * #131: sign in without asking. Category g on this exact origin is allowed with no prompt. Only
   * honoured with an explicit `auth: true`, never on AUTH_DENY_HOSTS, vault or denylisted hosts.
   */
  authAuto?: boolean;
}

/** Per-session answers ("Allow once" / "Deny"), keyed by origin. */
export interface SessionGrant {
  /** Highest level allowed once for this session. */
  once?: Level;
  /** Lowest level the user denied for this session; requests at or above it are denied. */
  denied?: Level;
}

export interface PolicyState {
  paused: boolean;
  sites: Record<string, SiteEntry>;
  denylist: string[];
  /** sessionId -> origin -> grant */
  grants: Record<string, Record<string, SessionGrant>>;
  devAllowSensitive?: boolean;
  /** YOLO mode: every site is allowed (up to the token cap) and sensitive a-e pass without asking. */
  yolo?: boolean;
}

export interface PolicyRequest {
  sessionId: string;
  /** Token cap (D3). */
  cap: Level;
  /** Token site globs; empty = no limit. */
  sites: string[];
  /** URL being acted on (the tab's current URL, a nav target, or a frame URL). */
  url: string;
  /** Required level; null = not site-scoped (still subject to paused + hard deny). */
  level: Level | null;
  sensitive?: SensitiveCategory;
  /** Category g: the account being signed in with. */
  accountId?: string;
  /** Category g: a sign-up (#112). Asked every time; neither Always nor authAuto skips it. */
  signup?: boolean;
}

export type DenyCode = "PERMISSION_DENIED" | "KILLED";

export type Decision =
  | { decision: "allow"; origin: string | null; via?: "authAuto" }
  | { decision: "deny"; code: DenyCode; message: string; hint?: string; origin: string | null }
  | { decision: "ask"; kind: "site"; origin: string; level: Level; reason?: string }
  | { decision: "ask"; kind: "sensitive"; origin: string; category: SensitiveCategory };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Hosts that are hard-denied and cannot be unlocked (Chrome blocks extensions there anyway). */
export const HARD_DENY_HOSTS = ["chromewebstore.google.com"];
const HARD_DENY_SCHEMES = /^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|view-source|about):/i;

/**
 * DA12 (review M3): where saved passwords, the Google account and the mailbox live. Not part of
 * the editable denylist: nothing (YOLO, site policy, a denylist edit) opens these to an agent.
 * Auth email codes (DA7) are read by the extension itself, not through agent tools.
 */
export const VAULT_DENY_HOSTS = [
  "passwords.google.com",
  "myaccount.google.com",
  "mail.google.com",
  "*.1password.com",
  "*.1password.eu",
  "*.1password.ca",
  "*.bitwarden.com",
  "*.bitwarden.eu",
  "*.lastpass.com",
  "*.dashlane.com",
  "*.keepersecurity.com",
  "*.keepersecurity.eu",
];

export function isVaultDenied(url: string): boolean {
  const h = hostOf(url);
  return !!h && VAULT_DENY_HOSTS.some((g) => hostMatches(g, h));
}

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

/** `*.github.com` matches `github.com` and every subdomain; `*` matches all. */
export function hostMatches(glob: string, host: string): boolean {
  const g = glob.trim().toLowerCase();
  const h = host.toLowerCase();
  if (!g || !h) return false;
  if (g === "*") return true;
  if (g.startsWith("*.")) {
    const base = g.slice(2);
    return h === base || h.endsWith("." + base);
  }
  return h === g;
}

export function isDenylisted(url: string, denylist: string[]): boolean {
  const h = hostOf(url);
  return !!h && denylist.some((g) => hostMatches(g, h));
}

function minLevel(a: Level, b: Level): Level {
  return RANK[a] <= RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function resolve(state: PolicyState, req: PolicyRequest): Decision {
  const origin = originOf(req.url);
  if (state.paused) {
    return { decision: "deny", code: "KILLED", origin, message: "The user stopped all agents with the TabAgent kill switch", hint: "Ask the user to press Resume in the TabAgent side panel." };
  }
  if (isHardDenied(req.url)) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent cannot act on browser pages, extension pages or the Chrome Web Store" };
  }
  const blank = isBlank(req.url);
  if (!blank && !origin) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "TabAgent only works on http(s) and file pages" };
  }
  if (!blank && isVaultDenied(req.url)) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `TabAgent never lets agents open ${hostOf(req.url)} (saved passwords, account or mail)` };
  }
  if (!blank && isDenylisted(req.url, state.denylist)) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `${hostOf(req.url)} is on the TabAgent denylist`, hint: "The user can edit the denylist in the TabAgent side panel." };
  }
  // token scope
  if (req.level && RANK[req.level] > RANK[req.cap]) {
    return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `This client's token is limited to "${req.cap}" but ${req.level} access is needed`, hint: "Create a token with a higher --caps." };
  }
  if (!blank && req.sites.length) {
    const h = hostOf(req.url);
    if (!req.sites.some((g) => hostMatches(g, h))) {
      return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `This client's token is not allowed on ${h}`, hint: `Allowed sites: ${req.sites.join(", ")}` };
    }
  }
  if (blank || !origin) return sensitiveStep(state, req, origin);

  // site policy / session grant / ask
  if (req.level) {
    const stored = state.sites[origin]?.policy;
    const g = state.grants[req.sessionId]?.[origin];
    if (stored === "deny") {
      return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `${origin} is set to deny`, hint: "The user can change this in the TabAgent side panel." };
    }
    if (g?.denied && RANK[req.level] >= RANK[g.denied]) {
      return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `The user denied ${req.level} access to ${origin} for this session` };
    }
    const ok = state.yolo || (stored && RANK[stored] >= RANK[req.level]) || (g?.once && RANK[g.once] >= RANK[req.level]);
    if (!ok) {
      return { decision: "ask", kind: "site", origin, level: req.level, ...(stored ? { reason: `Site is set to "${stored}"; ${req.level} needs more access` } : {}) };
    }
  }
  return sensitiveStep(state, req, origin);
}

/**
 * Sign-in is never automated on banking / password-manager hosts, even if the user edits the denylist (M6).
 * accounts.google.com is not here (#81): Google sign-in is unlockable by the user, who must remove it from the
 * seeded denylist and enable sign-in for that origin. Google account pages stay in VAULT_DENY_HOSTS (DA12).
 */
/** Origins where sign-in is on unless the user turned it off (#79). The denylist still gates them. */
export const AUTH_DEFAULT_ON_ORIGINS = ["https://accounts.google.com"];
/** Sign-in enablement for an origin: the user's explicit choice, else on under YOLO (#110) or for the default-on list. */
export function authEnabled(e: { auth?: boolean } | undefined, origin: string, yolo = false): boolean {
  return e?.auth ?? (yolo || AUTH_DEFAULT_ON_ORIGINS.includes(origin));
}

export const AUTH_DENY_HOSTS = ["*.chase.com", "*.bankofamerica.com", "*.wellsfargo.com", "*.citi.com", "*.capitalone.com", "*.mercury.com", "*.paypal.com", "*.1password.com", "*.lastpass.com", "*.bitwarden.com", "*.dashlane.com", "*.keepersecurity.com"];

/** Sign-in can never be automated for this URL's host: AUTH_DENY_HOSTS, vault hosts or the user's denylist. */
export function authHostBlocked(url: string, denylist: readonly string[]): boolean {
  const h = hostOf(url);
  return !h || AUTH_DENY_HOSTS.some((g) => hostMatches(g, h)) || isVaultDenied(url) || isDenylisted(url, [...denylist]);
}

/**
 * #131: the site signs in without asking. Needs the flag and an explicit `auth: true` (not the
 * default-on list, not YOLO), and the host is re-checked here, at use time, so a later denylist
 * entry wins over a stored flag.
 */
export function authAutoAllowed(e: SiteEntry | undefined, url: string, denylist: readonly string[]): boolean {
  return e?.auth === true && e.authAuto === true && !authHostBlocked(url, denylist);
}

function sensitiveStep(state: PolicyState, req: PolicyRequest, origin: string | null): Decision {
  const cat = req.sensitive;
  if (!cat) return { decision: "allow", origin };
  if (cat === "g") {
    if (!origin) return { decision: "deny", code: "PERMISSION_DENIED", origin, message: "Sign-in needs an http(s) page" };
    if (AUTH_DENY_HOSTS.some((g) => hostMatches(g, hostOf(req.url)))) return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `TabAgent never signs in on ${hostOf(req.url)}` };
    const e = state.sites[origin];
    if (!authEnabled(e, origin, state.yolo)) return { decision: "deny", code: "PERMISSION_DENIED", origin, message: `Sign-in is not enabled for ${origin}`, hint: "The user can enable sign-in for this site in the TabAgent side panel." };
    if (req.signup) return { decision: "ask", kind: "sensitive", origin, category: "g" };
    if (req.accountId && e?.authAlways?.includes(req.accountId)) return { decision: "allow", origin };
    if (authAutoAllowed(e, req.url, state.denylist)) return { decision: "allow", origin, via: "authAuto" };
    return { decision: "ask", kind: "sensitive", origin, category: "g" };
  }
  const key = origin ?? (isBlank(req.url) ? "about:blank" : req.url);
  if (cat !== "f" && cat !== "p" && cat !== "r") {
    if (state.devAllowSensitive || state.yolo) return { decision: "allow", origin };
    if (origin && state.sites[origin]?.preapproved?.[cat]) return { decision: "allow", origin };
  }
  return { decision: "ask", kind: "sensitive", origin: key, category: cat };
}

// ---------------------------------------------------------------------------
// Applying answers (pure state transitions)
// ---------------------------------------------------------------------------

export type Answer = "once" | "always" | "deny";

/** Site prompt answer -> new state. Always stores exactly the requested level. */
export function applySiteAnswer(state: PolicyState, sessionId: string, origin: string, level: Level, answer: Answer): PolicyState {
  if (answer === "always") {
    return { ...state, sites: { ...state.sites, [origin]: { ...state.sites[origin], policy: level } } };
  }
  const sess = { ...(state.grants[sessionId] ?? {}) };
  const cur = { ...(sess[origin] ?? {}) };
  if (answer === "once") {
    cur.once = cur.once && RANK[cur.once] >= RANK[level] ? cur.once : level;
  } else {
    cur.denied = cur.denied ? minLevel(cur.denied, level) : level;
  }
  sess[origin] = cur;
  return { ...state, grants: { ...state.grants, [sessionId]: sess } };
}

/** Sensitive prompt answer: only "always" changes state (per-origin per-category pre-approval, never f). */
export function applySensitiveAnswer(state: PolicyState, origin: string, category: SensitiveCategory, answer: Answer, accountId?: string): PolicyState {
  if (answer !== "always" || category === "f" || category === "p" || category === "r" || !originOf(origin)) return state;
  if (category === "g") {
    if (!accountId) return state;
    const e = state.sites[origin] ?? {};
    const list = e.authAlways ?? [];
    return list.includes(accountId) ? state : { ...state, sites: { ...state.sites, [origin]: { ...e, authAlways: [...list, accountId] } } };
  }
  const e = state.sites[origin] ?? {};
  return { ...state, sites: { ...state.sites, [origin]: { ...e, preapproved: { ...e.preapproved, [category]: true } } } };
}

export function clearSessionGrants(state: PolicyState, sessionId?: string): PolicyState {
  if (sessionId == null) return { ...state, grants: {} };
  const { [sessionId]: _drop, ...rest } = state.grants;
  return { ...state, grants: rest };
}

/** Effective level for display (session.permissions). */
export function effectiveLevel(state: PolicyState, req: Omit<PolicyRequest, "level" | "sensitive">): { origin: string | null; level: StoredPolicy | "ask"; source: string } {
  const origin = originOf(req.url);
  if (isBlank(req.url)) return { origin: null, level: req.cap, source: "blank page" };
  if (isHardDenied(req.url) || !origin) return { origin, level: "deny", source: "restricted browser page" };
  if (isVaultDenied(req.url)) return { origin, level: "deny", source: "password, account and mail sites" };
  if (isDenylisted(req.url, state.denylist)) return { origin, level: "deny", source: "denylist" };
  if (req.sites.length && !req.sites.some((g) => hostMatches(g, hostOf(req.url)))) return { origin, level: "deny", source: "token site scope" };
  const stored = state.sites[origin]?.policy;
  const g = state.grants[req.sessionId]?.[origin];
  let lvl: StoredPolicy | "ask" = stored ?? "ask";
  let source = stored ? "site policy" : "no policy (ask)";
  if (g?.once && (lvl === "ask" || (lvl !== "deny" && RANK[g.once] > RANK[lvl]))) {
    lvl = g.once;
    source = "allowed once for this session";
  }
  if (state.yolo && lvl !== "deny") {
    lvl = "full";
    source = "YOLO mode";
  }
  if (lvl !== "ask" && lvl !== "deny") {
    const capped = minLevel(lvl, req.cap);
    if (capped !== lvl) source += ` (token cap ${req.cap})`;
    lvl = capped;
  }
  return { origin, level: lvl, source };
}
