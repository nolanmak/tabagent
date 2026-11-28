// auth.status / auth.login / auth.code / auth.signup orchestration (#33, #34, #112). Chrome, CDP and the bridge sit behind
// AuthPage and AuthEnv so the whole flow, including the no-leak property, is unit-tested with fakes.
//
// Each step of auth.login is a refusal point (#33):
//  (1) https + auth enabled for the tab's real origin, not denylisted   → PERMISSION_DENIED, no bridge call
//  (2) ask the bridge for accounts matching the origin the EXTENSION reports
//  (3) user prompt unless Always (DA4)                                   → PERMISSION_DENIED on deny
//  (4) only then fetch the secret
//  (5) re-check the tab's origin (it may have navigated during the prompt) and fill
//  (6) optional submit, (7) classify `next`.
// A secret lives in one local variable between the channel and page.type(); nothing else sees it.
import { CODE_SINCE_SLACK_MS, CODE_MAX_AGE_MS, httpsOrigin, itemMatches, maskAccount, registrableDomain, selectTotpAccount, TabAgentError, type AuthAccount, type AuthProviderName, type CodeSourceName, type ProviderStatus, type CodeSourceStatus } from "@tabagent/protocol";
import type { AuthChannel } from "./channel";
import { CONFIRM_MAX_AGE_MS, selectConfirmLink, type MailLink } from "./confirm-link";
import { detectCodeField, detectLogin, detectSignup, type FieldDesc } from "./fields";
import { classifyNext, type Next } from "./next";

export interface PageField extends FieldDesc {
  ref: string;
}

export interface AuthPage {
  /** The tab's real current URL (pending navigation included), never what the agent says. */
  url(): Promise<string>;
  fields(): Promise<PageField[]>;
  signals(): Promise<{ webauthn: boolean; captcha: boolean }>;
  /** True once the tab is gone (an OAuth popup closes itself after the last step, #83 D11). */
  closed?(): Promise<boolean>;
  /** chrome-autofill provider (#32): Chrome pre-filled this form from its password manager. */
  chromeAutofill(): Promise<{ usernameMasked?: string } | null>;
  /** Focus + CDP insertText through the action pipeline. */
  type(ref: string, value: string): Promise<void>;
  /** Mask this field in snapshots, diffs and form.describe from now on (DA2). */
  markFilled(ref: string): Promise<void>;
  /** Submit the form the field belongs to (Enter in the field). */
  submit(ref: string): Promise<void>;
  /** Wait for the page to settle after a submit. */
  settle(): Promise<void>;
  /** Navigate the tab (auth.confirm_link). Throws without naming the URL; refuses denylisted hosts. */
  goto?(url: string): Promise<void>;
}

export interface EmailReader {
  /** One code from the user's signed-in Gmail, newer than `since`. NOT_FOUND when Gmail isn't signed in. */
  fetch(o: { since: number; from?: string; timeout: number }): Promise<string>;
}

/** #113: the confirmation-mail side of the Gmail reader. It hands out ids, dates and links, never mail text. */
export interface ConfirmMailReader {
  /**
   * Unread inbox messages from `from` (domain; subdomains match) received since `since`, newest first,
   * re-polling until one not in `skip` arrives. TIMEOUT when none does; NOT_FOUND when Gmail isn't signed in.
   */
  messages(o: { since: number; from: string; timeout: number; skip: ReadonlySet<string> }): Promise<{ id: string; date: number }[]>;
  /** The links (href + anchor text) in one message's body. UNSUPPORTED when the body can't be read. */
  links(id: string): Promise<MailLink[]>;
  /** Release whatever the reader opened (the private tab). */
  close?(): Promise<void>;
}

