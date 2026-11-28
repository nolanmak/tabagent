import { describe, expect, it } from "vitest";
import { applyLevel, FULL_PREAPPROVED } from "../src/pure/siteLevel";

const ctx = { denylist: ["*.blocked.example", "accounts.google.com"] };
const all = { a: true, b: true, c: true, d: true, e: true };

describe("applyLevel (#118)", () => {
  it("full turns on sign-in and pre-approves every a-e category", () => {
    const r = applyLevel(undefined, "full", "https://example.test", ctx);
    expect(r.entry).toEqual({ policy: "full", auth: true, preapproved: all });
    expect(r.note).toBeUndefined();
    expect(FULL_PREAPPROVED).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("full keeps unrelated fields (lite, authAlways) and never pre-approves f/g/p/r", () => {
    const r = applyLevel({ policy: "read", lite: true, authAlways: ["acct1"], preapproved: { a: true } }, "full", "https://example.test", ctx);
    expect(r.entry).toEqual({ policy: "full", lite: true, authAlways: ["acct1"], auth: true, preapproved: all });
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
    ["https://my.1password.com", "never signs in"],
    ["https://passwords.google.com", "never lets agents open"],
    ["https://mail.google.com", "never lets agents open"],
    ["https://app.blocked.example", "denylist"],
    ["https://accounts.google.com", "denylist"],
  ])("full on hard-limited host %s gets no auth and says why", (origin, why) => {
    const r = applyLevel(undefined, "full", origin, ctx);
    expect(r.entry.policy).toBe("full");
    expect(r.entry.auth).toBeUndefined();
    expect(r.entry.preapproved).toEqual(all);
    expect(r.note).toContain(why);
    expect(r.note).toContain(new URL(origin).hostname);
  });

  it("full on a hard-limited host leaves an existing explicit auth value alone", () => {
    expect(applyLevel({ auth: false }, "full", "https://accounts.google.com", ctx).entry.auth).toBe(false);
  });

  it.each(["act", "read", "deny"] as const)("lowering from full to %s changes only the policy", (level) => {
    const full = applyLevel(undefined, "full", "https://example.test", ctx).entry;
    const r = applyLevel(full, level, "https://example.test", ctx);
    expect(r.entry).toEqual({ ...full, policy: level });
    expect(r.note).toBeUndefined();
  });

  it("ask removes the stored policy and keeps the toggles", () => {
    const r = applyLevel({ policy: "full", auth: true, preapproved: all }, "ask", "https://example.test", ctx);
    expect(r.entry).toEqual({ auth: true, preapproved: all });
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
