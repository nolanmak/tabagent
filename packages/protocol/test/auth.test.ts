import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACCOUNT_ID_RE,
  accountId,
  AUTH_TOOLS,
  AuthAccountsResultSchema,
  AuthCodeRequestSchema,
  AuthExtToBridgeSchema,
  AuthSecretRequestSchema,
  authExtraTimeout,
  authSafeKind,
  getTool,
  httpsOrigin,
  isAuthExtMessage,
  itemMatches,
  itemOnDomain,
  itemUrlMatches,
  MASKED_ACCOUNT_RE,
  maskAccount,
  parseAccountId,
  registrableDomain,
  SecretMessageSchema,
  selectTotpAccount,
  TOOLS,
  toolsForProfiles,
  uriMatches,
  uriMatchFromBitwarden,
  type ItemUri,
  type ToolDef,
  type UriMatchType,
} from "@tabagent/protocol";

const tools = TOOLS as unknown as ToolDef[];

/** String leaves of a schema that are free text: not enum/literal and not marked authSafe with a regex. */
function freeTextLeaves(schema: z.ZodType, path = "(root)"): string[] {
  let s: z.ZodType = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) s = (s as z.ZodOptional).unwrap() as z.ZodType;
  if (s instanceof z.ZodObject) return Object.entries(s.shape).flatMap(([k, v]) => freeTextLeaves(v as z.ZodType, `${path}.${k}`));
  if (s instanceof z.ZodArray) return freeTextLeaves(s.element as z.ZodType, `${path}[]`);
  if (s instanceof z.ZodUnion) return (s.options as z.ZodType[]).flatMap((o) => freeTextLeaves(o, path));
  if (s instanceof z.ZodString) {
    const safe = authSafeKind(s);
    const hasRegex = (s._zod.def.checks ?? []).some((c) => (c as { _zod: { def: { format?: string } } })._zod.def.format === "regex");
    return safe && hasRegex ? [] : [path];
  }
  if (s instanceof z.ZodEnum || s instanceof z.ZodLiteral || s instanceof z.ZodBoolean || s instanceof z.ZodNumber) return [];
  return [`${path} (${s.constructor.name})`];
}
function isStrict(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject && schema._zod.def.catchall instanceof z.ZodNever;
}

describe("DA1 registry: secret tools", () => {
  const secret = tools.filter((t) => t.secret);
  it("auth.login, auth.code and auth.signup are the secret tools", () => {
    expect(secret.map((t) => t.name).sort()).toEqual(["auth.code", "auth.login", "auth.signup"]);
  });
  it.each(secret.map((t) => [t.name, t] as const))("%s result schema has no free-text field and is strict", (_n, t) => {
    expect(freeTextLeaves(t.result)).toEqual([]);
    expect(isStrict(t.result)).toBe(true);
  });
  it("the sweep catches a free-text field", () => {
    expect(freeTextLeaves(z.strictObject({ filled: z.boolean(), note: z.string() }))).toEqual(["(root).note"]);
    expect(freeTextLeaves(z.strictObject({ a: z.string().meta({ authSafe: "masked" }) }))).toEqual(["(root).a"]); // marked but no regex
  });
  it("a secret tool result rejects a password-shaped value anywhere (property)", () => {
    const login = getTool("auth.login")!;
    fc.assert(
      fc.property(fc.string({ minLength: 4 }).filter((s) => !s.includes("•")), (marker) => {
        expect(login.result.safeParse({ filled: true, submitted: false, next: "done", account: marker }).success).toBe(false);
        expect(login.result.safeParse({ filled: true, submitted: false, next: "done", password: marker }).success).toBe(false);
        expect(getTool("auth.code")!.result.safeParse({ filled: true, source: "sms", submitted: true, code: marker }).success).toBe(false);
      }),
    );
  });
  it("valid results parse", () => {
    expect(getTool("auth.login")!.result.safeParse({ filled: true, account: "n•••@gmail.com", source: "1password", submitted: true, next: "code_required" }).success).toBe(true);
    expect(
      getTool("auth.login")!.result.safeParse({
        filled: false,
        submitted: false,
        next: "unknown",
        accounts: [
          { id: "1password:abc", provider: "1password", accountMasked: "a•••@x.com" },
          { id: "bitwarden:0f1e-22", provider: "bitwarden", accountMasked: "b•••b" },
        ],
      }).success,
    ).toBe(true);
    expect(getTool("auth.code")!.result.safeParse({ filled: true, source: "totp", submitted: false }).success).toBe(true);
  });
  it("no auth tool result has page content (nothing to wrap)", () => {
    for (const t of AUTH_TOOLS) expect(t.pageContent).toEqual([]);
  });
});