export interface AuthEnv {
  cmdId: string;
  tabId: number;
  /** Step 1: auth enabled for this origin and the host is not on the banking/password-manager list. No prompt. */
  siteCheck(url: string): Promise<void>;
  /** Category g gate (requireSensitive(meta, url, "g", …)). Throws PERMISSION_DENIED / PROMPT_TIMEOUT. */
  /** `signup`: a sign-up prompt (#112), asked every time; "Always" never skips or stores it. */
  /** Resolves "authAuto" when the site signs in without asking (#131); such a consent is never cached. */
  consent(url: string, who: { accountId: string; accountMasked: string; provider: string; signup?: boolean }, summary: string): Promise<"authAuto" | undefined | void>;
  channel: Pick<AuthChannel, "accounts" | "secret" | "smsCode" | "createLogin">;
  email?: EmailReader;
  confirmMail?: ConfirmMailReader;
  /**
   * DA1 (review H1): called just before a credential reaches the page, so the tab is tainted
   * (no c/d reads, results screened) before the first keystroke. `secret` only for password/code.
   */
  filled?(kind: "username" | "password" | "code" | "autofill", secret: string | null): void;
  /** DA1 (review H1): agent JavaScript ran in the tab's current document; it could be listening. */
  scriptDirty?(): boolean;
  /** DA11 audit event (tool, origin, provider/source, masked account, outcome). Never a secret. */
  event(name: string, data: Record<string, unknown>): void;
  now(): number;
}

/** Per-tab memory shared across calls: when auth.login last ran (DA8 `since`), sources approved this run. */
export interface AuthMemory {
  lastLogin: Map<number, number>;
  /** Account the last auth.login used on a tab, with its origin (TOTP picks it first, #37). */
  lastAccount: Map<number, { id: string; origin: string }>;
  approvedSources: Set<string>;
  /** Gmail message ids auth.confirm_link already followed (a confirmation link is used once). */
  confirmedMail: Set<string>;
}
/** How long the second auth.login call of a two-step login reuses the first call's account and consent. */
export const TWO_STEP_REUSE_MS = 2 * 60_000;
const GOOGLE_SIGNIN_HOST = "accounts.google.com";

async function readAfter(page: AuthPage) {
  const sig = await page.signals().catch(() => ({ webauthn: false, captcha: false }));
  return { url: await page.url(), fields: await page.fields(), ...sig };
}

export const newMemory = (): AuthMemory => ({ lastLogin: new Map(), lastAccount: new Map(), approvedSources: new Set(), confirmedMail: new Set() });

export const CHROME_AUTOFILL_ID = "chrome-autofill:saved";

/** Refuse to type a secret into a document where agent JavaScript has run (review H1). */
function assertClean(env: AuthEnv) {
  if (env.scriptDirty?.()) {
    throw new TabAgentError("PERMISSION_DENIED", "Agent JavaScript ran in this page, so TabAgent will not type a credential into it", "Call nav.reload (or open the sign-in page again), then retry without js.eval or nav.wait for=fn first.");
  }
}

function originOrDeny(url: string): string {
  let o: string | null = null;
  try {
    o = httpsOrigin(new URL(url).origin);
  } catch {
    /* not a URL */
  }
  if (!o) throw new TabAgentError("PERMISSION_DENIED", "Sign-in is only done on https pages", "TabAgent never fills credentials into http or non-web pages (DA3).");
  return o;
}

async function sameOrigin(page: AuthPage, origin: string, what: string) {
  const now = await page.url();
  let o: string | null = null;
  try {
    o = new URL(now).origin;
  } catch {
    /* */
  }
  if (o !== origin) throw new TabAgentError("PERMISSION_DENIED", `The tab left ${origin} before the ${what} was filled; nothing was filled`, "Navigate back to the sign-in page and call auth.login again.");
  return now;
}

interface Candidate {
  account: AuthAccount;
}

function providerOrder(providers: ProviderStatus[] | undefined): AuthProviderName[] {
  const named = (providers ?? []).map((p) => p.name);
  const order: AuthProviderName[] = [];
  for (const n of named) if (!order.includes(n)) order.push(n);
  for (const n of ["1password", "bitwarden", "chrome-autofill"] as AuthProviderName[]) if (!order.includes(n)) order.push(n);
  return order;
}

function chromeDisabled(providers: ProviderStatus[] | undefined) {
  return (providers ?? []).some((p) => p.name === "chrome-autofill" && p.state === "disabled");
}

async function gatherAccounts(env: AuthEnv, page: AuthPage, origin: string, url: string) {
  const res = await env.channel.accounts(env.cmdId, origin);
  // DA3, extension side: the bridge narrowed by domain; decide on the full URL with the item's match types.
  const fromBridge = (res.accounts ?? []).filter((a) => a.provider !== "chrome-autofill");
  const bridged = fromBridge.filter((a) => a.uris === undefined || itemMatches(a.uris, url));
  const rejected = fromBridge.length - bridged.length;
  const out: AuthAccount[] = [...bridged];
  if (!chromeDisabled(res.providers)) {
    const af = await page.chromeAutofill().catch(() => null);
    if (af) out.push({ id: CHROME_AUTOFILL_ID, provider: "chrome-autofill", accountMasked: af.usernameMasked ?? maskAccount("") });
  }
  return { accounts: out, providers: res.providers, codeSources: res.codeSources, rejected };
}

