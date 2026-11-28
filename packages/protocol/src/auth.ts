// M6 auth (#31-#36): registry entries for the `auth` group, the bridge<->extension secret-channel wire
// (DA2), masking, and the DA3 origin-binding matcher. Shared by bridge and extension.
//
// The one rule: a secret never enters the agent's context. Every `secret: true` tool has a strict result
// schema whose string leaves are enums, masked accounts or opaque account ids (DA1); the registry test
// enforces it.
//
// Only type imports from ./registry: registry.ts imports this file, so runtime imports back would cycle.
import { z } from "zod";
import { ERROR_CODES } from "./errors";
import { TIMEOUTS } from "./messages";
import type { ToolDef } from "./registry";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** DA5 providers. `chrome-autofill` lives in the extension (#32); the others in the bridge. */
export const AUTH_PROVIDERS = ["chrome-autofill", "1password", "bitwarden"] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];
export const BRIDGE_PROVIDERS = ["1password", "bitwarden"] as const satisfies readonly AuthProviderName[];

/** Code sources for auth.code (#34, #36). */
export const CODE_SOURCES = ["totp", "email", "sms"] as const;
export type CodeSourceName = (typeof CODE_SOURCES)[number];

/** Fields a `secret` message can carry. A TOTP request (`field: "totp"`) is answered with `field: "code"` (#37). */
export const SECRET_FIELDS = ["username", "password", "code"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** DA9: a handoff waits up to 5 minutes for the user. */
export const AUTH_HANDOFF_TIMEOUT = 5 * 60_000;

// ---------------------------------------------------------------------------
// Masking and account ids
// ---------------------------------------------------------------------------

const BULLETS = "•••";

/**
 * Mask an account name for display: `nolan@gmail.com` → `n•••@gmail.com`, `nolanmak7@gmail.com` →
 * `nol•••k7@gmail.com`. A local part of 7+ characters keeps its first 3 and last 2 (#82 D10, so several
 * logins on one domain can be told apart); shorter ones keep at most the first and last character.
 */
export function maskAccount(account: string | null | undefined): string {
  const a = (account ?? "").trim();
  if (!a) return BULLETS;
  const at = a.lastIndexOf("@");
  if (at > 0) {
    const domain = a.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, "").slice(0, 253);
    const local = [...a.slice(0, at)];
    const shown = local.length >= LONG_LOCAL && allSafe(local) ? `${safeChars(local.slice(0, 3))}${BULLETS}${safeChars(local.slice(-2))}` : `${firstChar(a)}${BULLETS}`;
    return `${shown}${domain ? "@" + domain : ""}`;
  }
  const chars = [...a];
  if (chars.length >= LONG_LOCAL && allSafe(chars)) return `${safeChars(chars.slice(0, 3))}${BULLETS}${safeChars(chars.slice(-2))}`;
  return chars.length <= 2 ? `${firstChar(a)}${BULLETS}` : `${firstChar(a)}${BULLETS}${safeChar(chars[chars.length - 1])}`;
}
const LONG_LOCAL = 7;
/** The longer mask is only for plain names; anything with markup or odd characters keeps the short one. */
function allSafe(cs: string[]): boolean {
  return cs.every((c) => safeChar(c) !== "");
}
function safeChars(cs: string[]): string {
  return cs.map(safeChar).join("");
}
function firstChar(s: string): string {
  return safeChar([...s][0] ?? "");
}
function safeChar(c: string): string {
  return /^[\p{L}\p{N}_.+-]$/u.test(c) ? c : "";
}

/** What maskAccount can produce, and nothing longer: the DA1 shape of every account string in a result. */
export const MASKED_ACCOUNT_RE = /^[\p{L}\p{N}_.+-]{0,3}•••[\p{L}\p{N}_.+-]{0,2}(@[A-Za-z0-9.-]{1,253})?$/u;

