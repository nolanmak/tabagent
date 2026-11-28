// #33 / #34 flows against a fake page, fake bridge channel and fake gate, including the no-leak
// property: a random marker secret never appears in the Result, audit, feed/events, storage,
// a snapshot taken afterwards, or the diff.
import fc from "fast-check";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FieldDesc } from "../src/background/auth/pure/fields";
import { CODE_SINCE_SLACK_MS } from "@tabagent/protocol";
import type { MailLink } from "../src/background/auth/pure/confirm-link";
import { authCode, authConfirmLink, authLogin, authSignup, authStatus, CHROME_AUTOFILL_ID, CONFIRM_LOOKBACK_MS, newMemory, type AuthEnv, type AuthPage, type PageField } from "../src/background/auth/pure/flows";

type Fd = Partial<FieldDesc> & { ref?: string };
function fields(...xs: Fd[]): PageField[] {
  return xs.map((x, i) => ({ i, ref: x.ref ?? `e${i + 1}`, tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", visible: true, form: 0, maxLength: -1, inputMode: "", ...x }));
}
const LOGIN = () => fields({ type: "email", name: "email" }, { type: "password", name: "password" });

interface Step {
  url: string;
  fields: PageField[];
  signals?: { webauthn: boolean; captcha: boolean };
}

/** A page: current step, typed values, masked refs, and a snapshot renderer honouring the mask contract. */
function fakePage(steps: Step[], o: { autofill?: { usernameMasked?: string } | null; navigateDuring?: string } = {}) {
  let k = 0;
  const values = new Map<string, string>();
  const masked = new Set<string>();
  const order: string[] = [];
  const visited: string[] = [];
  let urlOverride: string | null = null;
  const cur = () => steps[Math.min(k, steps.length - 1)];
  const snapshot = () =>
    cur()
      .fields.map((f) => {
        const v = values.get(f.ref) ?? "";
        const shown = f.type === "password" || masked.has(f.ref) || f.autocomplete.includes("one-time-code") ? (v ? "••••" : "") : v;
        return `- textbox "${f.name || f.label}" [ref=${f.ref}] value="${shown}"`;
      })
      .join("\n");
  const page: AuthPage = {
    url: async () => urlOverride ?? cur().url,
    fields: async () => cur().fields,
    signals: async () => cur().signals ?? { webauthn: false, captcha: false },
    chromeAutofill: async () => o.autofill ?? null,
    async type(ref, value) {
      order.push(`type ${ref}`);
      values.set(ref, (values.get(ref) ?? "") + value);
    },
    async markFilled(ref) {
      order.push(`mask ${ref}`);
      masked.add(ref);
    },
    async submit(ref) {
      order.push(`submit ${ref}`);
      k++;
    },
    async settle() {},
    async goto(url) {
      order.push("goto");
      visited.push(url);
      urlOverride = null;
      k++;
    },
  };
  return { page, values, masked, order, visited, snapshot, navigate: (u: string) => (urlOverride = u) };
}

interface EnvOpts {
  accounts?: any[];
  providers?: any[];
  codeSources?: any[];
  secrets?: Record<string, string>;
  enabled?: string[];
  deny?: boolean;
  onConsent?: () => void;
  /** What the gate reports back: "authAuto" when the site signs in without asking (#131). */
  consentVia?: "authAuto";
  email?: (o: any) => Promise<string>;
  sms?: () => Promise<string>;
  create?: (origin: string, username?: string) => Promise<any>;
  mail?: { messages: (o: any) => Promise<{ id: string; date: number }[]>; links: (id: string) => Promise<MailLink[]> };
}

function fakeEnv(o: EnvOpts = {}) {
  const calls = { accounts: 0, secret: [] as string[], consent: [] as any[], sms: 0, email: 0, create: [] as { origin: string; username?: string }[], messages: [] as any[], links: [] as string[] };
  const events: { name: string; data: any }[] = [];
  const storage = new Map<string, unknown>();
  const env: AuthEnv = {
    cmdId: "cmd-1",
    tabId: 5,
    async siteCheck(url) {
      const origin = new URL(url).origin;
      if (!url.startsWith("https:")) throw Object.assign(new Error("https only"), { code: "PERMISSION_DENIED" });
      if (!(o.enabled ?? ["https://github.com"]).includes(origin)) throw Object.assign(new Error("Sign-in is not enabled"), { code: "PERMISSION_DENIED" });
    },
    async consent(url, who, summary) {
      calls.consent.push({ url, who, summary });
      o.onConsent?.();
      if (o.deny) throw Object.assign(new Error("The user declined"), { code: "PERMISSION_DENIED" });
      storage.set(`authAlways:${new URL(url).origin}`, [who.accountId]);
      return o.consentVia;
    },
    channel: {
      async accounts(_c, origin) {
        calls.accounts++;
        return { type: "auth.accounts.result", id: "x", ok: true, accounts: o.accounts ?? [], providers: o.providers ?? [{ name: "1password", state: "unlocked" }], codeSources: o.codeSources ?? [] } as any;
      },
      async secret(_c, id, field) {
        calls.secret.push(`${id}:${field}`);
        const v = o.secrets?.[field];
        if (v === undefined) throw Object.assign(new Error("no secret"), { code: "NOT_FOUND" });
        return v;
      },
      async smsCode() {
        calls.sms++;
        if (!o.sms) throw Object.assign(new Error("no sms"), { code: "NOT_FOUND" });
        return o.sms();
      },
      async createLogin(_c, origin, username) {
        calls.create.push({ origin, username });
        if (!o.create) throw Object.assign(new Error("no create"), { code: "UNSUPPORTED" });
        return o.create(origin, username);
      },
    },
    email: o.email ? { fetch: async (x) => (calls.email++, o.email!(x)) } : undefined,
    confirmMail: o.mail ? { messages: async (x) => (calls.messages.push({ ...x, skip: [...x.skip] }), o.mail!.messages(x)), links: async (id) => (calls.links.push(id), o.mail!.links(id)) } : undefined,
    event: (name, data) => events.push({ name, data }),
    now: () => 1_000_000,
  };
  return { env, calls, events, storage };
}

const GH = (id = "abc", user = "nolan@gmail.com", extra: any = {}) => ({ id: `1password:${id}`, provider: "1password", accountMasked: user[0] + "•••@gmail.com", uris: [{ uri: "https://github.com" }], ...extra });
const okSteps = (): Step[] => [
  { url: "https://github.com/login", fields: LOGIN() },
  { url: "https://github.com/", fields: fields({ name: "q", label: "Search" }) },
];

/** What the router would audit for this command (D20): tool, origin, redacted params, sha of the result. */
const audit = (tool: string, params: unknown, result: unknown) => {
  const r = JSON.stringify(result);
  return JSON.stringify({ tool, origin: "https://github.com", params, outcome: "ok", resultSummary: { bytes: r.length, sha256: createHash("sha256").update(r).digest("hex") } });
};

describe("auth.login", () => {
  it("classic login: fills username + password, submits, next=done, masked account in result", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "nolan@gmail.com", password: "pw" } });
    const r = await authLogin(e.env, pg.page, {}, newMemory());
    expect(r).toEqual({ filled: true, account: "n•••@gmail.com", source: "1password", submitted: true, next: "done" });
    expect(pg.values.get("e1")).toBe("nolan@gmail.com");
    expect(pg.values.get("e2")).toBe("pw");
    // each field is masked before anything is typed into it
    expect(pg.order).toEqual(["mask e1", "type e1", "mask e2", "type e2", "submit e2"]);
    expect(e.calls.consent).toHaveLength(1);
    expect(e.calls.consent[0].summary).toBe("Sign in to github.com as n•••@gmail.com with 1password?");
  });

  it("no-leak property: a marker password is absent from Result, audit, events, storage, snapshot and diff", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8, maxLength: 40 }).filter((s) => s.trim().length >= 8 && !/[•"]/.test(s)), async (raw) => {
        const marker = `MARK${raw}`;
        const pg = fakePage([{ url: "https://github.com/login", fields: LOGIN() }, { url: "https://github.com/login", fields: LOGIN() }]);
        const before = pg.snapshot();
        const e = fakeEnv({ accounts: [GH()], secrets: { username: "nolan@gmail.com", password: marker } });
        const p = { submit: true };
        const r = await authLogin(e.env, pg.page, p, newMemory());
        const after = pg.snapshot();
        const diff = after.split("\n").filter((l) => !before.includes(l)).map((l) => "+ " + l).join("\n");
        const haystacks = [JSON.stringify(r), audit("auth.login", p, r), JSON.stringify(e.events), JSON.stringify([...e.storage]), after, diff];
        for (const h of haystacks) expect(h.includes(marker)).toBe(false);
        expect(pg.values.get("e2")).toBe(marker); // it did reach the page
      }),
      { numRuns: 40 },
    );
  });

  it("origin binding: item for github.com, tab on github.com.evil.example → PERMISSION_DENIED, secret never fetched", async () => {
    const pg = fakePage([{ url: "https://github.com.evil.example/login", fields: LOGIN() }]);
    const e = fakeEnv({ accounts: [GH()], secrets: { password: "x" }, enabled: ["https://github.com.evil.example"] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.secret).toEqual([]);
    expect(e.calls.consent).toEqual([]);
  });

  it("http page → refused before asking the bridge", async () => {
    const pg = fakePage([{ url: "http://github.com/login", fields: LOGIN() }]);
    const e = fakeEnv({ accounts: [GH()] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.accounts).toBe(0);
  });

  it("tab navigates between the prompt and the fill → refused, nothing fetched or typed", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" }, onConsent: () => pg.navigate("https://evil.example/login") });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.secret).toEqual([]);
    expect(pg.values.size).toBe(0);
  });

  it("not enabled for the origin → PERMISSION_DENIED, no prompt, no bridge call", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], enabled: [] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.accounts).toBe(0);
  });

  it("user denies the prompt → PERMISSION_DENIED, secret never fetched", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { password: "p" }, deny: true });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.secret).toEqual([]);
  });

  it("consent goes through category g with the account id (Always is per account, not per origin)", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH("bbb", "bob@gmail.com")], secrets: { username: "bob@gmail.com", password: "p" } });
    await authLogin(e.env, pg.page, {}, newMemory());
    expect(e.calls.consent[0].who).toEqual({ accountId: "1password:bbb", accountMasked: "b•••@gmail.com", provider: "1password" });
  });

  it("two matching accounts → masked list, nothing filled, no prompt", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH("a1", "alice@gmail.com"), GH("b2", "bob@gmail.com")], secrets: { password: "p" } });
    const r = await authLogin(e.env, pg.page, {}, newMemory());
    expect(r).toEqual({
      filled: false,
      submitted: false,
      next: "unknown",
      accounts: [
        { id: "1password:a1", provider: "1password", accountMasked: "a•••@gmail.com" },
        { id: "1password:b2", provider: "1password", accountMasked: "b•••@gmail.com" },
      ],
    });
    expect(e.calls.secret).toEqual([]);
    expect(e.calls.consent).toEqual([]);
    expect(pg.values.size).toBe(0);
  });

  it("account= picks one of several", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH("a1", "alice@gmail.com"), GH("b2", "bob@gmail.com")], secrets: { username: "bob@gmail.com", password: "p" } });
    const r = await authLogin(e.env, pg.page, { account: "1password:b2" }, newMemory());
    expect(r.account).toBe("b•••@gmail.com");
    expect(e.calls.secret).toEqual(["1password:b2:username", "1password:b2:password"]);
  });

  it("provider order and fallthrough: first provider with a match is used", async () => {
    const pg = fakePage(okSteps());
    const bw = { id: "bitwarden:z9", provider: "bitwarden", accountMasked: "n•••@gmail.com", uris: [{ uri: "github.com" }] };
    const e = fakeEnv({ accounts: [bw], providers: [{ name: "1password", state: "unlocked" }, { name: "bitwarden", state: "unlocked" }], secrets: { username: "u", password: "p" } });
    const r = await authLogin(e.env, pg.page, {}, newMemory());
    expect(r.source).toBe("bitwarden");
  });

  it("no matching account → NOT_FOUND naming providers that are not ready", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [], providers: [{ name: "1password", state: "locked" }] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("1password: locked") });
  });

  it("sign-up form → NOT_FOUND, nothing asked", async () => {
    const pg = fakePage([{ url: "https://github.com/signup", fields: fields({ name: "email" }, { type: "password" }, { type: "password", name: "confirm" }) }]);
    const e = fakeEnv({ accounts: [GH()] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(e.calls.accounts).toBe(0);
  });

  it("two-step login: first call fills only the username; second call fills only the password", async () => {
    const steps: Step[] = [
      { url: "https://github.com/login", fields: fields({ type: "email", name: "identifier", autocomplete: "username" }) },
      { url: "https://github.com/login/pw", fields: fields({ type: "password", name: "Passwd", ref: "e9" }) },
      { url: "https://github.com/", fields: [] },
    ];
    const pg = fakePage(steps);
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u@x.com", password: "p" } });
    const mem = newMemory();
    const r1 = await authLogin(e.env, pg.page, {}, mem);
    expect(r1.next).toBe("unknown");
    expect(e.calls.secret).toEqual(["1password:abc:username"]);
    const r2 = await authLogin(e.env, pg.page, {}, mem);
    expect(r2.next).toBe("done");
    expect(e.calls.secret).toEqual(["1password:abc:username", "1password:abc:password"]);
  });

  it("next=code_required when a one-time-code field follows", async () => {
    const pg = fakePage([okSteps()[0], { url: "https://github.com/sessions/two-factor", fields: fields({ autocomplete: "one-time-code" }) }]);
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" } });
    expect((await authLogin(e.env, pg.page, {}, newMemory())).next).toBe("code_required");
  });

  it("submit=false fills without submitting", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" } });
    const r = await authLogin(e.env, pg.page, { submit: false }, newMemory());
    expect(r).toMatchObject({ filled: true, submitted: false });
    expect(pg.order).not.toContain("submit e2");
  });

  it("passkey-only item → handoff_required, nothing filled", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH("pk", "n@gmail.com", { passkeyOnly: true })] });
    expect(await authLogin(e.env, pg.page, {}, newMemory())).toMatchObject({ filled: false, next: "handoff_required" });
    expect(e.calls.consent).toEqual([]);
  });

  it("re-prompt item is never filled", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH("rp", "n@gmail.com", { reprompt: true })] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("chrome-autofill: Chrome pre-filled the form; TabAgent asks, masks and submits without ever fetching a secret", async () => {
    const pg = fakePage(okSteps(), { autofill: { usernameMasked: "a•••@example.com" } });
    const e = fakeEnv({ accounts: [], providers: [] });
    const r = await authLogin(e.env, pg.page, {}, newMemory());
    expect(r).toEqual({ filled: true, account: "a•••@example.com", source: "chrome-autofill", submitted: true, next: "done" });
    expect(e.calls.secret).toEqual([]);
    expect(e.calls.consent[0].who.accountId).toBe(CHROME_AUTOFILL_ID);
    expect(pg.masked).toEqual(new Set(["e1", "e2"]));
  });

  it("chrome-autofill disabled in provider config → not offered", async () => {
    const pg = fakePage(okSteps(), { autofill: { usernameMasked: "a•••@example.com" } });
    const e = fakeEnv({ accounts: [], providers: [{ name: "chrome-autofill", state: "disabled" }] });
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("auth.status", () => {
  it("lists matching accounts per provider, unavailable providers with their state, code sources; no secrets", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({
      accounts: [GH("abc", "nolan@gmail.com", { hasTotp: true })],
      providers: [{ name: "1password", state: "unlocked", totp: "available" }, { name: "bitwarden", state: "missing", hint: "Install the Bitwarden CLI" }],
      codeSources: [{ name: "sms", state: "unreadable", hint: "Full Disk Access" }],
      email: async () => "1",
    });
    const r = await authStatus(e.env, pg.page);
    expect(r).toEqual({
      loginFormPresent: true,
      providers: [
        { name: "1password", state: "unlocked", totp: "available", accounts: [{ id: "1password:abc", accountMasked: "n•••@gmail.com", hasTotp: true }] },
        { name: "bitwarden", state: "missing", hint: "Install the Bitwarden CLI", accounts: [] },
      ],
      codeSources: [{ name: "sms", state: "unreadable", hint: "Full Disk Access" }, { name: "email", state: "available" }],
    });
    expect(e.calls.secret).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("uris");
  });

  it("http page → no providers queried", async () => {
    const pg = fakePage([{ url: "http://x.example/", fields: [] }]);
    const e = fakeEnv();
    expect(await authStatus(e.env, pg.page)).toEqual({ loginFormPresent: false, providers: [], codeSources: [] });
    expect(e.calls.accounts).toBe(0);
  });
});

describe("auth.code", () => {
  const codePage = (f = fields({ autocomplete: "one-time-code", name: "otp" })) => fakePage([{ url: "https://github.com/sessions/two-factor", fields: f }, { url: "https://github.com/", fields: [] }]);

  it("auto with a TOTP item → totp, typed into the one-time-code field, submitted", async () => {
    const pg = codePage();
    const e = fakeEnv({ accounts: [GH("abc", "n@gmail.com", { hasTotp: true })], secrets: { totp: "123456" } });
    const r = await authCode(e.env, pg.page, {}, newMemory());
    expect(r).toMatchObject({ filled: true, source: "totp", submitted: true, next: expect.any(String) });
    expect(pg.values.get("e1")).toBe("123456");
    expect(e.calls.secret).toEqual(["1password:abc:totp"]);
  });

  it("totp uses the account the last auth.login used on this tab; two TOTP items and no login → BAD_REQUEST with masked ids", async () => {
    const a = GH("a1", "alice@gmail.com", { hasTotp: true });
    const b = GH("b2", "bob@gmail.com", { hasTotp: true });
    const e = fakeEnv({ accounts: [a, b], secrets: { totp: "123456" } });
    await expect(authCode(e.env, codePage().page, { source: "totp" }, newMemory())).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("1password:a1 (a•••@gmail.com)") });
    const mem = newMemory();
    mem.lastAccount.set(5, { id: "1password:b2", origin: "https://github.com" });
    await authCode(e.env, codePage().page, { source: "totp" }, mem);
    expect(e.calls.secret).toEqual(["1password:b2:totp"]);
  });

  it("auto order totp → email → sms: no TOTP item, Gmail not signed in → falls through to sms", async () => {
    const pg = codePage();
    const e = fakeEnv({ accounts: [GH()], codeSources: [{ name: "sms", state: "available" }], email: async () => Promise.reject(Object.assign(new Error("Gmail is not signed in"), { code: "NOT_FOUND" })), sms: async () => "778899" });
    const r = await authCode(e.env, pg.page, {}, newMemory());
    expect(r.source).toBe("sms");
    expect(e.calls.email).toBe(1);
    expect(pg.values.get("e1")).toBe("778899");
  });

  it("source=email, Gmail not signed in → NOT_FOUND, nothing typed", async () => {
    const pg = codePage();
    const e = fakeEnv({ email: async () => Promise.reject(Object.assign(new Error("Gmail is not signed in"), { code: "NOT_FOUND" })) });
    await expect(authCode(e.env, pg.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(pg.values.size).toBe(0);
  });

  it("email `since` defaults to the preceding auth.login minus 30s", async () => {
    const pg = codePage();
    let seen: any;
    const e = fakeEnv({ email: async (o) => ((seen = o), "112233") });
    const mem = newMemory();
    mem.lastLogin.set(5, 1_000_000 - 20_000);
    await authCode(e.env, pg.page, { source: "email", from: "github.com", timeout: 5000 }, mem);
    expect(seen).toEqual({ since: 1_000_000 - 20_000 - 30_000, from: "github.com", timeout: 5000 });
  });

  it("split six-box input is filled digit by digit", async () => {
    const pg = codePage(fields(...Array.from({ length: 6 }, () => ({ maxLength: 1, inputMode: "numeric" }))));
    const e = fakeEnv({ email: async () => "480516" });
    await authCode(e.env, pg.page, { source: "email" }, newMemory());
    expect(["e1", "e2", "e3", "e4", "e5", "e6"].map((r) => pg.values.get(r))).toEqual(["4", "8", "0", "5", "1", "6"]);
    expect(pg.masked.size).toBe(6);
  });

  it("no destination field → BAD_REQUEST, no code fetched", async () => {
    const pg = codePage(fields({ name: "q", label: "Search" }));
    const e = fakeEnv({ email: async () => "123456" });
    await expect(authCode(e.env, pg.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(e.calls.email).toBe(0);
  });

  it("explicit ref is used as the destination", async () => {
    const pg = codePage(fields({ name: "q", label: "Search" }, { name: "weird", ref: "e42" }));
    const e = fakeEnv({ email: async () => "123456" });
    await authCode(e.env, pg.page, { source: "email", ref: "e42" }, newMemory());
    expect(pg.values.get("e42")).toBe("123456");
  });

  it("consent per source, the first time per origin only", async () => {
    const pg = codePage();
    const e = fakeEnv({ email: async () => "123456" });
    const mem = newMemory();
    await authCode(e.env, pg.page, { source: "email", submit: false }, mem);
    await authCode(e.env, codePage().page, { source: "email", submit: false }, mem);
    expect(e.calls.consent).toHaveLength(1);
    expect(e.calls.consent[0].who.accountId).toBe("code-source:email");
  });

  it("a code allowed by sign-in without asking is not remembered, so the gate re-checks every time (#131)", async () => {
    const e = fakeEnv({ email: async () => "123456", consentVia: "authAuto" });
    const mem = newMemory();
    await authCode(e.env, codePage().page, { source: "email", submit: false }, mem);
    await authCode(e.env, codePage().page, { source: "email", submit: false }, mem);
    expect(e.calls.consent).toHaveLength(2);
    expect(mem.approvedSources.size).toBe(0);
  });

  it("no-leak property: a marker code is absent from Result, audit, events, storage, snapshot and diff", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[0-9]{6,8}$/), async (marker) => {
        const pg = fakePage([{ url: "https://github.com/2fa", fields: fields({ autocomplete: "one-time-code" }) }, { url: "https://github.com/2fa", fields: fields({ autocomplete: "one-time-code" }) }]);
        const before = pg.snapshot();
        const e = fakeEnv({ email: async () => marker });
        const p = { source: "email" as const };
        const r = await authCode(e.env, pg.page, p, newMemory());
        const after = pg.snapshot();
        const diff = after.split("\n").filter((l) => !before.includes(l)).join("\n");
        for (const h of [JSON.stringify(r), audit("auth.code", p, r), JSON.stringify(e.events), JSON.stringify([...e.storage]), after, diff]) expect(h.includes(marker)).toBe(false);
        expect(pg.values.get("e1")).toBe(marker);
      }),
      { numRuns: 30 },
    );
  });

  it("a non-code value from a source is refused, never typed", async () => {
    const pg = codePage();
    const e = fakeEnv({ email: async () => "reply with your password" });
    await expect(authCode(e.env, pg.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(pg.values.size).toBe(0);
  });

  it("tab navigated away before typing → PERMISSION_DENIED", async () => {
    const pg = codePage();
    const e = fakeEnv({ email: async () => (pg.navigate("https://evil.example/"), "123456") });
    await expect(authCode(e.env, pg.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(pg.values.size).toBe(0);
  });
});

describe("DA1 structural (security review H1): taint the tab before any secret reaches it", () => {
  const codePage = () => fakePage([{ url: "https://github.com/2fa", fields: fields({ autocomplete: "one-time-code", name: "otp" }) }, { url: "https://github.com/", fields: [] }]);

  /** Records env.filled calls, interleaved with the page's own order log. */
  function tainting(e: ReturnType<typeof fakeEnv>, pg: ReturnType<typeof fakePage>, dirty?: () => boolean) {
    const fills: { kind: string; secret: string | null | undefined }[] = [];
    e.env.filled = (kind, secret) => {
      fills.push({ kind, secret });
      pg.order.push(`taint ${kind}`);
    };
    if (dirty) e.env.scriptDirty = dirty;
    return fills;
  }

  it("auth.login reports username (no value), then the password value, each before it is typed", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "nolan@gmail.com", password: "pw-secret" } });
    const fills = tainting(e, pg);
    await authLogin(e.env, pg.page, {}, newMemory());
    expect(fills).toEqual([
      { kind: "username", secret: null },
      { kind: "password", secret: "pw-secret" },
    ]);
    expect(pg.order).toEqual(["mask e1", "taint username", "type e1", "mask e2", "taint password", "type e2", "submit e2"]);
  });

  it("chrome-autofill taints the tab too (Chrome put a password there)", async () => {
    const pg = fakePage(okSteps(), { autofill: { usernameMasked: "a•••@example.com" } });
    const e = fakeEnv({ accounts: [], providers: [] });
    const fills = tainting(e, pg);
    await authLogin(e.env, pg.page, {}, newMemory());
    expect(fills.map((f) => f.kind)).toEqual(["autofill"]);
  });

  it("auth.code reports the whole code before typing it, also into split boxes", async () => {
    const box = { autocomplete: "one-time-code", maxLength: 1 };
    const pg = fakePage([{ url: "https://github.com/2fa", fields: fields(box, box, box, box) }, { url: "https://github.com/", fields: [] }]);
    const e = fakeEnv({ email: async () => "4821" });
    const fills = tainting(e, pg);
    await authCode(e.env, pg.page, { source: "email" }, newMemory());
    expect(fills).toEqual([{ kind: "code", secret: "4821" }]);
    expect(pg.order.indexOf("taint code")).toBeLessThan(pg.order.indexOf("type e1"));
  });

  it("agent JavaScript already ran in this document (it could be listening for keystrokes) → refused before consent, nothing fetched", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" } });
    tainting(e, pg, () => true);
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.secret).toEqual([]);
    const c = codePage();
    const e2 = fakeEnv({ email: async () => "123456" });
    tainting(e2, c, () => true);
    await expect(authCode(e2.env, c.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e2.calls.email).toBe(0);
    expect(c.values.size).toBe(0);
  });

  it("restart lock: the refusal says TabAgent restarted and when typing resumes, not that agent JavaScript ran", async () => {
    const pg = fakePage(okSteps());
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" } });
    tainting(e, pg, () => true);
    const until = Date.now() + 7 * 60_000;
    e.env.restartLockedUntil = () => until;
    const err = await authLogin(e.env, pg.page, {}, newMemory()).catch((x) => x);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.message).toMatch(/restarted/i);
    expect(err.message).not.toMatch(/Agent JavaScript ran/);
    expect(err.hint).toMatch(/side panel/i);
    expect(e.calls.secret).toEqual([]);
  });

  it("agent JavaScript that starts during the prompt → refused before the first keystroke", async () => {
    const pg = fakePage(okSteps());
    let dirty = false;
    const e = fakeEnv({ accounts: [GH()], secrets: { username: "u", password: "p" }, onConsent: () => (dirty = true) });
    tainting(e, pg, () => dirty);
    await expect(authLogin(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(pg.values.size).toBe(0);
  });
});