export async function authStatus(env: AuthEnv, page: AuthPage) {
  const url = await page.url();
  const login = detectLogin(await page.fields());
  let origin: string | null = null;
  try {
    origin = httpsOrigin(new URL(url).origin);
  } catch {
    /* */
  }
  if (!origin) return { loginFormPresent: login.ok, providers: [], codeSources: [] };
  const { accounts, providers, codeSources } = await gatherAccounts(env, page, origin, url);
  const names = providerOrder(providers);
  const out = names
    .map((name) => {
      const st = providers?.find((p) => p.name === name);
      const accs = accounts.filter((a) => a.provider === name);
      if (!st && !accs.length) return null;
      return {
        name,
        state: st?.state ?? "unlocked",
        ...(st?.totp ? { totp: st.totp } : {}),
        ...(st?.hint ? { hint: st.hint } : {}),
        accounts: accs.map((a) => ({ id: a.id, accountMasked: a.accountMasked, ...(a.hasTotp ? { hasTotp: true } : {}), ...(a.passkeyOnly ? { passkeyOnly: true } : {}), ...(a.reprompt ? { reprompt: true } : {}) })),
      };
    })
    .filter(Boolean);
  const sources: CodeSourceStatus[] = [...(codeSources ?? [])];
  if (env.email && !sources.some((s) => s.name === "email")) sources.push({ name: "email", state: "available" });
  return { loginFormPresent: login.ok, providers: out, codeSources: sources };
}

export interface LoginResult {
  filled: boolean;
  account?: string;
  source?: AuthProviderName;
  submitted: boolean;
  next: Next;
  accounts?: { id: string; provider: AuthProviderName; accountMasked: string }[];
}

