// #33 `next` classification table + step-1 site check table.
import { AUTH_DENY_HOSTS } from "../src/background/policy";
import { describe, expect, it } from "vitest";
import type { FieldDesc } from "../src/background/auth/pure/fields";
import { classifyNext } from "../src/background/auth/pure/next";
import { checkAuthSite } from "../src/background/auth/pure/site";

let n = 0;
const f = (o: Partial<FieldDesc>): FieldDesc => ({ i: n++, tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", visible: true, form: 0, maxLength: -1, inputMode: "", ...o });
const LOGIN = () => [f({ name: "user" }), f({ type: "password" })];
const OTP = () => [f({ autocomplete: "one-time-code" })];
const PLAIN = () => [f({ name: "q", label: "Search" })];
const A = "https://github.com/login";
const B = "https://github.com/";

describe("classifyNext", () => {
  const rows: [string, Parameters<typeof classifyNext>[1], string][] = [
    ["one-time-code field appeared → code_required", { url: "https://github.com/sessions/two-factor", fields: OTP(), webauthn: false, captcha: false }, "code_required"],
    ["code field on the same URL → code_required", { url: A, fields: OTP(), webauthn: false, captcha: false }, "code_required"],
    ["WebAuthn prompt → handoff_required", { url: "https://github.com/sessions/webauthn", fields: [], webauthn: true, captcha: false }, "handoff_required"],
    ["CAPTCHA frame → handoff_required", { url: A, fields: LOGIN(), webauthn: false, captcha: true }, "handoff_required"],
    ["form gone, URL changed → done", { url: B, fields: PLAIN(), webauthn: false, captcha: false }, "done"],
    ["form gone, only the hash changed, nothing recognisable → handoff_required", { url: A + "#x", fields: [], webauthn: false, captcha: false }, "handoff_required"],
    ["login form still there (wrong password) → unknown", { url: A, fields: LOGIN(), webauthn: false, captcha: false }, "unknown"],
    // #83 D8: on accounts.google.com a form-less page is a challenge, never "done"
    ["Google phone prompt (URL changed, no form) → handoff_required", { url: "https://accounts.google.com/v3/signin/challenge/dp", fields: [], webauthn: false, captcha: false }, "handoff_required"],
    ["Google interstitial with only non-login fields → handoff_required", { url: "https://accounts.google.com/signin/v2/recoveryoptions", fields: PLAIN(), webauthn: false, captcha: false }, "handoff_required"],
    ["Google code page → code_required", { url: "https://accounts.google.com/v3/signin/challenge/ipp", fields: OTP(), webauthn: false, captcha: false }, "code_required"],
    ["Google password step → unknown (call auth.login again)", { url: "https://accounts.google.com/v3/signin/challenge/pwd", fields: [f({ type: "password", name: "Passwd" })], webauthn: false, captcha: false }, "unknown"],
    ["left Google for the third-party site → done", { url: "https://www.example-shop.com/account", fields: PLAIN(), webauthn: false, captcha: false }, "done"],
    ["next step of a two-step login (password page) → unknown", { url: "https://github.com/login/password", fields: [f({ type: "password" })], webauthn: false, captcha: false }, "unknown"],
  ];
  for (const [name, after, want] of rows) it(name, () => expect(classifyNext(A, after)).toBe(want));
});

describe("checkAuthSite (step 1, no prompt)", () => {
  const st = (sites: Record<string, any> = {}, denylist: string[] = []) => ({ sites, denylist, authDenyHosts: AUTH_DENY_HOSTS });
  it("enabled https origin passes", () => expect(checkAuthSite(st({ "https://github.com": { auth: true } }), A)).toBe("https://github.com"));
  it("not enabled → PERMISSION_DENIED", () => expect(() => checkAuthSite(st(), A)).toThrow(/not enabled/));
  it("http page refused even when enabled", () => expect(() => checkAuthSite(st({ "http://github.com": { auth: true } }), "http://github.com/login")).toThrow(/https/));
  it("banking list refused even when auth is enabled", () => expect(() => checkAuthSite(st({ "https://www.chase.com": { auth: true } }), "https://www.chase.com/login")).toThrow(/never signs in/));
  it("password-manager vault refused", () => expect(() => checkAuthSite(st({ "https://my.1password.com": { auth: true } }), "https://my.1password.com/")).toThrow(/never signs in/));
  it("accounts.google.com has sign-in on by default once off the denylist", () => expect(checkAuthSite(st({}), "https://accounts.google.com/v3/signin/identifier")).toBe("https://accounts.google.com"));
  it("an explicit sign-in off for Google is respected", () => expect(() => checkAuthSite(st({ "https://accounts.google.com": { auth: false } }), "https://accounts.google.com/")).toThrow(/not enabled/));
  it("YOLO turns sign-in on for every site (#110)", () => expect(checkAuthSite({ ...st({}), yolo: true }, "https://shop.example.com/login")).toBe("https://shop.example.com"));
  it("YOLO still respects an explicit sign-in off", () => expect(() => checkAuthSite({ ...st({ "https://shop.example.com": { auth: false } }), yolo: true }, "https://shop.example.com/login")).toThrow(/not enabled/));
  it("YOLO never unlocks hard-blocked hosts or the denylist", () => {
    expect(() => checkAuthSite({ ...st({}), yolo: true }, "https://www.chase.com/login")).toThrow(/never signs in/);
    expect(() => checkAuthSite({ ...st({}, ["shop.example.com"]), yolo: true }, "https://shop.example.com/login")).toThrow(/denylist/);
  });
  it("default-on is Google only; other origins still need the toggle", () => expect(() => checkAuthSite(st({}), "https://accounts.example.com/")).toThrow(/not enabled/));
  it("accounts.google.com passes when enabled and not denylisted (#81)", () => expect(checkAuthSite(st({ "https://accounts.google.com": { auth: true } }), "https://accounts.google.com/v3/signin/identifier")).toBe("https://accounts.google.com"));
  it("accounts.google.com still refused while on the denylist", () => expect(() => checkAuthSite(st({ "https://accounts.google.com": { auth: true } }, ["accounts.google.com"]), "https://accounts.google.com/")).toThrow(/denylist/));
  it("every remaining hard sign-in host is still refused", () => {
    for (const g of AUTH_DENY_HOSTS) {
      const host = g.replace(/^\*\./, "www.");
      expect(() => checkAuthSite(st({ [`https://${host}`]: { auth: true } }), `https://${host}/`)).toThrow(/never signs in/);
    }
    expect(AUTH_DENY_HOSTS).not.toContain("accounts.google.com");
  });
  it("user denylist refused", () => expect(() => checkAuthSite(st({ "https://github.com": { auth: true } }, ["github.com"]), A)).toThrow(/denylist/));
  it("deny policy refused", () => expect(() => checkAuthSite(st({ "https://github.com": { auth: true, policy: "deny" } }), A)).toThrow(/denied/));
  it("enabled for github.com does not cover the look-alike origin", () => expect(() => checkAuthSite(st({ "https://github.com": { auth: true } }), "https://github.com.evil.example/login")).toThrow(/not enabled/));
  it("non-URL refused", () => expect(() => checkAuthSite(st(), "about:blank")).toThrow());
  it("errors are PERMISSION_DENIED", () => {
    try {
      checkAuthSite(st(), A);
    } catch (e: any) {
      expect(e.code).toBe("PERMISSION_DENIED");
    }
  });
});
