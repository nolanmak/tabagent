import { describe, expect, it } from "vitest";
import { AUTH_AUTO_WARNING, applyLevel, FULL_PREAPPROVED } from "../src/pure/siteLevel";

const ctx = { denylist: ["*.blocked.example", "accounts.google.com"] };
const all = { a: true, b: true, c: true, d: true, e: true } as const;

describe("applyLevel (#118)", () => {
  it("full turns on sign-in without asking (#131) and pre-approves every a-e category", () => {
    const r = applyLevel(undefined, "full", "https://example.test", ctx);
    expect(r.entry).toEqual({ policy: "full", auth: true, authAuto: true, preapproved: all });
    expect(r.note).toBeUndefined();
    expect(r.warning).toBe(AUTH_AUTO_WARNING);
    expect(AUTH_AUTO_WARNING).toMatch(/payments or transfers/);
    expect(FULL_PREAPPROVED).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("full keeps unrelated fields (lite, authAlways) and never pre-approves f/g/p/r", () => {
    const r = applyLevel({ policy: "read", lite: true, authAlways: ["acct1"], preapproved: { a: true } }, "full", "https://example.test", ctx);
    expect(r.entry).toEqual({ policy: "full", lite: true, authAlways: ["acct1"], auth: true, authAuto: true, preapproved: all });
    expect(Object.keys(r.entry.preapproved!)).not.toContain("f");
  });

  it("does not mutate the input entry", () => {
    const e = { policy: "read" as const, preapproved: { a: true as const } };
    applyLevel(e, "full", "https://example.test", ctx);
    expect(e).toEqual({ policy: "read", preapproved: { a: true } });
  });

  it.each([
    ["https://secure.chase.com", "never signs in"],
    ["https://www.paypal.com", "never signs in"],
    ["https://app.mercury.com", "never signs in"],
    ["https://my.1password.com", "never lets agents open"],
    ["https://passwords.google.com", "never lets agents open"],
    ["https://mail.google.com", "never lets agents open"],
    ["https://app.blocked.example", "denylist"],
    ["https://accounts.google.com", "denylist"],
  ])("full on hard-limited host %s gets no auth and says why", (origin, why) => {
    const r = applyLevel(undefined, "full", origin, ctx);
    expect(r.entry.policy).toBe("full");
    expect(r.entry.auth).toBeUndefined();
    expect(r.entry.authAuto).toBeUndefined();
    expect(r.warning).toBeUndefined();
    expect(r.entry.preapproved).toEqual(all);
    expect(r.note).toContain(why);
    expect(r.note).toContain(new URL(origin).hostname);
  });

  it("full on a hard-limited host leaves an existing explicit auth value alone", () => {
    expect(applyLevel({ auth: false }, "full", "https://accounts.google.com", ctx).entry.auth).toBe(false);
  });

  it("full on a site that already signs in without asking gives no new warning", () => {
    const r = applyLevel({ policy: "act", auth: true, authAuto: true }, "full", "https://example.test", ctx);
    expect(r.entry.authAuto).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it.each(["act", "read", "deny"] as const)("lowering from full to %s changes only the policy", (level) => {
    const full = applyLevel(undefined, "full", "https://example.test", ctx).entry;
    const r = applyLevel(full, level, "https://example.test", ctx);
    expect(r.entry).toEqual({ ...full, policy: level });
    expect(r.entry.authAuto).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it("ask removes the stored policy and keeps the toggles", () => {
    const r = applyLevel({ policy: "full", auth: true, authAuto: true, preapproved: all }, "ask", "https://example.test", ctx);
    expect(r.entry).toEqual({ auth: true, authAuto: true, preapproved: all });
  });

  it.each(["read", "act", "deny"] as const)("%s on a new site sets only the policy", (level) => {
    expect(applyLevel(undefined, level, "https://example.test", ctx).entry).toEqual({ policy: level });
  });

  it("an unparseable origin still gets the policy but no auth", () => {
    const r = applyLevel(undefined, "full", "not a url", ctx);
    expect(r.entry.policy).toBe("full");
    expect(r.entry.auth).toBeUndefined();
    expect(r.note).toBeDefined();
  });
});