export async function authLogin(env: AuthEnv, page: AuthPage, p: { account?: string; submit?: boolean }, mem: AuthMemory): Promise<LoginResult> {
  const url0 = await page.url();
  const origin = originOrDeny(url0);
  await env.siteCheck(url0); // (1)
  assertClean(env);
  const form0 = detectLogin(await page.fields());
  if (!form0.ok) throw new TabAgentError("NOT_FOUND", form0.reason, form0.signup ? "auth.login only signs in; it never fills sign-up or change-password forms." : "Navigate to the site's sign-in page first.");
  const { accounts, providers, rejected } = await gatherAccounts(env, page, origin, url0); // (2)

  // #82 D6e: the password step of a two-step login reuses the identifier step's account.
  const prev = mem.lastAccount.get(env.tabId);
  const prevAt = mem.lastLogin.get(env.tabId);
  const recent = !!prev && prev.origin === origin && prevAt !== undefined && env.now() - prevAt < TWO_STEP_REUSE_MS;
  const wantId = p.account ?? (recent ? prev!.id : undefined);

  let chosen: AuthAccount | undefined;
  if (wantId) {
    chosen = accounts.find((a) => a.id === wantId);
    if (!chosen) throw new TabAgentError("NOT_FOUND", `No saved account ${wantId} matches ${origin}`, "Call auth.status to list matching accounts.");
  } else {
    for (const name of providerOrder(providers)) {
      const hits = accounts.filter((a) => a.provider === name);
      if (hits.length > 1) {
        env.event("auth.login", { origin, provider: name, outcome: "choose" });
        return { filled: false, submitted: false, next: "unknown", accounts: hits.map((a) => ({ id: a.id, provider: a.provider, accountMasked: a.accountMasked })) };
      }
      if (hits.length === 1) {
        chosen = hits[0];
        break;
      }
    }
  }
  if (!chosen && rejected > 0) throw new TabAgentError("PERMISSION_DENIED", `No saved item is bound to ${origin}; credentials are only filled on the site they were saved for`, "DA3: registrable-domain match, https only. Look-alike domains never match.");
  if (!chosen) {
    const why = (providers ?? []).filter((x) => x.state !== "unlocked" && x.state !== "disabled").map((x) => `${x.name}: ${x.state}`);
    throw new TabAgentError("NOT_FOUND", `No saved account matches ${origin}`, why.length ? `Providers not ready (${why.join(", ")}); see auth.status.` : "Save the login in 1Password or Bitwarden for this site, or use auth.handoff.");
  }
  if (chosen.passkeyOnly) return { filled: false, account: chosen.accountMasked, source: chosen.provider, submitted: false, next: "handoff_required" };
  if (chosen.reprompt) throw new TabAgentError("PERMISSION_DENIED", "This item asks for the master password before every use; TabAgent never fills it", "Use auth.handoff and let the user sign in.");

  const host = new URL(origin).host;
  // One consent covers both steps of the same sign-in (same tab, origin and account, within TWO_STEP_REUSE_MS).
  if (!(recent && chosen.id === prev!.id)) await env.consent(url0, { accountId: chosen.id, accountMasked: chosen.accountMasked, provider: chosen.provider }, `Sign in to ${host} as ${chosen.accountMasked} with ${chosen.provider}?`); // (3)

  // (5) the tab may have navigated during the prompt
  const url1 = await sameOrigin(page, origin, "sign-in");
  if (chosen.provider !== "chrome-autofill" && chosen.uris !== undefined && !itemMatches(chosen.uris, url1)) {
    throw new TabAgentError("PERMISSION_DENIED", "The saved item no longer matches this page; nothing was filled");
  }
  const form = detectLogin(await page.fields());
  if (!form.ok) throw new TabAgentError("NOT_FOUND", "The login form went away during the prompt; nothing was filled", "Take a page.snapshot and call auth.login again.");
  const fields = await page.fields();
  const refOf = (i?: number) => (i === undefined ? undefined : fields.find((f) => f.i === i)?.ref);
  const userRef = refOf(form.username);
  const passRef = refOf(form.password);
  let last: string | undefined;

  if (chosen.provider === "chrome-autofill") {
    // Chrome already put the saved credential in the fields; TabAgent never sees it (#32).
    for (const r of [userRef, passRef]) if (r) await page.markFilled(r);
    assertClean(env);
    env.filled?.("autofill", null);
    last = passRef ?? userRef;
  } else {
    for (const [field, ref] of [["username", userRef], ["password", passRef]] as const) {
      if (!ref) continue;
      let value: string | null = await env.channel.secret(env.cmdId, chosen.id, field); // (4)
      try {
        await sameOrigin(page, origin, field);
        await page.markFilled(ref);
        assertClean(env);
        env.filled?.(field, field === "password" ? value : null);
        await page.type(ref, value);
      } finally {
        value = null;
      }
      last = ref;
    }
  }
  mem.lastLogin.set(env.tabId, env.now());
  mem.lastAccount.set(env.tabId, { id: chosen.id, origin });

  let submitted = false;
  const submit = p.submit !== false;
  if (submit && last) {
    await sameOrigin(page, origin, "form");
    await page.submit(last); // (6)
    submitted = true;
    await page.settle();
  }
  let next: Next = "unknown";
  if (submitted) {
    // (7) A popup that closed itself after the submit finished the flow (#83 D11).
    const after = await readAfter(page).catch(async (e) => {
      if (await page.closed?.().catch(() => false)) return null;
      throw e;
    });
    next = after === null ? "done" : classifyNext(url1, after);
  }
  env.event("auth.login", { origin, provider: chosen.provider, account: chosen.accountMasked, outcome: "filled", submitted, next });
  return { filled: true, account: chosen.accountMasked, source: chosen.provider, submitted, next };
}

export interface CodeResult {
  filled: boolean;
  source: CodeSourceName;
  submitted: boolean;
  /** Same meaning as auth.login's next: done, code_required, handoff_required or unknown. */
  next: Next;
}

