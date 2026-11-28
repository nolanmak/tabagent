import { describe, expect, it } from "vitest";
import { applySiteChange, checkSiteChange, describeSiteChange, normalizeSiteOrigin, siteChangeSnapshot } from "../src/pure/siteChange";

const DENY = ["*.chase.com", "accounts.google.com", "blocked.example"];
const state = (sites: Record<string, any> = {}, denylist: string[] = DENY) => ({ sites, denylist });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return { code: e.code, message: String(e.message), hint: e.hint as string | undefined };
  }
  throw new Error("expected a throw");
};

describe("site change origin (#104)", () => {
  it.each([
    ["https://App.Example.com", "https://app.example.com"],
    ["https://app.example.com/", "https://app.example.com"],
    [" http://127.0.0.1:8080 ", "http://127.0.0.1:8080"],
    ["https://app.example.com:443", "https://app.example.com"],
  ])("normalizes %j to %j", (raw, origin) => {
    expect(normalizeSiteOrigin(raw)).toBe(origin);
  });

  it.each(["https://*.example.com", "*.example.com", "https://app.example.*", "app.example.com", "https://app.example.com/login", "https://app.example.com/?a=1", "https://app.example.com/#x", "https://user:pw@app.example.com", "file:///tmp/x", "chrome://settings", "ftp://app.example.com", "", "*"])("rejects a pattern, path or non-http origin %j", (raw) => {
    expect(code(() => normalizeSiteOrigin(raw)).code).toBe("BAD_REQUEST");
  });
});

describe("site change validation (#104)", () => {
  it("normalizes the request and lists each change against the current effective values", () => {
    const r = checkSiteChange(state({ "https://app.example.com": { policy: "read" } }), "https://APP.example.com/", { auth: true, policy: "act", lite: true });
    expect(r.origin).toBe("https://app.example.com");
    expect(r.applied).toEqual([
      { field: "auth", from: false, to: true },
      { field: "policy", from: "read", to: "act" },
      { field: "lite", from: false, to: true },
    ]);
  });

  it("requires at least one change and refuses a request that changes nothing", () => {
    expect(code(() => checkSiteChange(state(), "https://app.example.com", {})).code).toBe("BAD_REQUEST");
    const noop = code(() => checkSiteChange(state({ "https://app.example.com": { policy: "act", auth: true } }), "https://app.example.com", { policy: "act", auth: true, lite: false }));
    expect(noop.code).toBe("BAD_REQUEST");
    expect(noop.message).toMatch(/already/i);
  });

  it.each([
    ["https://www.chase.com", /never signs in/i],
    ["https://my.1password.com", /never signs in|password/i],
  ])("refuses an automated-sign-in-blocked host %s", (origin, msg) => {
    const e = code(() => checkSiteChange(state({}, []), origin, { auth: true }));
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(e.message).toMatch(msg);
  });

  it.each(["https://passwords.google.com", "https://mail.google.com", "https://vault.bitwarden.eu"])("refuses the vault host %s whatever the change", (origin) => {
    for (const changes of [{ auth: true }, { policy: "deny" as const }, { lite: true }]) {
      const e = code(() => checkSiteChange(state({}, []), origin, changes));
      expect(e.code).toBe("PERMISSION_DENIED");
      expect(e.message).toMatch(/passwords, account or mail/);
    }
  });

  it("refuses a denylisted host and hints at requesting a denylist change first", () => {
    const e = code(() => checkSiteChange(state(), "https://blocked.example", { auth: true }));
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(e.message).toContain("denylist");
    expect(e.hint).toContain("policy.denylist_change");
    expect(code(() => checkSiteChange(state(), "https://accounts.google.com", { auth: true })).hint).toContain("policy.denylist_change");
  });

  it("refuses hard-denied hosts", () => {
    expect(code(() => checkSiteChange(state({}, []), "https://chromewebstore.google.com", { policy: "full" })).code).toBe("PERMISSION_DENIED");
  });

  it("turning things off is validated the same way", () => {
    const st = state({ "https://app.example.com": { policy: "full", auth: true, authAlways: ["a1"], lite: true } });
    expect(checkSiteChange(st, "https://app.example.com", { auth: false, policy: "deny", lite: false }).applied).toEqual([
      { field: "auth", from: true, to: false },
      { field: "policy", from: "full", to: "deny" },
      { field: "lite", from: true, to: false },
    ]);
  });
});