/** Account ids on the wire: `<provider>:<provider-local id>`. Opaque, never a username. */
export const ACCOUNT_ID_RE = /^(chrome-autofill|1password|bitwarden):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Provider-local ids passed to `op` / `bw` (also blocks `--flag` injection). */
export const LOCAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function accountId(provider: AuthProviderName, localId: string): string {
  if (!LOCAL_ID_RE.test(localId)) throw new Error(`Bad ${provider} item id`);
  return `${provider}:${localId}`;
}
export function parseAccountId(id: string): { provider: AuthProviderName; localId: string } | null {
  if (!ACCOUNT_ID_RE.test(id)) return null;
  const i = id.indexOf(":");
  return { provider: id.slice(0, i) as AuthProviderName, localId: id.slice(i + 1) };
}

/** Marks a string leaf in a secret tool's result as safe (DA1). The registry test requires one of these. */
export type AuthSafeKind = "masked" | "accountId";
const maskedAccount = () => z.string().regex(MASKED_ACCOUNT_RE).meta({ authSafe: "masked" satisfies AuthSafeKind });
const accountIdString = () => z.string().regex(ACCOUNT_ID_RE).meta({ authSafe: "accountId" satisfies AuthSafeKind });
export function authSafeKind(s: z.ZodType): AuthSafeKind | undefined {
  return (s.meta() as { authSafe?: AuthSafeKind } | undefined)?.authSafe;
}

// ---------------------------------------------------------------------------
// DA3 origin binding: registrable domain, https only
// ---------------------------------------------------------------------------

/**
 * Multi-label public suffixes we know about. A small, deliberate subset of the Public Suffix List: the
 * common country second levels, plus private suffixes where unrelated parties share a parent domain
 * (an item saved for alice.github.io must not fill bob.github.io). Unknown suffixes fall back to "last
 * two labels", which is the safe direction for single-label TLDs and the common case for the rest.
 */