export async function authCode(
  env: AuthEnv,
  page: AuthPage,
  p: { ref?: string; source?: "auto" | CodeSourceName; from?: string; timeout?: number; submit?: boolean },
  mem: AuthMemory,
): Promise<CodeResult> {
  const url0 = await page.url();
  const origin = originOrDeny(url0);
  await env.siteCheck(url0);
  assertClean(env);
  const timeout = p.timeout ?? 60_000;
  const now = env.now();
  const loginAt = mem.lastLogin.get(env.tabId);
  const since = (loginAt !== undefined && now - loginAt < CODE_MAX_AGE_MS ? Math.min(loginAt, now) : now) - CODE_SINCE_SLACK_MS;

  // Destination first: no point fetching a code we can't place.
  const fields = await page.fields();
  let dest: string[];
  if (p.ref) dest = [p.ref];
  else {
    const d = detectCodeField(fields);
    if (!d.ok) throw new TabAgentError("BAD_REQUEST", d.reason, "Pass ref= with the code field from page.snapshot.");
    const refOf = (i: number) => fields.find((f) => f.i === i)!.ref;
    dest = d.split ? d.fields.map(refOf) : [refOf(d.field)];
  }

  const want = p.source ?? "auto";
  // #83 D7b: on Google's sign-in host the signed-in Gmail may be another account; never read email codes there.
  const google = new URL(origin).hostname === GOOGLE_SIGNIN_HOST;
  if (google && want === "email") throw new TabAgentError("PERMISSION_DENIED", "Email codes are not read on accounts.google.com", "Use source=sms or source=totp, or auth.handoff.");
  let totpAccount: AuthAccount | undefined;
  let smsAvailable = want === "sms";
  if (want === "auto" || want === "totp") {
    const res = await env.channel.accounts(env.cmdId, origin);
    const matched = (res.accounts ?? []).filter((a) => a.provider !== "chrome-autofill" && (a.uris === undefined || itemMatches(a.uris, url0)));
    const last = mem.lastAccount.get(env.tabId);
    const pick = selectTotpAccount(matched, last?.origin === origin ? last.id : null);
    if ("account" in pick) totpAccount = pick.account;
    else if (want === "totp") {
      if (pick.error === "BAD_REQUEST") throw new TabAgentError("BAD_REQUEST", `${pick.candidates.length} saved items for ${origin} have a TOTP: ${pick.candidates.map((c) => `${c.id} (${c.accountMasked})`).join(", ")}`, "Call auth.login with account= first; auth.code then uses that account.");
      throw new TabAgentError("NOT_FOUND", `No saved item for ${origin} has a TOTP`, "Check auth.status, or use source=email / sms.");
    }
    smsAvailable = (res.codeSources ?? []).some((s) => s.name === "sms" && s.state === "available");
  }
  const order: CodeSourceName[] = want === "auto" ? (["totp", "email", "sms"] as CodeSourceName[]).filter((s) => (s === "totp" ? !!totpAccount : s === "email" ? !!env.email && !google : smsAvailable)) : [want];
  if (!order.length) throw new TabAgentError("NOT_FOUND", `No code source is available for ${origin}`, "auth.status lists code sources and why they are unavailable.");

  const host = new URL(origin).host;
  let lastErr: unknown;
  for (const source of order) {
    const key = `${origin}|${source}`;
    try {
      if (!mem.approvedSources.has(key)) {
        const who = source === "totp" && totpAccount ? { accountId: totpAccount.id, accountMasked: totpAccount.accountMasked, provider: totpAccount.provider } : { accountId: `code-source:${source}`, accountMasked: maskAccount(""), provider: source };
        const via = await env.consent(url0, who, `Enter a ${source === "totp" ? "TOTP" : source} code on ${host}?`);
        // #131: authAuto is re-checked on every code, so turning it off (or a denylist entry) applies at once.
        if (via !== "authAuto") mem.approvedSources.add(key);
      }
      let code: string | null =
        source === "totp" ? await env.channel.secret(env.cmdId, totpAccount!.id, "totp") : source === "email" ? await env.email!.fetch({ since, from: p.from, timeout }) : await env.channel.smsCode(env.cmdId, since, timeout);
      try {
        if (!/^[A-Za-z0-9]{4,10}$/.test(code)) throw new TabAgentError("BAD_REQUEST", "The code source returned something that is not a code");
        await sameOrigin(page, origin, "code");
        assertClean(env);
        env.filled?.("code", code);
        if (dest.length > 1) {
          const chars = [...code];
          if (chars.length !== dest.length) throw new TabAgentError("BAD_REQUEST", `The code has ${chars.length} characters but the page has ${dest.length} boxes`);
          for (let i = 0; i < dest.length; i++) {
            await page.markFilled(dest[i]);
            await page.type(dest[i], chars[i]);
          }
          chars.fill("");
        } else {
          await page.markFilled(dest[0]);
          await page.type(dest[0], code);
        }
      } finally {
        code = null;
      }
      let submitted = false;
      let next: Next = "unknown";
      if (p.submit !== false) {
        await sameOrigin(page, origin, "form");
        await page.submit(dest[dest.length - 1]);
        submitted = true;
        await page.settle();
        const after = await readAfter(page).catch(async (e) => {
          if (await page.closed?.().catch(() => false)) return null;
          throw e;
        });
        next = after === null ? "done" : classifyNext(url0, after);
      }
      env.event("auth.code", { origin, source, outcome: "filled", submitted, next });
      return { filled: true, source, submitted, next };
    } catch (e) {
      lastErr = e;
      const code = (e as TabAgentError)?.code;
      // auto falls through only when a source simply has nothing (not signed in, no code, unsupported)
      if (want !== "auto" || !(code === "NOT_FOUND" || code === "UNSUPPORTED" || code === "TIMEOUT")) {
        env.event("auth.code", { origin, source, outcome: "error", errorCode: code ?? "INTERNAL" });
        throw e;
      }
    }
  }
  env.event("auth.code", { origin, source: order[order.length - 1], outcome: "error", errorCode: (lastErr as TabAgentError)?.code ?? "INTERNAL" });
  throw lastErr;
}

