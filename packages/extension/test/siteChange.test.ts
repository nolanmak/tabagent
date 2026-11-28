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
    ["https://my.1password.com", /never signs in|password/i],
  ])("refuses an automated-sign-in-blocked host %s", (origin, msg) => {
    const e = code(() => checkSiteChange(state({}, []), origin, { auth: true }));
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(e.message).toMatch(msg);
  });

  it("lets a bank off the denylist be requested (#101)", () => {
    expect(() => checkSiteChange(state({}, []), "https://www.chase.com", { auth: true })).not.toThrow();
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
    expect(r.site).toEqual({ policy: "ask", lite: true, auth: false, authAuto: false });
    expect(r.applied).toEqual([{ field: "policy", from: "full", to: "ask" }]);
  });

  it("turning sign-in off also clears the always-accounts; an emptied entry is removed", () => {
    const r = applySiteChange({ "https://app.example.com": { auth: true, authAlways: ["a1"] }, "https://other.example": { policy: "read" } }, "https://app.example.com", { auth: false });
    expect(r.sites).toEqual({ "https://other.example": { policy: "read" } });
    expect(r.site).toEqual({ policy: "ask", lite: false, auth: false, authAuto: false });
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
    expect(r.site).toEqual({ policy: "act", lite: true, auth: true, authAuto: false });
  });

  it("does not mutate its input", () => {
    const sites = { "https://app.example.com": { policy: "full" as const, authAlways: ["a1"], auth: true } };
    const copy = structuredClone(sites);
    applySiteChange(sites, "https://app.example.com", { auth: false, policy: "ask" });
    expect(sites).toEqual(copy);
  });
});

describe("sign in without asking through policy.site_change (#131)", () => {
  const o = "https://app.example.com";
  it("turning it on also turns sign-in on, and both show as applied", () => {
    expect(checkSiteChange(state({ [o]: { policy: "act" } }), o, { authAuto: true }).applied).toEqual([
      { field: "auth", from: false, to: true },
      { field: "authAuto", from: false, to: true },
    ]);
    const r = applySiteChange({ [o]: { policy: "act" } }, o, { authAuto: true });
    expect(r.sites[o]).toEqual({ policy: "act", auth: true, authAuto: true });
    expect(r.site).toEqual({ policy: "act", lite: false, auth: true, authAuto: true });
  });
  it("where sign-in is only on by default or by YOLO, it stores an explicit auth: true", () => {
    const r = applySiteChange({}, o, { authAuto: true }, true);
    expect(r.sites[o]).toEqual({ auth: true, authAuto: true });
    expect(r.applied).toEqual([{ field: "authAuto", from: false, to: true }]);
  });
  it("turning sign-in off clears it too, and says so", () => {
    const st = state({ [o]: { policy: "full", auth: true, authAuto: true, authAlways: ["a"] } });
    expect(checkSiteChange(st, o, { auth: false }).applied).toEqual([
      { field: "auth", from: true, to: false },
      { field: "authAuto", from: true, to: false },
    ]);
    expect(applySiteChange(st.sites, o, { auth: false }).sites[o]).toEqual({ policy: "full" });
  });
  it("turning it off keeps sign-in on", () => {
    const r = applySiteChange({ [o]: { auth: true, authAuto: true } }, o, { authAuto: false });
    expect(r.sites[o]).toEqual({ auth: true });
    expect(r.applied).toEqual([{ field: "authAuto", from: true, to: false }]);
  });
  it("refuses a contradictory request and a no-op", () => {
    expect(code(() => checkSiteChange(state(), o, { auth: false, authAuto: true })).code).toBe("BAD_REQUEST");
    expect(code(() => checkSiteChange(state({ [o]: { auth: true, authAuto: true } }), o, { authAuto: true })).message).toMatch(/already/);
    expect(code(() => checkSiteChange(state({ [o]: { auth: true } }), o, { authAuto: false })).message).toMatch(/already/);
  });
  it.each(["https://www.chase.com", "https://app.mercury.com", "https://mail.google.com", "https://blocked.example"])("is refused on blocked host %s", (origin) => {
    expect(code(() => checkSiteChange(state(), origin, { authAuto: true })).code).toBe("PERMISSION_DENIED");
  });
  it("the snapshot changes when authAuto changes", () => {
    expect(siteChangeSnapshot(state({ [o]: { auth: true, authAuto: true } }), o)).not.toBe(siteChangeSnapshot(state({ [o]: { auth: true } }), o));
  });
  it("the prompt names it and the payment risk", () => {
    const s = describeSiteChange({ origin: o, changes: { authAuto: true }, reason: "pay bills" });
    expect(s).toContain("turn sign-in without asking on");
    expect(s).toMatch(/payments or transfers/);
    expect(describeSiteChange({ origin: o, changes: { authAuto: false }, reason: "r" })).toContain("turn sign-in without asking off");
  });
  it("counts as a change on its own", () => {
    expect(code(() => checkSiteChange(state(), o, {})).message).toContain("authAuto");
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
