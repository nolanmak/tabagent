import { describe, expect, it } from "vitest";
import { alwaysLabel, authAutoActive, CODE_SOURCE_IDS, hasCodesAlways, revokeAlways, setAuthAuto, setCodesAlways, setSignIn } from "../src/pure/siteAuth";
import { AUTH_AUTO_WARNING } from "../src/pure/siteLevel";

const O = "https://shop.example";
// Banks are on the seeded denylist; since #101 that is what blocks their sign-in, not AUTH_DENY_HOSTS.
const ctx = { denylist: ["*.blocked.example", "*.chase.com", "*.mercury.com", "*.paypal.com"] };

describe("Always grant labels (#131)", () => {
  it("names the code pseudo-accounts in words", () => {
    expect(alwaysLabel("code-source:sms")).toBe("texted codes");
    expect(alwaysLabel("code-source:email")).toBe("emailed codes");
    expect(alwaysLabel("confirm-link:email")).toBe("email confirmation links");
    expect(alwaysLabel("chrome-autofill:saved")).toBe("Chrome saved password");
  });
  it("masks real account ids, keeping the provider", () => {
    expect(alwaysLabel("1password:abcdefghijklmnop")).toBe("1password ab•••op");
    expect(alwaysLabel("bitwarden:abc")).toBe("bitwarden ••••");
    expect(alwaysLabel("weird")).toBe("account ••••");
    expect(alwaysLabel("1password:abcdefghijklmnop")).not.toContain("cdefghijklmn");
  });
});

describe("sign-in allowed toggle (#131)", () => {
  it("on sets auth only", () => {
    expect(setSignIn({ policy: "act" }, true, O, ctx)).toEqual({ policy: "act", auth: true });
  });
  it("off clears Always grants and sign-in without asking", () => {
    expect(setSignIn({ policy: "full", auth: true, authAuto: true, authAlways: ["code-source:sms"] }, false, O, ctx)).toEqual({ policy: "full" });
  });
  it("off on a default-on origin or under YOLO stores an explicit false", () => {
    expect(setSignIn({ auth: true, authAuto: true }, false, "https://accounts.google.com", ctx)).toEqual({ auth: false });
    expect(setSignIn({}, false, O, { ...ctx, yolo: true })).toEqual({ auth: false });
  });
  it("does not mutate its input", () => {
    const e = { auth: true, authAuto: true, authAlways: ["x"] };
    setSignIn(e, false, O, ctx);
    expect(e).toEqual({ auth: true, authAuto: true, authAlways: ["x"] });
  });
});

describe("sign in without asking toggle (#131)", () => {
  it("on sets authAuto and an explicit auth, and returns the payment warning", () => {
    const r = setAuthAuto({ policy: "act" }, true, O, ctx);
    expect(r.entry).toEqual({ policy: "act", auth: true, authAuto: true });
    expect(r.warning).toBe(AUTH_AUTO_WARNING);
    expect(r.note).toBeUndefined();
  });
  it("on where sign-in is only on by YOLO still stores auth: true", () => {
    expect(setAuthAuto({}, true, O, { ...ctx, yolo: true }).entry).toEqual({ auth: true, authAuto: true });
  });
  it("on also turns sign-in on, even from an explicit off", () => {
    expect(setAuthAuto({ policy: "act" }, true, O, ctx).entry).toEqual({ policy: "act", auth: true, authAuto: true });
    expect(setAuthAuto({ auth: false }, true, "https://accounts.google.com", { denylist: [] }).entry).toEqual({ auth: true, authAuto: true });
  });
  it.each([
    ["https://www.chase.com", "denylist"],
    ["https://app.mercury.com", "denylist"],
    ["https://my.1password.com", "never lets agents open"],
    ["https://vault.bitwarden.com", "never lets agents open"],
    ["https://mail.google.com", "never lets agents open"],
    ["https://a.blocked.example", "denylist"],
  ])("refuses blocked host %s and says why", (origin, why) => {
    const r = setAuthAuto({ policy: "full", auth: true }, true, origin, ctx);
    expect(r.entry).toEqual({ policy: "full", auth: true });
    expect(r.note).toContain(why);
    expect(r.warning).toBeUndefined();
  });
  it("a bank the user took off the denylist can sign in without asking, with the warning (#101)", () => {
    const r = setAuthAuto({ policy: "full", auth: true }, true, "https://app.mercury.com", { denylist: [] });
    expect(r.entry.authAuto).toBe(true);
    expect(r.warning).toBe(AUTH_AUTO_WARNING);
  });
  it("off removes only authAuto, and is allowed anywhere", () => {
    expect(setAuthAuto({ auth: true, authAuto: true, authAlways: ["a"] }, false, O, ctx)).toEqual({ entry: { auth: true, authAlways: ["a"] } });
    expect(setAuthAuto({ auth: true, authAuto: true }, false, "https://www.chase.com", ctx).entry).toEqual({ auth: true });
  });
});

describe("always allow texted/emailed codes toggle (#131)", () => {
  it("on adds both code pseudo-accounts once; off removes only them", () => {
    expect(CODE_SOURCE_IDS).toEqual(["code-source:sms", "code-source:email"]);
    const on = setCodesAlways({ auth: true, authAlways: ["1password:x", "code-source:sms"] }, true, O, ctx);
    expect(on.entry.authAlways).toEqual(["1password:x", "code-source:sms", "code-source:email"]);
    expect(hasCodesAlways(on.entry)).toBe(true);
    const off = setCodesAlways(on.entry, false, O, ctx);
    expect(off.entry).toEqual({ auth: true, authAlways: ["1password:x"] });
    expect(hasCodesAlways(off.entry)).toBe(false);
    expect(setCodesAlways({ auth: true, authAlways: ["code-source:email"] }, false, O, ctx).entry).toEqual({ auth: true });
  });
  it("on also turns sign-in on", () => {
    expect(setCodesAlways({}, true, O, ctx)).toEqual({ entry: { auth: true, authAlways: [...CODE_SOURCE_IDS] } });
  });
  it("is refused on blocked hosts", () => {
    const r = setCodesAlways({ auth: true }, true, "https://www.paypal.com", ctx);
    expect(r.entry).toEqual({ auth: true });
    expect(r.note).toContain("denylist");
  });
  it("hasCodesAlways needs both", () => {
    expect(hasCodesAlways({ authAlways: ["code-source:sms"] })).toBe(false);
    expect(hasCodesAlways(undefined)).toBe(false);
  });
});

describe("revoking one Always grant (#131)", () => {
  it("removes that id only and drops an empty list", () => {
    expect(revokeAlways({ auth: true, authAlways: ["a", "b"] }, "a")).toEqual({ auth: true, authAlways: ["b"] });
    expect(revokeAlways({ auth: true, authAlways: ["a"] }, "a")).toEqual({ auth: true });
    expect(revokeAlways(undefined, "a")).toEqual({});
  });
});

describe("authAutoActive (what the gate will honour, for display)", () => {
  it("needs explicit auth, the flag, and an unblocked host", () => {
    expect(authAutoActive({ auth: true, authAuto: true }, O, ctx)).toBe(true);
    expect(authAutoActive({ authAuto: true }, O, ctx)).toBe(false);
    expect(authAutoActive({ auth: true }, O, ctx)).toBe(false);
    expect(authAutoActive({ auth: true, authAuto: true }, "https://x.blocked.example", ctx)).toBe(false);
    expect(authAutoActive({ auth: true, authAuto: true }, "https://www.chase.com", ctx)).toBe(false);
    expect(authAutoActive(undefined, O, ctx)).toBe(false);
  });
});