export interface SignupResult {
  created: boolean;
  account?: string;
  accountId?: string;
  source?: "bitwarden";
  filled: boolean;
  submitted: boolean;
  next: Next;
}

/** Placeholder id for the sign-up prompt: the item does not exist yet, and "Always" never applies (#112 D1). */
export const SIGNUP_CONSENT_ID = "bitwarden:new-login";

/**
 * #112 auth.signup. Refusal points, in order:
 *  (1) https + auth enabled for the origin, not denylisted / AUTH_DENY_HOSTS   → PERMISSION_DENIED
 *  (2) a sign-up form (detectSignup), with the values it needs                 → NOT_FOUND / BAD_REQUEST
 *  (3) Bitwarden unlocked (only Bitwarden creates items, D2)                   → NOT_FOUND / UNSUPPORTED
 *  (4) the user's consent, every time (D1: "Always" does not apply)            → PERMISSION_DENIED
 *  (5) the tab is still on the origin and form; then the bridge creates the item
 *  (6) fill email/username, then the password into every new-password field; submit; classify.
 * Once the item exists, any later failure keeps it and the error names it, so the user can find or
 * delete it. The password lives in one local between the channel and page.type().
 */
export async function authSignup(env: AuthEnv, page: AuthPage, p: { email?: string; username?: string; submit?: boolean }): Promise<SignupResult> {
  const url0 = await page.url();
  const origin = originOrDeny(url0);
  await env.siteCheck(url0); // (1)
  assertClean(env);
  const form0 = detectSignup(await page.fields()); // (2)
  if (!form0.ok) throw new TabAgentError("NOT_FOUND", form0.reason, "Navigate to the site's sign-up page first. auth.signup never fills sign-in or change-password forms.");
  if (form0.email !== undefined && form0.username !== undefined && !p.username) throw new TabAgentError("BAD_REQUEST", "This sign-up form asks for a username as well as an email", "Pass username= (and email=) to auth.signup.");
  if (form0.email !== undefined && !p.email && p.username && !p.username.includes("@")) throw new TabAgentError("BAD_REQUEST", "This sign-up form asks for an email", "Pass email= to auth.signup.");
  const itemUser = p.email ?? p.username;

  const res = await env.channel.accounts(env.cmdId, origin); // (3)
  const bw = (res.providers ?? []).find((x) => x.name === "bitwarden");
  if (!bw || bw.state === "disabled") {
    throw new TabAgentError("UNSUPPORTED", "Only Bitwarden can create logins, and it is not turned on", "The user can turn it on with `tabagent bitwarden enable`, or sign up themselves (auth.handoff).");
  }
  if (bw.state !== "unlocked") throw new TabAgentError("NOT_FOUND", `Bitwarden is ${bw.state}`, bw.hint ?? "See auth.status.");
  const shown = itemUser ? maskAccount(itemUser) : bw.userMasked;
  if (!shown) throw new TabAgentError("BAD_REQUEST", "No email for the new account", "Pass email= to auth.signup.");

  const host = new URL(origin).host;
  await env.consent(url0, { accountId: SIGNUP_CONSENT_ID, accountMasked: shown, provider: "bitwarden", signup: true }, `Create an account on ${host} as ${shown} and save it to Bitwarden?`); // (4)

  // (5) the tab may have navigated during the prompt; nothing is created unless it is still here.
  const url1 = await sameOrigin(page, origin, "sign-up form");
  assertClean(env);
  const form = detectSignup(await page.fields());
  if (!form.ok) throw new TabAgentError("NOT_FOUND", "The sign-up form went away during the prompt; nothing was created", "Take a page.snapshot and call auth.signup again.");
  const acct = await env.channel.createLogin(env.cmdId, origin, itemUser);

  try {
    const fields = await page.fields();
    const refOf = (i?: number) => (i === undefined ? undefined : fields.find((f) => f.i === i)?.ref);
    const emailRef = refOf(form.email);
    const userRef = refOf(form.username);
    const pwRefs = form.passwords.map((i) => refOf(i)).filter((r): r is string => !!r);
    if (!pwRefs.length) throw new TabAgentError("REF_STALE", "The password fields went away");
    // Identity first: what the agent passed, else the new item's username (the Bitwarden account email).
    const emailVal = p.email ?? (p.username?.includes("@") ? p.username : undefined);
    const userVal = p.username ?? (emailRef === undefined ? itemUser : undefined);
    let fromItem: string | null = null;
    if ((emailRef && !emailVal) || (userRef && !userVal)) fromItem = await env.channel.secret(env.cmdId, acct.id, "username");
    for (const [ref, v] of [
      [emailRef, emailVal ?? fromItem],
      [userRef, userVal ?? fromItem],
    ] as const) {
      if (!ref || !v) continue;
      await sameOrigin(page, origin, "email");
      await page.markFilled(ref);
      assertClean(env);
      env.filled?.("username", null);
      await page.type(ref, v);
    }
    fromItem = null;
    let pw: string | null = await env.channel.secret(env.cmdId, acct.id, "password");
    try {
      await sameOrigin(page, origin, "password");
      assertClean(env);
      env.filled?.("password", pw);
      for (const ref of pwRefs) {
        await page.markFilled(ref);
        await page.type(ref, pw);
      }
    } finally {
      pw = null;
    }

    let submitted = false;
    if (p.submit !== false) {
      await sameOrigin(page, origin, "form");
      await page.submit(pwRefs[pwRefs.length - 1]);
      submitted = true;
      await page.settle();
    }
    let next: Next = "unknown";
    if (submitted) {
      const after = await readAfter(page);
      // The sign-up form still there (a validation error, a taken name) is not a handoff.
      next = detectSignup(after.fields).ok ? "unknown" : classifyNext(url1, after);
    }
    env.event("auth.signup", { origin, provider: "bitwarden", account: acct.accountMasked, outcome: "filled", submitted, next });
    return { created: true, account: acct.accountMasked, accountId: acct.id, source: "bitwarden", filled: true, submitted, next };
  } catch (e) {
    const code = (e instanceof TabAgentError ? e.code : (e as { code?: TabAgentError["code"] })?.code) ?? "INTERNAL";
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    env.event("auth.signup", { origin, provider: "bitwarden", account: acct.accountMasked, outcome: "error", errorCode: code });
    throw new TabAgentError(code, `${msg}. The new Bitwarden login was kept: ${acct.accountMasked} (${acct.id}, named ${host})`, `Finish with auth.login account=${acct.id}, or auth.handoff. If the site did not create the account, the user can delete that item in Bitwarden.`);
  }
}