export const MULTI_LABEL_SUFFIXES = new Set([
  // country second levels
  ...["co", "ac", "gov", "org", "net", "ltd", "plc", "me", "nhs", "sch", "police"].map((s) => `${s}.uk`),
  ...["com", "net", "org", "edu", "gov", "asn", "id"].map((s) => `${s}.au`),
  ...["co", "or", "ne", "ac", "go", "ed", "gr", "lg", "ad"].map((s) => `${s}.jp`),
  ...["co", "or", "ne", "ac", "go", "re", "pe"].map((s) => `${s}.kr`),
  ...["com", "net", "org", "gov", "edu"].map((s) => `${s}.cn`),
  ...["com", "net", "org", "gov", "edu", "idv"].map((s) => `${s}.tw`),
  ...["com", "net", "org", "gov", "edu", "idv"].map((s) => `${s}.hk`),
  ...["com", "net", "org", "gov", "edu", "per"].map((s) => `${s}.sg`),
  ...["com", "net", "org", "gov", "edu", "mil"].map((s) => `${s}.br`),
  ...["com", "net", "org", "gob", "edu"].map((s) => `${s}.mx`),
  ...["com", "net", "org", "gob", "edu"].map((s) => `${s}.ar`),
  ...["co", "org", "gov", "ac", "net", "edu"].map((s) => `${s}.za`),
  ...["co", "org", "gov", "ac", "net", "res", "firm", "gen", "ind"].map((s) => `${s}.in`),
  ...["co", "org", "net", "ac", "govt", "school", "gen", "geek", "kiwi"].map((s) => `${s}.nz`),
  ...["co", "or", "ac", "go", "ne"].map((s) => `${s}.id`),
  ...["com", "net", "org", "gov", "edu"].map((s) => `${s}.tr`),
  ...["co", "org", "ac", "gov", "net", "muni"].map((s) => `${s}.il`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.my`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.ph`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.vn`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.ua`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.eg`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.sa`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.pk`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.ng`),
  ...["co", "or", "ac", "go", "ne"].map((s) => `${s}.ke`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.pl`),
  "co.at", "or.at", "gv.at", "ac.at", "com.es", "org.es", "nom.es", "com.pt", "com.gr", "com.ru", "com.co", "com.pe", "com.ve", "com.uy", "com.ec",
  // private suffixes: many unrelated tenants under one parent
  "github.io", "githubusercontent.com", "gitlab.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com",
  "elasticbeanstalk.com", "onrender.com", "fly.dev", "glitch.me", "repl.co", "replit.app", "ngrok.io", "ngrok-free.app",
  "myshopify.com", "wixsite.com", "squarespace.com", "wordpress.com", "tumblr.com", "substack.com", "notion.site",
  "readthedocs.io", "surge.sh", "now.sh", "deno.dev", "railway.app", "up.railway.app", "trycloudflare.com",
]);

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** eTLD+1 for a hostname. IPs and single-label hosts (localhost) are their own registrable domain. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h || isIp(h)) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  for (let n = labels.length - 1; n >= 2; n--) {
    const suffix = labels.slice(labels.length - n).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(labels.length - n - 1).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Parse a saved item URL. Schemeless entries ("github.com") are read as https; explicit http never matches. */
function parseItemUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * DA3: may an item saved for `itemUrl` be filled into a page at `pageUrlOrOrigin`?
 * Registrable-domain match, both sides https. An item with no URL never matches.
 */
export function itemUrlMatches(itemUrl: string | null | undefined, pageUrlOrOrigin: string): boolean {
  if (!itemUrl) return false;
  const item = parseItemUrl(itemUrl);
  let page: URL;
  try {
    page = new URL(pageUrlOrOrigin);
  } catch {
    return false;
  }
  if (!item || item.protocol !== "https:" || page.protocol !== "https:") return false;
  if (!item.hostname || !page.hostname) return false;
  return registrableDomain(item.hostname) === registrableDomain(page.hostname);
}

/** Normalise and check an origin the extension reports: https only, no path. */
export function httpsOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-URI match types (#37). The bridge narrows by registrable domain; the extension decides with this,
// once before asking for a secret and again just before typing.
// ---------------------------------------------------------------------------

/** Bitwarden's URI match types, indexed by the CLI's numeric code (0 domain .. 5 never); null = default. */
export const URI_MATCH_TYPES = ["domain", "host", "startsWith", "exact", "regex", "never"] as const;
export type UriMatchType = (typeof URI_MATCH_TYPES)[number];
export const MAX_URI_REGEX = 500;

export interface ItemUri {
  uri: string;
  /** Default (null/undefined) = base domain. */
  match?: UriMatchType | null;
}

export function uriMatchFromBitwarden(code: number | null | undefined): UriMatchType | null {
  if (code === null || code === undefined) return null;
  return URI_MATCH_TYPES[code] ?? "never";
}

/** A literal https host written in a regex pattern (`^https://login\.github\.com/`), unescaped. */
function regexLiteralHost(pattern: string): string | null {
  // Optional groups before the host ("(www\.)?", "(?:[a-z]+\.)?") are dropped; the rest must be literal.
  const p = pattern.replace(/\((?:\?:)?[^()]*\)[?*]/g, "");
  const m = p.match(/https:\\?\/\\?\/((?:[a-z0-9-]+\\?\.)+[a-z]{2,})/i);
  return m ? m[1].replace(/\\\./g, ".").toLowerCase() : null;
}

/**
 * Does one saved URI match the frame's full URL? DA3 (registrable domain + https) is a floor every match
 * type must pass. For a regex the floor is: the pattern names a literal https host, that host passes DA3
 * against the page, and the regex matches the full URL. So no pattern can widen matching to another domain.
 */
export function uriMatches(item: ItemUri, pageUrl: string): boolean {
  const match = item.match ?? "domain";
  if (match === "never") return false;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== "https:") return false;
  if (match === "regex") {
    if (item.uri.length > MAX_URI_REGEX) return false;
    const host = regexLiteralHost(item.uri);
    if (!host || !itemUrlMatches(`https://${host}`, page.href)) return false;
    try {
      return new RegExp(item.uri, "i").test(page.href);
    } catch {
      return false;
    }
  }
  if (!itemUrlMatches(item.uri, page.href)) return false;
  const saved = parseItemUrl(item.uri);
  if (!saved) return false;
  switch (match) {
    case "domain":
      return true;
    case "host":
      return saved.hostname === page.hostname && saved.port === page.port;
    case "exact":
      return saved.href === page.href;
    case "startsWith":
      return page.href.startsWith(saved.href);
    default:
      return false;
  }
}

/** An item matches if any of its URIs matches. An item with no URI never matches. */
export function itemMatches(uris: readonly ItemUri[] | null | undefined, pageUrl: string): boolean {
  return !!uris?.length && uris.some((u) => uriMatches(u, pageUrl));
}

/** The bridge's pre-filter: some URI is on the page's registrable domain. A superset of itemMatches. */
export function itemOnDomain(uris: readonly ItemUri[] | null | undefined, pageUrlOrOrigin: string): boolean {
  if (!uris?.length) return false;
  let host: string;
  try {
    host = new URL(pageUrlOrOrigin).hostname;
  } catch {
    return false;
  }
  const want = registrableDomain(host);
  return uris.some((u) => {
    if ((u.match ?? "domain") === "never") return false;
    const h = (u.match ?? "domain") === "regex" ? regexLiteralHost(u.uri) : (parseItemUrl(u.uri)?.hostname ?? null);
    return !!h && registrableDomain(h) === want;
  });
}

// ---------------------------------------------------------------------------
// Wire (DA2; CONTRACT "M6 Auth addendum")
// ---------------------------------------------------------------------------

const WireError = z.object({ code: z.enum(ERROR_CODES), message: z.string(), hint: z.string().optional() });

export const PROVIDER_STATES = ["missing", "old-version", "logged-out", "locked", "unlocked", "disabled"] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];
export const TOTP_STATES = ["available", "plan-required", "unknown"] as const;
export type TotpState = (typeof TOTP_STATES)[number];

export const ItemUriSchema = z.strictObject({ uri: z.string().max(2048), match: z.enum(URI_MATCH_TYPES).nullable().optional() });

export const AuthAccountSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID_RE),
  provider: z.enum(AUTH_PROVIDERS),
  accountMasked: z.string().regex(MASKED_ACCOUNT_RE),
  /** The item carries a TOTP (auth.code source=totp/auto). */
  hasTotp: z.boolean().optional(),
  /** Passkey and no password: never filled, auth.login answers handoff_required (#37). */
  passkeyOnly: z.boolean().optional(),
  /** Master-password re-prompt item: never filled, never Always (#37). */
  reprompt: z.boolean().optional(),
  /**
   * Saved URIs with their match types, bridge -> extension only, so the extension decides with
   * itemMatches() against the frame's full URL (#37). Never copied into a Result.
   */
  uris: z.array(ItemUriSchema).max(50).optional(),
});
export type AuthAccount = z.infer<typeof AuthAccountSchema>;