describe("Sign in with Google (#82, #83)", () => {
  const G = "https://accounts.google.com";
  const GA = (id: string, masked: string) => ({ id: `bitwarden:${id}`, provider: "bitwarden", accountMasked: masked, uris: [{ uri: G }] });
  const idPage = () => fields({ type: "email", name: "identifier", autocomplete: "username" });
  const pwPage = () => fields({ type: "password", name: "Passwd" });
  const genv = (extra: EnvOpts = {}) => fakeEnv({ enabled: [G], accounts: [GA("a1", "nol•••k7@gmail.com"), GA("a2", "nat•••.k@gmail.com")], secrets: { username: "u@gmail.com", password: "pw" }, ...extra });

  it("two-step: the password call reuses the identifier call's account and does not ask again (D6e)", async () => {
    const pg = fakePage([
      { url: `${G}/v3/signin/identifier`, fields: idPage() },
      { url: `${G}/v3/signin/challenge/pwd`, fields: pwPage() },
      { url: "https://www.example-shop.com/", fields: fields({ name: "q", label: "Search" }) },
    ]);
    const e = genv();
    const mem = newMemory();
    const r1 = await authLogin(e.env, pg.page, { account: "bitwarden:a1" }, mem);
    expect(r1.next).toBe("unknown");
    const r2 = await authLogin(e.env, pg.page, {}, mem);
    expect(r2).toMatchObject({ filled: true, account: "nol•••k7@gmail.com", next: "done" });
    expect(e.calls.consent).toHaveLength(1);
  });

  it("two-step: naming a different account on the second call is a new sign-in and asks", async () => {
    const pg = fakePage([
      { url: `${G}/v3/signin/identifier`, fields: idPage() },
      { url: `${G}/v3/signin/challenge/pwd`, fields: pwPage() },
      { url: "https://www.example-shop.com/", fields: fields({ name: "q", label: "Search" }) },
    ]);
    const e = genv();
    const mem = newMemory();
    await authLogin(e.env, pg.page, { account: "bitwarden:a1" }, mem);
    await authLogin(e.env, pg.page, { account: "bitwarden:a2" }, mem);
    expect(e.calls.consent).toHaveLength(2);
  });

  it("without an account and several Google logins, it returns the list instead of guessing", async () => {
    const pg = fakePage([{ url: `${G}/v3/signin/identifier`, fields: idPage() }]);
    const r = await authLogin(genv().env, pg.page, {}, newMemory());
    expect(r.filled).toBe(false);
    expect(r.accounts?.map((a) => a.accountMasked)).toEqual(["nol•••k7@gmail.com", "nat•••.k@gmail.com"]);
  });

  it("a popup that closes after the password submit reports done instead of throwing (D11)", async () => {
    const pg = fakePage([{ url: `${G}/v3/signin/challenge/pwd`, fields: pwPage() }]);
    let closed = false;
    const page: AuthPage = {
      ...pg.page,
      async submit(ref) {
        await pg.page.submit(ref);
        closed = true;
      },
      url: async () => {
        if (closed) throw new Error("No tab with id: 5");
        return `${G}/v3/signin/challenge/pwd`;
      },
      fields: async () => {
        if (closed) throw new Error("No tab with id: 5");
        return pwPage();
      },
      closed: async () => closed,
    };
    const r = await authLogin(genv().env, page, { account: "bitwarden:a1" }, newMemory());
    expect(r).toMatchObject({ filled: true, submitted: true, next: "done" });
  });

  it("source=email is refused on accounts.google.com (D7b)", async () => {
    const pg = fakePage([{ url: `${G}/v3/signin/challenge/ipp`, fields: fields({ autocomplete: "one-time-code" }) }]);
    const e = genv({ email: async () => "123456" });
    await expect(authCode(e.env, pg.page, { source: "email" }, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.email).toBe(0);
  });

  it("source=auto on accounts.google.com skips email and uses SMS (D7b)", async () => {
    const pg = fakePage([{ url: `${G}/v3/signin/challenge/ipp`, fields: fields({ autocomplete: "one-time-code" }) }]);
    const e = genv({ email: async () => "111111", sms: async () => "222222", codeSources: [{ name: "sms", state: "available" }] });
    const r = await authCode(e.env, pg.page, { source: "auto", submit: false }, newMemory());
    expect(r.source).toBe("sms");
    expect(pg.values.get("e1")).toBe("222222");
    expect(e.calls.email).toBe(0);
  });
});

describe("auth.signup (#112)", () => {
  const SIGNUP = () => fields({ type: "email", name: "email", autocomplete: "email" }, { type: "password", name: "password", autocomplete: "new-password" }, { type: "password", name: "confirm", autocomplete: "new-password" });
  const signupSteps = (after: PageField[] = fields({ name: "q", label: "Search" })): Step[] => [
    { url: "https://github.com/signup", fields: SIGNUP() },
    { url: "https://github.com/welcome", fields: after },
  ];
  const BW = { name: "bitwarden", state: "unlocked", userMasked: "o•••@example.invalid" };
  const NEW = { id: "bitwarden:new-1", provider: "bitwarden", accountMasked: "n•••@gmail.com", uris: [{ uri: "https://github.com", match: "domain" }] };
  const senv = (o: EnvOpts & { pw?: string } = {}) => {
    const log: string[] = [];
    const e = fakeEnv({
      providers: [BW],
      secrets: { password: o.pw ?? "GEN-pw-marker", username: "owner@example.invalid" },
      create: async () => (log.push("create"), NEW),
      ...o,
      onConsent: () => (log.push("consent"), o.onConsent?.()),
    });
    const filled: string[] = [];
    e.env.filled = (kind, secret) => filled.push(`${kind}:${secret === null ? "-" : "secret"}`);
    return { ...e, log, filled };
  };

  it("creates the login after consent, fills email + both new-password fields with the same secret, submits", async () => {
    const PW = `GEN-${Math.random().toString(36).slice(2)}`;
    const pg = fakePage(signupSteps());
    const e = senv({ pw: PW });
    const r = await authSignup(e.env, pg.page, { email: "nolan@gmail.com" });
    expect(r).toEqual({ created: true, account: "n•••@gmail.com", accountId: "bitwarden:new-1", source: "bitwarden", filled: true, submitted: true, next: "done" });
    expect(e.log).toEqual(["consent", "create"]);
    expect(e.calls.create).toEqual([{ origin: "https://github.com", username: "nolan@gmail.com" }]);
    expect(e.calls.consent).toHaveLength(1);
    expect(e.calls.consent[0].summary).toBe("Create an account on github.com as n•••@gmail.com and save it to Bitwarden?");
    expect(e.calls.consent[0].who).toMatchObject({ provider: "bitwarden", accountMasked: "n•••@gmail.com", signup: true });
    // One password fetch for the new item, typed into both fields.
    expect(e.calls.secret).toEqual(["bitwarden:new-1:password"]);
    expect(pg.values.get("e1")).toBe("nolan@gmail.com");
    expect(pg.values.get("e2")).toBe(PW);
    expect(pg.values.get("e3")).toBe(PW);
    expect(pg.order).toEqual(["mask e1", "type e1", "mask e2", "type e2", "mask e3", "type e3", "submit e3"]);
    // DA1: the tab is tainted with the password before it is typed.
    expect(e.filled).toEqual(["username:-", "password:secret"]);
    for (const h of [JSON.stringify(r), JSON.stringify(e.events), JSON.stringify(e.calls.consent), pg.snapshot()]) expect(h).not.toContain(PW);
    expect(e.events.at(-1)).toMatchObject({ name: "auth.signup", data: { origin: "https://github.com", provider: "bitwarden", account: "n•••@gmail.com", outcome: "filled" } });
  });

  it("consent is asked every time, even after the user said Always for that account", async () => {
    const e = senv();
    await authSignup(e.env, fakePage(signupSteps()).page, { email: "nolan@gmail.com" });
    expect(e.storage.size).toBe(1); // the fake gate stored an Always
    await authSignup(e.env, fakePage(signupSteps()).page, { email: "nolan@gmail.com" });
    expect(e.calls.consent).toHaveLength(2);
  });

  it("without email: names the Bitwarden account email in the prompt and types it from the new item", async () => {
    const pg = fakePage(signupSteps());
    const e = senv({ create: async () => ({ ...NEW, accountMasked: "o•••@example.invalid" }) });
    const r = await authSignup(e.env, pg.page, {});
    expect(e.calls.consent[0].summary).toBe("Create an account on github.com as o•••@example.invalid and save it to Bitwarden?");
    expect(e.calls.create).toEqual([{ origin: "https://github.com", username: undefined }]);
    expect(e.calls.secret).toEqual(["bitwarden:new-1:username", "bitwarden:new-1:password"]);
    expect(pg.values.get("e1")).toBe("owner@example.invalid");
    expect(r.account).toBe("o•••@example.invalid");
  });

  it("username field too: fills email and username", async () => {
    const pg = fakePage([{ url: "https://github.com/signup", fields: fields({ type: "text", name: "username", autocomplete: "username" }, { type: "email", name: "email" }, { type: "password", name: "password", autocomplete: "new-password" }) }]);
    const e = senv();
    await authSignup(e.env, pg.page, { email: "nolan@gmail.com", username: "nolan-dev", submit: false });
    expect(pg.values.get("e1")).toBe("nolan-dev");
    expect(pg.values.get("e2")).toBe("nolan@gmail.com");
    expect(e.calls.create).toEqual([{ origin: "https://github.com", username: "nolan@gmail.com" }]);
  });

  it("a form that wants a username and an email without username= → BAD_REQUEST before the prompt", async () => {
    const pg = fakePage([{ url: "https://github.com/signup", fields: fields({ type: "text", name: "username", autocomplete: "username" }, { type: "email", name: "email" }, { type: "password", name: "password", autocomplete: "new-password" }) }]);
    const e = senv();
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.create).toEqual([]);
  });

  it("refuses a login page (not a sign-up form): no prompt, nothing created", async () => {
    const pg = fakePage(okSteps());
    const e = senv();
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.create).toEqual([]);
  });

  it("refuses a change-password form (current-password present)", async () => {
    const pg = fakePage([{ url: "https://github.com/settings", fields: fields({ type: "password", autocomplete: "current-password" }, { type: "password", autocomplete: "new-password" }, { type: "password", autocomplete: "new-password" }) }]);
    const e = senv();
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(e.calls.create).toEqual([]);
  });

  it("Bitwarden locked → NOT_FOUND with the unlock hint, no prompt, nothing created", async () => {
    const pg = fakePage(signupSteps());
    const e = senv({ providers: [{ name: "bitwarden", state: "locked", hint: "Bitwarden is locked: ask the user to run `tabagent bitwarden unlock`." }] });
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("tabagent bitwarden unlock") });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.create).toEqual([]);
  });

  it("only 1Password → UNSUPPORTED (only Bitwarden creates logins)", async () => {
    const pg = fakePage(signupSteps());
    const e = senv({ providers: [{ name: "1password", state: "unlocked" }] });
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(e.calls.consent).toEqual([]);
  });

  it("site not enabled / denylisted → PERMISSION_DENIED before anything else", async () => {
    const pg = fakePage(signupSteps());
    const e = senv({ enabled: [] });
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.accounts).toBe(0);
    expect(e.calls.consent).toEqual([]);
  });

  it("user denies → nothing created", async () => {
    const e = senv({ deny: true });
    await expect(authSignup(e.env, fakePage(signupSteps()).page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.create).toEqual([]);
  });

  it("tab navigates during the prompt → refused, nothing created", async () => {
    const pg = fakePage(signupSteps());
    const e = senv({ onConsent: () => pg.navigate("https://evil.example/signup") });
    await expect(authSignup(e.env, pg.page, { email: "nolan@gmail.com" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.create).toEqual([]);
  });

  it("fill fails after the item was created → the error names the kept item", async () => {
    const pg = fakePage(signupSteps());
    const type = pg.page.type;
    pg.page.type = async (ref, v) => {
      if (ref === "e2") throw Object.assign(new Error("Node is detached"), { code: "REF_STALE" });
      return type(ref, v);
    };
    const e = senv();
    const err = await authSignup(e.env, pg.page, { email: "nolan@gmail.com" }).catch((x) => x);
    expect(err.code).toBe("REF_STALE");
    expect(err.message).toContain("bitwarden:new-1");
    expect(err.message).toContain("n•••@gmail.com");
    expect(err.message).not.toContain("GEN-pw-marker");
    expect(e.calls.create).toHaveLength(1);
  });

  it("sign-up form still there after submit → next unknown", async () => {
    const pg = fakePage([{ url: "https://github.com/signup", fields: SIGNUP() }]);
    const r = await authSignup(senv().env, pg.page, { email: "nolan@gmail.com" });
    expect(r).toMatchObject({ created: true, filled: true, submitted: true, next: "unknown" });
  });
});

describe("auth.confirm_link (#113)", () => {
  const SITE = "https://example.com";
  const checkEmail = () => fakePage([{ url: `${SITE}/signup/check-email`, fields: [] }, { url: `${SITE}/welcome`, fields: fields({ name: "q", label: "Search" }) }]);
  const L = (href: string, text = ""): MailLink => ({ href, text });
  /** A reader holding fixed messages (newest first); `skip` is honoured like the real poll. */
  const mailbox = (links: Record<string, MailLink[]>) => ({
    messages: async (o: { skip: Set<string> }) => {
      const ids = Object.keys(links).filter((id) => !o.skip.has(id));
      if (!ids.length) throw Object.assign(new Error("No matching email arrived"), { code: "TIMEOUT" });
      return ids.map((id, i) => ({ id, date: 1_000_000 - i }));
    },
    links: async (id: string) => links[id] ?? [],
  });
  const cenv = (mail: EnvOpts["mail"], extra: EnvOpts = {}) => fakeEnv({ enabled: [SITE], mail, ...extra });

  it("one confirmation link on the site's domain → consent, tab navigated to it, { followed: true, next }", async () => {
    const pg = checkEmail();
    const e = cenv(mailbox({ m1: [L("https://example.com/", "Home"), L("https://id.example.com/verify?token=t1", "Verify email"), L("https://example.com/unsubscribe", "Unsubscribe")] }));
    const r = await authConfirmLink(e.env, pg.page, {}, newMemory());
    expect(r).toEqual({ followed: true, next: "done" });
    expect(pg.visited).toEqual(["https://id.example.com/verify?token=t1"]);
    expect(e.calls.consent).toHaveLength(1);
    expect(e.calls.consent[0].summary).toBe("Open the confirmation email from example.com in Gmail and follow its link?");
    expect(e.calls.consent[0].who.accountId).toBe("confirm-link:email");
    expect(e.calls.messages[0]).toMatchObject({ from: "example.com", timeout: 60_000 });
    expect(e.events).toEqual([{ name: "auth.confirm_link", data: { origin: SITE, outcome: "followed", next: "done" } }]);
  });

  it("consent once per origin; a followed message is not followed again", async () => {
    const e = cenv(mailbox({ m1: [L("https://example.com/confirm/1")] }));
    const mem = newMemory();
    await authConfirmLink(e.env, checkEmail().page, {}, mem);
    await expect(authConfirmLink(e.env, checkEmail().page, {}, mem)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(e.calls.consent).toHaveLength(1);
    expect(e.calls.messages[1].skip).toEqual(["m1"]);
  });

  it("`since` is the last auth action on the tab minus slack; otherwise a short lookback", async () => {
    const e = cenv(mailbox({ m1: [L("https://example.com/confirm/1")] }));
    const mem = newMemory();
    mem.lastLogin.set(5, 1_000_000 - 90_000);
    await authConfirmLink(e.env, checkEmail().page, { from: "mailer.example.com", timeout: 5000 }, mem);
    expect(e.calls.messages[0]).toMatchObject({ since: 1_000_000 - 90_000 - CODE_SINCE_SLACK_MS, from: "mailer.example.com", timeout: 5000 });
    const e2 = cenv(mailbox({ m1: [L("https://example.com/confirm/1")] }));
    await authConfirmLink(e2.env, checkEmail().page, {}, newMemory());
    expect(e2.calls.messages[0].since).toBe(1_000_000 - CONFIRM_LOOKBACK_MS);
  });

  it("several confirmation links → handoff_required (ambiguous), nothing followed", async () => {
    const pg = checkEmail();
    const e = cenv(mailbox({ m1: [L("https://example.com/confirm?k=1"), L("https://example.com/verify?k=2")] }));
    expect(await authConfirmLink(e.env, pg.page, {}, newMemory())).toEqual({ followed: false, next: "handoff_required", reason: "ambiguous" });
    expect(pg.visited).toEqual([]);
    expect(e.events[0].data).toMatchObject({ outcome: "handoff_required", reason: "ambiguous" });
  });

  it("newest matching mail has no confirmation link (a welcome mail) → the next one is checked", async () => {
    const pg = checkEmail();
    const e = cenv(mailbox({ welcome: [L("https://example.com/dashboard", "Get started")], confirm: [L("https://example.com/activate/a1", "Activate")] }));
    expect(await authConfirmLink(e.env, pg.page, {}, newMemory())).toMatchObject({ followed: true });
    expect(e.calls.links).toEqual(["welcome", "confirm"]);
    expect(pg.visited).toEqual(["https://example.com/activate/a1"]);
  });

  it("only look-alike / off-domain links, then no further mail → handoff_required (none)", async () => {
    const pg = checkEmail();
    const e = cenv(mailbox({ m1: [L("https://example.com.evil.net/verify", "Verify"), L("https://click.tracker.example.net/c?u=https%3A%2F%2Fexample.com%2Fverify", "Verify")] }));
    expect(await authConfirmLink(e.env, pg.page, {}, newMemory())).toEqual({ followed: false, next: "handoff_required", reason: "none" });
    expect(pg.visited).toEqual([]);
  });

  it("no matching mail at all → TIMEOUT; Gmail not signed in → NOT_FOUND; no reader → NOT_FOUND", async () => {
    const fail = (code: string) => cenv({ messages: async () => Promise.reject(Object.assign(new Error(code), { code })), links: async () => [] });
    await expect(authConfirmLink(fail("TIMEOUT").env, checkEmail().page, {}, newMemory())).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(authConfirmLink(fail("NOT_FOUND").env, checkEmail().page, {}, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(authConfirmLink(cenv(undefined).env, checkEmail().page, {}, newMemory())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("site not enabled for sign-in → PERMISSION_DENIED before consent or any mail read", async () => {
    const e = fakeEnv({ enabled: [], mail: mailbox({ m1: [L("https://example.com/confirm/1")] }) });
    await expect(authConfirmLink(e.env, checkEmail().page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.consent).toEqual([]);
    expect(e.calls.messages).toEqual([]);
  });

  it("user declines → PERMISSION_DENIED, mail never read", async () => {
    const e = cenv(mailbox({ m1: [L("https://example.com/confirm/1")] }), { deny: true });
    await expect(authConfirmLink(e.env, checkEmail().page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.messages).toEqual([]);
  });

  it("refused on accounts.google.com and on http pages", async () => {
    const G = "https://accounts.google.com";
    const e = fakeEnv({ enabled: [G], mail: mailbox({ m1: [L(`${G}/confirm`)] }) });
    await expect(authConfirmLink(e.env, fakePage([{ url: `${G}/signup`, fields: [] }]).page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(authConfirmLink(cenv(mailbox({})).env, fakePage([{ url: "http://example.com/x", fields: [] }]).page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(e.calls.messages).toEqual([]);
  });

  it("tab left the site while the mail was read → PERMISSION_DENIED, nothing followed", async () => {
    const pg = checkEmail();
    const e = cenv({ messages: async () => (pg.navigate("https://evil.example/"), [{ id: "m1", date: 1 }]), links: async () => [L("https://example.com/confirm/1")] });
    await expect(authConfirmLink(e.env, pg.page, {}, newMemory())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(pg.visited).toEqual([]);
  });

  it("subdomain sign-up page: links anywhere on the registrable domain qualify", async () => {
    const pg = fakePage([{ url: "https://app.example.com/register/done", fields: [] }, { url: "https://example.com/ok", fields: [] }]);
    const e = fakeEnv({ enabled: ["https://app.example.com"], mail: mailbox({ m1: [L("https://accounts.example.com/confirm/9", "Confirm")] }) });
    expect(await authConfirmLink(e.env, pg.page, {}, newMemory())).toMatchObject({ followed: true });
    expect(e.calls.messages[0].from).toBe("example.com");
  });

  it("no-leak property: the link and the mail text never reach the result, events or errors", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9]{12,24}$/), fc.boolean(), async (marker, ambiguous) => {
        const pg = checkEmail();
        const links = [L(`https://example.com/verify?token=${marker}`, `Verify ${marker}`), ...(ambiguous ? [L(`https://example.com/confirm/${marker}x`)] : [])];
        const e = cenv(mailbox({ m1: links }));
        const p = {};
        let out: unknown;
        try {
          out = await authConfirmLink(e.env, pg.page, p, newMemory());
        } catch (err) {
          out = { message: (err as Error).message, hint: (err as any).hint };
        }
        for (const h of [JSON.stringify(out), audit("auth.confirm_link", p, out), JSON.stringify(e.events), JSON.stringify([...e.storage]), JSON.stringify(e.calls.consent)]) expect(h.includes(marker)).toBe(false);
      }),
      { numRuns: 30 },
    );
  });
});

describe("auth.code on a post-sign-up confirm page (#113)", () => {
  it("an emailed sign-up code is typed into the confirm page's code field", async () => {
    const pg = fakePage([{ url: "https://github.com/signup/verify-email", fields: fields({ name: "launch_code", autocomplete: "one-time-code", inputMode: "numeric" }) }, { url: "https://github.com/dashboard", fields: [] }]);
    const e = fakeEnv({ email: async () => "604213" });
    const mem = newMemory();
    mem.lastLogin.set(5, 1_000_000 - 30_000); // the sign-up just ran on this tab
    const r = await authCode(e.env, pg.page, { source: "email", from: "github.com" }, mem);
    expect(r).toMatchObject({ filled: true, source: "email", submitted: true, next: expect.any(String) });
    expect(pg.values.get("e1")).toBe("604213");
  });
});


describe("auth.code reports next (#79 live QA)", () => {
  it("after submitting a code onto a Google security interstitial, next is handoff_required", async () => {
    const G = "https://accounts.google.com";
    const pg = fakePage([
      { url: `${G}/v3/signin/challenge/ipp/verify`, fields: fields({ autocomplete: "one-time-code" }) },
      { url: `${G}/u/0/signin/suspiciousactivity`, fields: [] },
    ]);
    const e = fakeEnv({ enabled: [G], sms: async () => "123456", codeSources: [{ name: "sms", state: "available" }] });
    const r = await authCode(e.env, pg.page, { source: "sms" }, newMemory());
    expect(r).toMatchObject({ filled: true, submitted: true, next: "handoff_required" });
  });
  it("after submitting a code that lands back on the site, next is done", async () => {
    const pg = fakePage([
      { url: "https://github.com/2fa", fields: fields({ autocomplete: "one-time-code" }) },
      { url: "https://github.com/", fields: fields({ name: "q", label: "Search" }) },
    ]);
    const e = fakeEnv({ email: async () => "123456" });
    const r = await authCode(e.env, pg.page, { source: "email" }, newMemory());
    expect(r.next).toBe("done");
  });
  it("without submit, next is unknown", async () => {
    const pg = fakePage([{ url: "https://github.com/2fa", fields: fields({ autocomplete: "one-time-code" }) }]);
    const r = await authCode(fakeEnv({ email: async () => "123456" }).env, pg.page, { source: "email", submit: false }, newMemory());
    expect(r.next).toBe("unknown");
  });
});
