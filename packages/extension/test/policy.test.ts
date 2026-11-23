import { describe, expect, it } from "vitest";
import { effectiveLevel, isBlank, isHardDenied, originOf, resolve, type Level, type PolicyRequest, type PolicyState, type SensitiveCategory } from "../src/background/policy";

const A = "https://a.example";
const base = (over: Partial<PolicyState> = {}): PolicyState => ({ devAllowSensitive: false, ...over });
const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({ url: `${A}/page`, level: "read", ...over });

describe("interim policy (D17): every level is allowed on ordinary pages", () => {
  const levels: (Level | null)[] = [null, "read", "act", "full"];
  for (const l of levels) {
    it(`level ${l ?? "(none)"} on an http(s) page -> allow`, () => {
      expect(resolve(base(), req({ level: l }))).toEqual({ decision: "allow", origin: A });
    });
  }
  it("file pages and blank pages are allowed", () => {
    expect(resolve(base(), req({ url: "file:///tmp/x.html" })).decision).toBe("allow");
    expect(resolve(base(), req({ url: "about:blank" })).decision).toBe("allow");
    expect(resolve(base(), req({ url: "" , level: null})).decision).toBe("allow");
  });
});

describe("hard deny", () => {
  for (const u of ["chrome://settings", "chrome-extension://abc/page.html", "devtools://devtools/x", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x", "view-source:https://a.example"]) {
    it(`${u} is denied, even with devAllowSensitive`, () => {
      expect(isHardDenied(u)).toBe(true);
      expect(resolve(base({ devAllowSensitive: true }), req({ url: u }))).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED" });
    });
  }
  it("about:blank is allowed and not hard denied", () => {
    expect(isHardDenied("about:blank")).toBe(false);
    expect(isBlank("about:blank")).toBe(true);
  });
  it("chrome.google.com outside /webstore is not hard denied", () => {
    expect(isHardDenied("https://chrome.google.com/other")).toBe(false);
  });
  it("unsupported schemes are denied", () => {
    expect(resolve(base(), req({ url: "ftp://x.example/" }))).toMatchObject({ decision: "deny", message: expect.stringContaining("http(s)") });
  });
});

describe("D18 gated effects are refused unless devAllowSensitive", () => {
  const cats: SensitiveCategory[] = ["a", "b", "c", "d", "e", "f"];
  for (const c of cats) {
    it(`category ${c}: refused by default, allowed with devAllowSensitive`, () => {
      expect(resolve(base(), req({ sensitive: c }))).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED", hint: expect.stringContaining("devAllowSensitive") });
      expect(resolve(base({ devAllowSensitive: true }), req({ sensitive: c })).decision).toBe("allow");
    });
  }
  it("a gated effect on a blank page is refused too", () => {
    expect(resolve(base(), req({ url: "about:blank", level: null, sensitive: "c" })).decision).toBe("deny");
  });
  it("hard deny wins over devAllowSensitive for gated effects", () => {
    expect(resolve(base({ devAllowSensitive: true }), req({ url: "chrome://x", sensitive: "e" })).decision).toBe("deny");
  });
});

describe("url helpers and effectiveLevel", () => {
  it("originOf", () => {
    expect(originOf("https://a.example:8443/x")).toBe("https://a.example:8443");
    expect(originOf("file:///tmp/x")).toBe("file://");
    expect(originOf("chrome://settings")).toBeNull();
    expect(originOf("nope")).toBeNull();
  });
  it("effectiveLevel", () => {
    expect(effectiveLevel(base(), `${A}/`)).toMatchObject({ origin: A, level: "full", sensitiveAllowed: false });
    expect(effectiveLevel(base({ devAllowSensitive: true }), `${A}/`).sensitiveAllowed).toBe(true);
    expect(effectiveLevel(base(), "about:blank")).toMatchObject({ origin: null, level: "full" });
    expect(effectiveLevel(base(), "chrome://settings")).toMatchObject({ level: "deny" });
  });
});