describe("DA10 profile", () => {
  const authNames = ["auth.code", "auth.handoff", "auth.login", "auth.signup", "auth.status"];
  const names = (ts: ToolDef[]) => ts.map((t) => t.name);
  it("core and full exclude auth; --profile auth adds it", () => {
    expect(names(toolsForProfiles("core")).filter((n) => n.startsWith("auth."))).toEqual([]);
    expect(names(toolsForProfiles("full")).filter((n) => n.startsWith("auth."))).toEqual([]);
    expect(names(toolsForProfiles("auth")).filter((n) => n.startsWith("auth.")).sort()).toEqual(authNames);
    expect(names(toolsForProfiles("full,auth")).length).toBe(tools.length);
    expect(toolsForProfiles("auth")).toHaveLength(13 + 5 + 1); // + captcha.solve (#61)
  });
  it("group auth, lookup by MCP name", () => {
    for (const n of authNames) {
      expect(getTool(n)!.group).toBe("auth");
      expect(getTool(n.replace(".", "_"))!.name).toBe(n);
    }
  });
  it("auth tools are not statically D18-gated (the handler prompts with the account, category g)", () => {
    for (const t of AUTH_TOOLS) expect((t as ToolDef).sensitive).toBeUndefined();
  });
  it("handoff gets the 5-minute extra wait", () => {
    expect(authExtraTimeout("auth.handoff")).toBe(300_000);
    expect(authExtraTimeout("auth.login")).toBe(0);
  });
  it("auth.code timeout caps at 120000", () => {
    const p = getTool("auth.code")!.params;
    expect(p.safeParse({ timeout: 120_000 }).success).toBe(true);
    expect(p.safeParse({ timeout: 120_001 }).success).toBe(false);
    expect(p.safeParse({ source: "pigeon" }).success).toBe(false);
  });
  it("auth.login account param must be an account id", () => {
    const p = getTool("auth.login")!.params;
    expect(p.safeParse({ account: "1password:abc123" }).success).toBe(true);
    expect(p.safeParse({ account: "nolan@gmail.com" }).success).toBe(false);
  });
});

describe("masking", () => {
  it.each([
    ["nolan@gmail.com", "n•••@gmail.com"],
    ["nolanmak7@gmail.com", "nol•••k7@gmail.com"], // #82 D10: 7+ char local part shows 3 + 2
    ["nolanmak", "nol•••ak"],
    ["nolanm", "n•••m"],
    ["ab", "a•••"],
    ["", "•••"],
    [null, "•••"],
    ["  x@y.co  ", "x•••@y.co"],
    ["<script>@evil.com", "•••@evil.com"],
  ])("%s -> %s", (a, want) => {
    expect(maskAccount(a)).toBe(want);
    expect(maskAccount(a)).toMatch(MASKED_ACCOUNT_RE);
  });
  it("D10 tells apart Gmail logins that the old mask collapsed", () => {
    expect(maskAccount("nolanmak7@gmail.com")).not.toBe(maskAccount("nathan.k@gmail.com"));
  });
  it("every mask matches the result regex and leaks at most 5 chars of the local part, 2 when short (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.domain()), (local, domain) => {
        const m = maskAccount(domain ? `${local}@${domain}` : local);
        expect(m).toMatch(MASKED_ACCOUNT_RE);
        const visibleLocal = m.split("@")[0].replace("•••", "");
        expect([...visibleLocal].length).toBeLessThanOrEqual([...local.trim()].length >= 7 ? 5 : 2);
      }),
    );
  });
  it("account ids", () => {
    expect(accountId("1password", "abc")).toBe("1password:abc");
    expect(() => accountId("bitwarden", "--session")).toThrow();
    expect(parseAccountId("bitwarden:0f-1")).toEqual({ provider: "bitwarden", localId: "0f-1" });
    expect(parseAccountId("lastpass:x")).toBeNull();
    expect(ACCOUNT_ID_RE.test("1password:-x")).toBe(false);
  });
});