/** auth.confirm_link `since` when no auth action ran on the tab recently (the sign-up may have been typed by hand). */
export const CONFIRM_LOOKBACK_MS = 10 * 60_000;
/** Messages looked at per call before giving up with handoff_required. */
const CONFIRM_MAX_MESSAGES = 5;

export interface ConfirmLinkResult {
  followed: boolean;
  next: Next;
  /** Why nothing was followed: no confirmation link on the site's domain, or more than one. */
  reason?: "none" | "ambiguous";
}

function originOfUrl(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * #113 auth.confirm_link. (1) https, sign-in enabled for the tab's origin, never on Google's sign-in host;
 * (2) consent once per origin; (3) the reader polls Gmail for mail from the site's domain since the last
 * auth action on the tab; (4) newest first, each message's links go through selectConfirmLink (D3);
 * (5) exactly one → re-check the tab's origin and navigate it there. The link and the mail text stay in
 * this function: results, events and errors carry the origin, an outcome and a reason enum only.
 */
export async function authConfirmLink(env: AuthEnv, page: AuthPage, p: { from?: string; timeout?: number }, mem: AuthMemory): Promise<ConfirmLinkResult> {
  const url0 = await page.url();
  const origin = originOrDeny(url0);
  const { host, hostname } = new URL(origin);
  if (hostname === GOOGLE_SIGNIN_HOST) throw new TabAgentError("PERMISSION_DENIED", "Confirmation emails are not read on accounts.google.com", "Use auth.handoff and let the user finish this step.");
  await env.siteCheck(url0);
  const reader = env.confirmMail;
  if (!reader || !page.goto) throw new TabAgentError("NOT_FOUND", "No email reader is available", "Use auth.handoff and let the user open the confirmation email.");
  const site = registrableDomain(hostname);
  const from = p.from?.trim() || site;
  const timeout = p.timeout ?? 60_000;
  const now = env.now();
  const at = mem.lastLogin.get(env.tabId);
  const since = at !== undefined && now - at < CONFIRM_MAX_AGE_MS ? Math.min(at, now) - CODE_SINCE_SLACK_MS : now - CONFIRM_LOOKBACK_MS;

  const key = `${origin}|confirm_link`;
  if (!mem.approvedSources.has(key)) {
    const via = await env.consent(url0, { accountId: "confirm-link:email", accountMasked: maskAccount(""), provider: "email" }, `Open the confirmation email from ${host} in Gmail and follow its link?`);
    if (via !== "authAuto") mem.approvedSources.add(key);
  }

  const handoff = (reason: "none" | "ambiguous"): ConfirmLinkResult => {
    env.event("auth.confirm_link", { origin, outcome: "handoff_required", reason });
    return { followed: false, next: "handoff_required", reason };
  };
  const fail = (e: unknown) => {
    env.event("auth.confirm_link", { origin, outcome: "error", errorCode: (e as TabAgentError)?.code ?? "INTERNAL" });
    return e;
  };

  const skip = new Set(mem.confirmedMail);
  const deadline = now + timeout;
  let checked = 0;
  try {
    for (;;) {
      let msgs: { id: string; date: number }[];
      try {
        msgs = await reader.messages({ since, from, timeout: Math.max(0, deadline - env.now()), skip });
      } catch (e) {
        // Mail from the site arrived but none of it had a confirmation link, and nothing newer came.
        if (checked > 0 && (e as TabAgentError)?.code === "TIMEOUT") return handoff("none");
        throw fail(e);
      }
      const fresh = msgs.filter((m) => !skip.has(m.id));
      if (!fresh.length) {
        if (checked > 0) return handoff("none");
        throw fail(new TabAgentError("TIMEOUT", `No new email from ${from} arrived`, "Check that the site sent the confirmation email, then call auth.confirm_link again."));
      }
      for (const m of fresh) {
        skip.add(m.id);
        checked++;
        let target: string | null = null;
        const pick = selectConfirmLink(await reader.links(m.id).catch((e) => Promise.reject(fail(e))), site);
        if (!pick.ok) {
          if (pick.reason === "ambiguous") return handoff("ambiguous");
          if (checked >= CONFIRM_MAX_MESSAGES) return handoff("none");
          continue;
        }
        target = pick.url;
        try {
          // The tab may have navigated while the mail was read.
          if (originOfUrl(await page.url()) !== origin) throw new TabAgentError("PERMISSION_DENIED", `The tab left ${origin} while the email was read; no link was followed`, "Navigate back to the site and call auth.confirm_link again.");
          mem.confirmedMail.add(m.id);
          try {
            await page.goto(target);
          } catch (e) {
            // Navigation errors can quote the URL: replace them.
            const code = (e as TabAgentError)?.code;
            throw code === "PERMISSION_DENIED" ? new TabAgentError("PERMISSION_DENIED", "The confirmation link points to a host TabAgent does not open") : new TabAgentError(code === "TIMEOUT" ? "TIMEOUT" : "INTERNAL", "Opening the confirmation link failed", "Take a page.snapshot to see where the tab is, or use auth.handoff.");
          }
        } catch (e) {
          throw fail(e);
        } finally {
          target = null;
        }
        await page.settle();
        const after = await readAfter(page);
        const next = classifyNext(url0, after);
        env.event("auth.confirm_link", { origin, outcome: "followed", next });
        return { followed: true, next };
      }
    }
  } finally {
    await reader.close?.().catch(() => {});
  }
}
