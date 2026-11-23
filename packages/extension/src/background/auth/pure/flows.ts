// auth.status / auth.login / auth.code orchestration (#33, #34). Chrome, CDP and the bridge sit behind
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
import { CODE_SINCE_SLACK_MS, CODE_MAX_AGE_MS, httpsOrigin, itemMatches, maskAccount, selectTotpAccount, TabAgentError, type AuthAccount, type AuthProviderName, type CodeSourceName, type ProviderStatus, type CodeSourceStatus } from "@tabagent/protocol";
import type { AuthChannel } from "./channel";
import { detectCodeField, detectLogin, type FieldDesc } from "./fields";
import { classifyNext, type Next } from "./next";

export interface PageField extends FieldDesc {
  ref: string;
}

export interface AuthPage {
  /** The tab's real current URL (pending navigation included), never what the agent says. */
  url(): Promise<string>;
  fields(): Promise<PageField[]>;
  signals(): Promise<{ webauthn: boolean; captcha: boolean }>;
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
}

export interface EmailReader {
  /** One code from the user's signed-in Gmail, newer than `since`. NOT_FOUND when Gmail isn't signed in. */
  fetch(o: { since: number; from?: string; timeout: number }): Promise<string>;
}

export interface AuthEnv {
  cmdId: string;
  tabId: number;
  /** Step 1: auth enabled for this origin and the host is not on the banking/password-manager list. No prompt. */
  siteCheck(url: string): Promise<void>;
  /** Category g gate (requireSensitive(meta, url, "g", …)). Throws PERMISSION_DENIED / PROMPT_TIMEOUT. */
  consent(url: string, who: { accountId: string; accountMasked: string; provider: string }, summary: string): Promise<void>;
  channel: Pick<AuthChannel, "accounts" | "secret" | "smsCode">;
  email?: EmailReader;
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
}
export const newMemory = (): AuthMemory => ({ lastLogin: new Map(), lastAccount: new Map(), approvedSources: new Set() });

export const CHROME_AUTOFILL_ID = "chrome-autofill:saved";

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
  const form0 = detectLogin(await page.fields());
  if (!form0.ok) throw new TabAgentError("NOT_FOUND", form0.reason, form0.signup ? "auth.login only signs in; it never fills sign-up or change-password forms." : "Navigate to the site's sign-in page first.");
  const { accounts, providers, rejected } = await gatherAccounts(env, page, origin, url0); // (2)

  let chosen: AuthAccount | undefined;
  if (p.account) {
    chosen = accounts.find((a) => a.id === p.account);
    if (!chosen) throw new TabAgentError("NOT_FOUND", `No saved account ${p.account} matches ${origin}`, "Call auth.status to list matching accounts.");
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
  await env.consent(url0, { accountId: chosen.id, accountMasked: chosen.accountMasked, provider: chosen.provider }, `Sign in to ${host} as ${chosen.accountMasked} with ${chosen.provider}?`); // (3)

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
    last = passRef ?? userRef;
  } else {
    for (const [field, ref] of [["username", userRef], ["password", passRef]] as const) {
      if (!ref) continue;
      let value: string | null = await env.channel.secret(env.cmdId, chosen.id, field); // (4)
      try {
        await sameOrigin(page, origin, field);
        await page.markFilled(ref);
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
  const sig = await page.signals().catch(() => ({ webauthn: false, captcha: false }));
  const next: Next = submitted ? classifyNext(url1, { url: await page.url(), fields: await page.fields(), ...sig }) : "unknown"; // (7)
  env.event("auth.login", { origin, provider: chosen.provider, account: chosen.accountMasked, outcome: "filled", submitted, next });
  return { filled: true, account: chosen.accountMasked, source: chosen.provider, submitted, next };
}

export interface CodeResult {
  filled: boolean;
  source: CodeSourceName;
  submitted: boolean;
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
  const order: CodeSourceName[] = want === "auto" ? (["totp", "email", "sms"] as CodeSourceName[]).filter((s) => (s === "totp" ? !!totpAccount : s === "email" ? !!env.email : smsAvailable)) : [want];
  if (!order.length) throw new TabAgentError("NOT_FOUND", `No code source is available for ${origin}`, "auth.status lists code sources and why they are unavailable.");

  const host = new URL(origin).host;
  let lastErr: unknown;
  for (const source of order) {
    const key = `${origin}|${source}`;
    try {
      if (!mem.approvedSources.has(key)) {
        const who = source === "totp" && totpAccount ? { accountId: totpAccount.id, accountMasked: totpAccount.accountMasked, provider: totpAccount.provider } : { accountId: `code-source:${source}`, accountMasked: maskAccount(""), provider: source };
        await env.consent(url0, who, `Enter a ${source === "totp" ? "TOTP" : source} code on ${host}?`);
        mem.approvedSources.add(key);
      }
      let code: string | null =
        source === "totp" ? await env.channel.secret(env.cmdId, totpAccount!.id, "totp") : source === "email" ? await env.email!.fetch({ since, from: p.from, timeout }) : await env.channel.smsCode(env.cmdId, since, timeout);
      try {
        if (!/^[A-Za-z0-9]{4,10}$/.test(code)) throw new TabAgentError("BAD_REQUEST", "The code source returned something that is not a code");
        await sameOrigin(page, origin, "code");
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
      if (p.submit !== false) {
        await sameOrigin(page, origin, "form");
        await page.submit(dest[dest.length - 1]);
        submitted = true;
        await page.settle();
      }
      env.event("auth.code", { origin, source, outcome: "filled", submitted });
      return { filled: true, source, submitted };
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