describe("DA3 registrable domain + https", () => {
  it.each([
    ["github.com", "github.com"],
    ["login.github.com", "github.com"],
    ["a.b.c.example.co.uk", "example.co.uk"],
    ["alice.github.io", "alice.github.io"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["WWW.Example.COM.", "example.com"],
    ["foo.bar.com.au", "bar.com.au"],
  ])("registrableDomain(%s) = %s", (h, want) => expect(registrableDomain(h)).toBe(want));

  it.each([
    // item URL, page, matches?
    ["https://github.com/login", "https://github.com", true],
    ["https://github.com", "https://gist.github.com/x", true], // subdomain
    ["https://github.com", "https://github.com.evil.example", false], // look-alike
    ["https://github.com", "https://githuh.com", false],
    ["https://github.com", "https://github.co", false], // different TLD
    ["https://github.com", "https://github.co.uk", false],
    ["https://github.com", "http://github.com", false], // http page
    ["http://github.com", "https://github.com", false], // http item
    ["github.com", "https://github.com", true], // schemeless item = https
    ["", "https://github.com", false], // no URL
    [null, "https://github.com", false],
    ["https://alice.github.io", "https://bob.github.io", false], // private suffix
    ["https://example.co.uk", "https://other.co.uk", false],
    ["https://github.com:8443", "https://github.com", true], // port ignored at DA3 level
    ["not a url ::", "https://github.com", false],
    ["https://github.com", "javascript:alert(1)", false],
  ] as const)("item %s on page %s -> %s", (item, page, want) => {
    expect(itemUrlMatches(item, page)).toBe(want);
  });
  it("httpsOrigin", () => {
    expect(httpsOrigin("https://github.com/x?y")).toBe("https://github.com");
    expect(httpsOrigin("http://github.com")).toBeNull();
    expect(httpsOrigin("nope")).toBeNull();
  });
});

describe("#37 URI match types", () => {
  type Row = [string, UriMatchType | null, string, boolean];
  const rows: Row[] = [
    // base domain (default)
    ["https://github.com", null, "https://github.com/login", true],
    ["https://github.com", "domain", "https://api.github.com/", true],
    ["https://github.com", "domain", "https://github.com.evil.example/", false],
    ["https://github.com", "domain", "https://githuh.com/", false],
    ["https://github.com", "domain", "http://github.com/", false],
    ["github.com", "domain", "https://github.com/", true], // schemeless
    // host
    ["https://github.com", "host", "https://github.com/x", true],
    ["https://github.com", "host", "https://api.github.com/x", false], // subdomain
    ["https://a.github.com", "host", "https://b.github.com/", false], // sibling
    ["https://github.com:8443", "host", "https://github.com/", false], // port differs
    ["https://github.com:8443", "host", "https://github.com:8443/a", true],
    // exact
    ["https://github.com/login", "exact", "https://github.com/login", true],
    ["https://github.com/login", "exact", "https://github.com/login?x=1", false],
    ["github.com/login", "exact", "https://github.com/login", true],
    ["http://github.com/login", "exact", "http://github.com/login", false], // DA3 floor: http
    // starts with
    ["https://github.com/org/", "startsWith", "https://github.com/org/login", true],
    ["https://github.com/org/", "startsWith", "https://github.com/other", false],
    ["https://github.com/org", "startsWith", "https://github.com.evil.example/org", false],
    // regex
    ["^https://(www\\.)?github\\.com/login", "regex", "https://github.com/login", true],
    ["^https://(www\\.)?github\\.com/login", "regex", "https://www.github.com/login", true],
    [".*", "regex", "https://github.com/", false], // no literal host: refused
    ["^https://evil\\.example/.*|.*", "regex", "https://github.com/", false], // aimed elsewhere: DA3 floor
    ["https://github\\.com.*|.*evil.*", "regex", "https://evil.example/", false],
    ["https://github\\.com/" + "a".repeat(500), "regex", "https://github.com/", false], // too long
    ["https://github\\.com/(", "regex", "https://github.com/", false], // invalid
    // never
    ["https://github.com", "never", "https://github.com/", false],
  ];
  it.each(rows)("%s [%s] on %s -> %s", (uri, match, page, want) => {
    expect(uriMatches({ uri, match }, page)).toBe(want);
  });
  it("no URI never matches; any URI matching is enough", () => {
    expect(itemMatches([], "https://github.com")).toBe(false);
    expect(itemMatches(undefined, "https://github.com")).toBe(false);
    expect(itemMatches([{ uri: "https://gitlab.com" }, { uri: "https://github.com" }], "https://github.com/x")).toBe(true);
  });
  it("Bitwarden numeric match codes", () => {
    expect([0, 1, 2, 3, 4, 5, null, 9].map((c) => uriMatchFromBitwarden(c))).toEqual(["domain", "host", "startsWith", "exact", "regex", "never", null, "never"]);
  });
  it("the bridge pre-filter never drops an item the match function accepts (property)", () => {
    const host = fc.constantFrom("github.com", "api.github.com", "github.com.evil.example", "githuh.com", "alice.github.io", "bob.github.io", "x.co.uk");
    const uriArb: fc.Arbitrary<ItemUri> = fc.record({
      uri: fc.tuple(fc.constantFrom("https://", "http://", ""), host, fc.constantFrom("", "/", "/login", ":8443/")).map(([s, h, p]) => s + h + p),
      match: fc.constantFrom<UriMatchType | null>(null, "domain", "host", "startsWith", "exact", "never"),
    });
    const regexUri = host.map((h) => ({ uri: `^https://${h.replace(/\./g, "\\.")}/`, match: "regex" as const }));
    fc.assert(
      fc.property(fc.array(fc.oneof(uriArb, regexUri), { maxLength: 4 }), host, fc.constantFrom("/", "/login", "/a?b=1"), (uris, h, path) => {
        const page = `https://${h}${path}`;
        if (itemMatches(uris, page)) expect(itemOnDomain(uris, page)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("secret-channel wire", () => {
  it("parses each ext → bridge message", () => {
    expect(AuthExtToBridgeSchema.parse({ type: "auth.accounts", id: "r1", commandId: "c1", origin: "https://github.com" }).type).toBe("auth.accounts");
    expect(AuthSecretRequestSchema.safeParse({ type: "auth.secret.request", id: "r", commandId: "c", accountId: "1password:x", field: "password" }).success).toBe(true);
    expect(AuthSecretRequestSchema.safeParse({ type: "auth.secret.request", id: "r", commandId: "c", accountId: "nolan", field: "password" }).success).toBe(false);
    expect(AuthSecretRequestSchema.safeParse({ type: "auth.secret.request", id: "r", commandId: "c", accountId: "1password:x", field: "seed" }).success).toBe(false);
    expect(AuthCodeRequestSchema.safeParse({ type: "auth.code.request", id: "r", commandId: "c", source: "sms", since: 1, timeout: 60000 }).success).toBe(true);
    expect(AuthCodeRequestSchema.safeParse({ type: "auth.code.request", id: "r", commandId: "c", source: "email", since: 1, timeout: 60000 }).success).toBe(false);
  });
  it("bridge → ext", () => {
    expect(SecretMessageSchema.safeParse({ type: "secret", id: "r", commandId: "c", field: "code", ok: true, value: "123456" }).success).toBe(true);
    expect(SecretMessageSchema.safeParse({ type: "secret", id: "r", commandId: "c", field: "totp", ok: true, value: "1" }).success).toBe(false);
    expect(
      AuthAccountsResultSchema.safeParse({
        type: "auth.accounts.result",
        id: "r",
        ok: true,
        accounts: [{ id: "bitwarden:a1", provider: "bitwarden", accountMasked: "n•••k", uris: [{ uri: "https://github.com", match: "host" }] }],
        providers: [{ name: "bitwarden", state: "unlocked", totp: "unknown" }],
        codeSources: [{ name: "sms", state: "disabled" }],
      }).success,
    ).toBe(true);
    // an account carrying an extra (e.g. password) key is rejected
    expect(
      AuthAccountsResultSchema.safeParse({ type: "auth.accounts.result", id: "r", ok: true, accounts: [{ id: "bitwarden:a1", provider: "bitwarden", accountMasked: "n•••k", password: "x" }] }).success,
    ).toBe(false);
  });
  it("#37 TOTP account selection: last login, single TOTP item, several → BAD_REQUEST, none → NOT_FOUND", () => {
    const a = (id: string, o: Record<string, unknown> = {}) => ({ id: `bitwarden:${id}`, provider: "bitwarden" as const, accountMasked: "a•••", ...o });
    const x = a("x", { hasTotp: true });
    const y = a("y", { hasTotp: true });
    const n = a("n", { hasTotp: false });
    expect(selectTotpAccount([x, y], "bitwarden:y")).toEqual({ account: y });
    expect(selectTotpAccount([x, n])).toEqual({ account: x });
    expect(selectTotpAccount([x, y])).toEqual({ error: "BAD_REQUEST", candidates: [{ id: "bitwarden:x", accountMasked: "a•••" }, { id: "bitwarden:y", accountMasked: "a•••" }] });
    expect(selectTotpAccount([n])).toEqual({ error: "NOT_FOUND" });
    expect(selectTotpAccount([a("r", { hasTotp: true, reprompt: true })])).toEqual({ error: "NOT_FOUND" });
    expect(selectTotpAccount([x, y], "bitwarden:gone")).toMatchObject({ error: "BAD_REQUEST" });
  });
  it("isAuthExtMessage", () => {
    expect(isAuthExtMessage({ type: "auth.accounts" })).toBe(true);
    expect(isAuthExtMessage({ type: "result" })).toBe(false);
    expect(isAuthExtMessage(null)).toBe(false);
  });
});
