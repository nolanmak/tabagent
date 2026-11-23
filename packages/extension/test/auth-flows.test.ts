// #33 / #34 flows against a fake page, fake bridge channel and fake gate, including the no-leak
// property: a random marker secret never appears in the Result, audit, feed/events, storage,
// a snapshot taken afterwards, or the diff.
import fc from "fast-check";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FieldDesc } from "../src/background/auth/pure/fields";
import { authCode, authLogin, authStatus, CHROME_AUTOFILL_ID, newMemory, type AuthEnv, type AuthPage, type PageField } from "../src/background/auth/pure/flows";

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
  };
  return { page, values, masked, order, snapshot, navigate: (u: string) => (urlOverride = u) };
}

interface EnvOpts {
  accounts?: any[];
  providers?: any[];
  codeSources?: any[];
  secrets?: Record<string, string>;
  enabled?: string[];
  deny?: boolean;
  onConsent?: () => void;
  email?: (o: any) => Promise<string>;
  sms?: () => Promise<string>;
}

function fakeEnv(o: EnvOpts = {}) {
  const calls = { accounts: 0, secret: [] as string[], consent: [] as any[], sms: 0, email: 0 };
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
    },
    email: o.email ? { fetch: async (x) => (calls.email++, o.email!(x)) } : undefined,
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
    expect(r).toEqual({ filled: true, source: "totp", submitted: true });
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