export const ProviderStatusSchema = z.strictObject({
  name: z.enum(AUTH_PROVIDERS),
  state: z.enum(PROVIDER_STATES),
  totp: z.enum(TOTP_STATES).optional(),
  /** TabAgent-authored fix for the user ("ask the user to run `tabagent bitwarden unlock`"). Never vault text. */
  hint: z.string().optional(),
  /** auth.signup only (#112): the provider account's own email, masked; the default sign-up account. */
  userMasked: z.string().regex(MASKED_ACCOUNT_RE).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const CODE_SOURCE_STATES = ["available", "disabled", "unreadable", "missing", "unsupported"] as const;
export type CodeSourceState = (typeof CODE_SOURCE_STATES)[number];
export const CodeSourceStatusSchema = z.strictObject({
  name: z.enum(CODE_SOURCES),
  state: z.enum(CODE_SOURCE_STATES),
  hint: z.string().optional(),
});
export type CodeSourceStatus = z.infer<typeof CodeSourceStatusSchema>;

/** ext → bridge: which saved accounts match the origin the extension reports (#33 step 2). */
export const AuthAccountsRequestSchema = z.object({
  type: z.literal("auth.accounts"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  origin: z.string().min(1),
});
export type AuthAccountsRequest = z.infer<typeof AuthAccountsRequestSchema>;

/** bridge → ext. `providers` / `codeSources` feed auth.status. */
export const AuthAccountsResultSchema = z.object({
  type: z.literal("auth.accounts.result"),
  id: z.string().min(1),
  ok: z.boolean(),
  accounts: z.array(AuthAccountSchema).optional(),
  providers: z.array(ProviderStatusSchema).optional(),
  codeSources: z.array(CodeSourceStatusSchema).optional(),
  error: WireError.optional(),
});
export type AuthAccountsResult = z.infer<typeof AuthAccountsResultSchema>;

/** ext → bridge, sent ONLY after consent (#33 step 4). */
export const AuthSecretRequestSchema = z.object({
  type: z.literal("auth.secret.request"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  accountId: z.string().regex(ACCOUNT_ID_RE),
  field: z.enum(["username", "password", "totp"]),
});
export type AuthSecretRequest = z.infer<typeof AuthSecretRequestSchema>;

/** ext → bridge: a code from a bridge-side source (SMS, #36). `since` is epoch ms. */
export const AuthCodeRequestSchema = z.object({
  type: z.literal("auth.code.request"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  source: z.literal("sms"),
  since: z.number().int().nonnegative(),
  timeout: z.number().int().positive().max(TIMEOUTS.max),
});
export type AuthCodeRequest = z.infer<typeof AuthCodeRequestSchema>;

/**
 * ext → bridge, sent ONLY after consent (#112): create a login for `origin` in the password manager with
 * a generated password. `username` defaults to the provider account's email. Answered with the new
 * account (id + masked name); the password is then fetched with auth.secret.request like any other.
 */
export const AuthSignupRequestSchema = z.object({
  type: z.literal("auth.signup.request"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  origin: z.string().min(1),
  username: z.string().min(1).max(254).optional(),
});
export type AuthSignupRequest = z.infer<typeof AuthSignupRequestSchema>;

/** bridge → ext. Never carries the password. */
export const AuthSignupResultSchema = z.object({
  type: z.literal("auth.signup.result"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  ok: z.boolean(),
  account: AuthAccountSchema.optional(),
  error: WireError.optional(),
});
export type AuthSignupResult = z.infer<typeof AuthSignupResultSchema>;

/**
 * bridge → ext. The only message that carries a secret. The extension holds `value` in a local for one
 * command, types it, and drops it. It is never in params, results, logs, the audit log or storage.
 * Failure: `ok: false` with `error` and no value.
 */
export const SecretMessageSchema = z.object({
  type: z.literal("secret"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  field: z.enum(SECRET_FIELDS),
  ok: z.boolean(),
  value: z.string().optional(),
  error: WireError.optional(),
});
export type SecretMessage = z.infer<typeof SecretMessageSchema>;

export const AuthExtToBridgeSchema = z.discriminatedUnion("type", [AuthAccountsRequestSchema, AuthSecretRequestSchema, AuthCodeRequestSchema, AuthSignupRequestSchema]);
export type AuthExtToBridge = z.infer<typeof AuthExtToBridgeSchema>;
export const AuthBridgeToExtSchema = z.discriminatedUnion("type", [AuthAccountsResultSchema, SecretMessageSchema, AuthSignupResultSchema]);
export type AuthBridgeToExt = z.infer<typeof AuthBridgeToExtSchema>;

export const AUTH_EXT_MESSAGE_TYPES = ["auth.accounts", "auth.secret.request", "auth.code.request", "auth.signup.request"] as const;
export function isAuthExtMessage(m: unknown): boolean {
  return !!m && typeof m === "object" && (AUTH_EXT_MESSAGE_TYPES as readonly string[]).includes(String((m as { type?: unknown }).type));
}

// ---------------------------------------------------------------------------
// Registry entries (DA1, DA10)
// ---------------------------------------------------------------------------

const tabId = z.number().int().optional().describe("Tab id; default: the session's active tab");
const accountListItem = z.strictObject({ id: accountIdString(), provider: z.enum(AUTH_PROVIDERS), accountMasked: maskedAccount() });

export const AUTH_TOOLS = [
  {
    name: "auth.status",
    group: "auth",
    description: "Sign-in options for the tab's site: login form present, matching saved accounts (masked), code sources. Fetches no secrets.",
    params: z.object({ tabId }),
    result: z.strictObject({
      loginFormPresent: z.boolean(),
      providers: z.array(
        z.strictObject({
          name: z.enum(AUTH_PROVIDERS),
          state: z.enum(PROVIDER_STATES),
          totp: z.enum(TOTP_STATES).optional(),
          hint: z.string().optional(),
          /** Only items matching the tab's origin, never the whole vault (#37). */
          accounts: z.array(
            z.strictObject({
              id: accountIdString(),
              accountMasked: maskedAccount(),
              hasTotp: z.boolean().optional(),
              passkeyOnly: z.boolean().optional(),
              reprompt: z.boolean().optional(),
            }),
          ),
        }),
      ),
      codeSources: z.array(CodeSourceStatusSchema),
    }),
    level: "read",
    pageContent: [],
    profiles: ["auth"],
    lite: "supported",
    handledBy: "both",
  },
  {
    name: "auth.login",
    group: "auth",
    description: "Sign in: fill username/password from a saved account for this site (asks you), optionally submit. Never returns the secret.",
    params: z.object({
      tabId,
      account: z.string().regex(ACCOUNT_ID_RE).optional().describe("Account id from auth.status when several match"),
      submit: z.boolean().optional().describe("Default true"),
    }),
    result: z.strictObject({
      filled: z.boolean(),
      account: maskedAccount().optional(),
      source: z.enum(AUTH_PROVIDERS).optional(),
      submitted: z.boolean(),
      next: z.enum(["done", "code_required", "handoff_required", "unknown"]),
      /** Several accounts matched and none was chosen: nothing was filled. */
      accounts: z.array(accountListItem).optional(),
    }),
    level: "act",
    secret: true,
    pageContent: [],
    profiles: ["auth"],
    lite: "unsupported",
    handledBy: "both",
  },
  {
    name: "auth.signup",
    group: "auth",
    description: "Create an account on this sign-up page: Bitwarden generates and saves a new password; fills email/username + password (asks you every time), optionally submits. Never returns the password.",
    params: z.object({
      tabId,
      email: z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional().describe("Default: the Bitwarden account email"),
      username: z.string().min(1).max(128).optional().describe("For forms with a username field"),
      submit: z.boolean().optional().describe("Default true"),
    }),
    result: z.strictObject({
      created: z.boolean(),
      account: maskedAccount().optional(),
      /** The new item: pass to auth.login account= later. */
      accountId: accountIdString().optional(),
      source: z.enum(["bitwarden"]).optional(),
      filled: z.boolean(),
      submitted: z.boolean(),
      next: z.enum(["done", "code_required", "handoff_required", "unknown"]),
    }),
    level: "act",
    secret: true,
    pageContent: [],
    profiles: ["auth"],
    lite: "unsupported",
    handledBy: "both",
  },
  {
    name: "auth.code",
    group: "auth",
    description: "Fetch a one-time code (totp, email, sms; auto tries in that order) and type it into the code field. Never returns the code.",
    params: z.object({
      tabId,
      ref: z.string().optional().describe("Code field ref; default: the detected one-time-code field"),
      source: z.enum(["auto", ...CODE_SOURCES]).optional().describe("Default auto"),
      from: z.string().max(253).optional().describe("Sender domain filter for email codes"),
      timeout: z.number().int().positive().max(TIMEOUTS.max).optional().describe("ms to wait for the code, default 60000"),
      submit: z.boolean().optional().describe("Default true"),
    }),
    result: z.strictObject({
      filled: z.boolean(),
      source: z.enum(CODE_SOURCES),
      submitted: z.boolean(),
      next: z.enum(["done", "code_required", "handoff_required", "unknown"]),
    }),
    level: "act",
    secret: true,
    pageContent: [],
    profiles: ["auth"],
    lite: "unsupported",
    handledBy: "both",
  },
  {
    name: "auth.confirm_link",
    group: "auth",
    description: "After a sign-up: find the site's confirmation email in Gmail (asks you) and open its one confirmation link in this tab. Never returns the email or link.",
    params: z.object({
      tabId,
      from: z.string().max(253).optional().describe("Sender domain; default: the site's domain"),
      timeout: z.number().int().positive().max(TIMEOUTS.max).optional().describe("ms to wait for the email, default 60000"),
    }),
    result: z.strictObject({
      followed: z.boolean(),
      next: z.enum(["done", "code_required", "handoff_required", "unknown"]),
      /** Nothing followed: no confirmation link on the site's domain, or several. */
      reason: z.enum(["none", "ambiguous"]).optional(),
    }),
    level: "act",
    secret: true,
    pageContent: [],
    profiles: ["auth"],
    lite: "unsupported",
    handledBy: "extension",
  },
  {
    name: "auth.handoff",
    group: "auth",
    description: "Hand the tab to the user for a human-only step (passkey, CAPTCHA, ID check, phone approval); waits for Done (5 min; 30 with remote handoff on).",
    params: z.object({ tabId, reason: z.string().min(1).max(500) }),
    result: z.strictObject({ completed: z.boolean() }),
    level: "read",
    pageContent: [],
    profiles: ["auth"],
    lite: "supported",
    handledBy: "extension",
  },
] as const satisfies readonly ToolDef[];

/** Groups that no profile includes implicitly, not even `full` (DA10). Add them by name: `--profile auth`. */
export const OPT_IN_GROUPS: readonly string[] = ["auth"];

/**
 * #37 / #34: which account `auth.code source:"totp"` uses. The account the last successful auth.login
 * used on this tab and origin (the caller clears it on off-origin navigation, lock and kill), else the
 * single matching account with a TOTP. More than one → BAD_REQUEST with the masked list; none → NOT_FOUND.
 */
export function selectTotpAccount(
  accounts: readonly AuthAccount[],
  lastLoginAccountId?: string | null,
): { account: AuthAccount } | { error: "NOT_FOUND" } | { error: "BAD_REQUEST"; candidates: { id: string; accountMasked: string }[] } {
  const usable = accounts.filter((a) => a.hasTotp !== false && !a.passkeyOnly && !a.reprompt);
  if (lastLoginAccountId) {
    const last = usable.find((a) => a.id === lastLoginAccountId);
    if (last) return { account: last };
  }
  const withTotp = usable.filter((a) => a.hasTotp === true || (a.hasTotp === undefined && a.provider === "1password"));
  if (withTotp.length === 1) return { account: withTotp[0] };
  if (withTotp.length === 0) return { error: "NOT_FOUND" };
  return { error: "BAD_REQUEST", candidates: withTotp.map((a) => ({ id: a.id, accountMasked: a.accountMasked })) };
}

/** Extra bridge wait for tools that outlive the normal prompt + timeout budget. */
export function authExtraTimeout(tool: string): number {
  return tool === "auth.handoff" ? AUTH_HANDOFF_TIMEOUT : 0;
}