describe("applying a site change (#104)", () => {
  it("ask removes the stored policy, like the side panel", () => {
    const r = applySiteChange({ "https://app.example.com": { policy: "full", lite: true } }, "https://app.example.com", { policy: "ask" });
    expect(r.sites["https://app.example.com"]).toEqual({ lite: true });
    expect(r.site).toEqual({ policy: "ask", lite: true, auth: false });
    expect(r.applied).toEqual([{ field: "policy", from: "full", to: "ask" }]);
  });

  it("turning sign-in off also clears the always-accounts; an emptied entry is removed", () => {
    const r = applySiteChange({ "https://app.example.com": { auth: true, authAlways: ["a1"] }, "https://other.example": { policy: "read" } }, "https://app.example.com", { auth: false });
    expect(r.sites).toEqual({ "https://other.example": { policy: "read" } });
    expect(r.site).toEqual({ policy: "ask", lite: false, auth: false });
  });

  it("a default-on sign-in origin keeps an explicit false", () => {
    const r = applySiteChange({}, "https://accounts.google.com", { auth: false });
    expect(r.sites["https://accounts.google.com"]).toEqual({ auth: false });
    expect(r.applied).toEqual([{ field: "auth", from: true, to: false }]);
  });

  it("under YOLO sign-in is already on, and turning it off stores an explicit false (#110)", () => {
    expect(code(() => checkSiteChange({ sites: {}, denylist: [], yolo: true }, "https://app.example.com", { auth: true })).message).toMatch(/already/);
    const r = applySiteChange({}, "https://app.example.com", { auth: false }, true);
    expect(r.sites["https://app.example.com"]).toEqual({ auth: false });
    expect(r.applied).toEqual([{ field: "auth", from: true, to: false }]);
  });

  it("turning things on keeps unrelated fields and pre-approvals", () => {
    const r = applySiteChange({ "https://app.example.com": { preapproved: { c: true } } }, "https://app.example.com", { auth: true, policy: "act", lite: true });
    expect(r.sites["https://app.example.com"]).toEqual({ preapproved: { c: true }, auth: true, policy: "act", lite: true });
    expect(r.site).toEqual({ policy: "act", lite: true, auth: true });
  });

  it("does not mutate its input", () => {
    const sites = { "https://app.example.com": { policy: "full" as const, authAlways: ["a1"], auth: true } };
    const copy = structuredClone(sites);
    applySiteChange(sites, "https://app.example.com", { auth: false, policy: "ask" });
    expect(sites).toEqual(copy);
  });
});

describe("stale-approval snapshot (#104)", () => {
  const o = "https://app.example.com";
  it("is stable across key order and denylist order/case", () => {
    expect(siteChangeSnapshot(state({ [o]: { policy: "act", auth: true } }, ["b.example", "A.example"]), o)).toBe(siteChangeSnapshot(state({ [o]: { auth: true, policy: "act" } }, ["a.example", "b.example"]), o));
  });
  it("changes when the site entry or the denylist changes", () => {
    const base = siteChangeSnapshot(state({ [o]: { policy: "act" } }), o);
    expect(siteChangeSnapshot(state({ [o]: { policy: "full" } }), o)).not.toBe(base);
    expect(siteChangeSnapshot(state({ [o]: { policy: "act", authAlways: ["x"] } }), o)).not.toBe(base);
    expect(siteChangeSnapshot(state({ [o]: { policy: "act" } }, [...DENY, "app.example.com"]), o)).not.toBe(base);
  });
  it("changes when YOLO flips, since that changes effective sign-in", () => {
    expect(siteChangeSnapshot({ ...state(), yolo: true }, o)).not.toBe(siteChangeSnapshot(state(), o));
  });
  it("ignores other origins", () => {
    expect(siteChangeSnapshot(state({ [o]: { policy: "act" }, "https://x.example": { policy: "read" } }), o)).toBe(siteChangeSnapshot(state({ [o]: { policy: "act" } }), o));
  });
});

describe("prompt summary (#104)", () => {
  it("names the origin, every change and the reason", () => {
    const s = describeSiteChange({ origin: "https://App.example.com/", changes: { auth: true, policy: "ask", lite: false }, reason: "sign in to download statements" });
    expect(s).toContain("https://app.example.com");
    expect(s).toContain("turn sign-in on");
    expect(s).toContain("set policy to ask");
    expect(s).toContain("turn lite mode off");
    expect(s).toContain("reason: sign in to download statements");
  });
  it("falls back to the raw origin text when it does not parse", () => {
    expect(describeSiteChange({ origin: "nope", changes: { policy: "deny" }, reason: "r" })).toContain("nope");
  });
});
