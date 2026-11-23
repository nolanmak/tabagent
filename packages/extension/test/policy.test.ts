import { describe, expect, it } from "vitest";
import { CATEGORY_TEXT, hostOf, isBlank, isHardDenied, originOf, resolve, type PolicyRequest, type SensitiveCategory } from "../src/background/policy";

const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({ url: "https://a.example/x", level: "act", tab: "own", ...over });

describe("url helpers", () => {
  it("originOf / hostOf / isBlank", () => {
    expect(originOf("https://a.example:8443/x?y")).toBe("https://a.example:8443");
    expect(originOf("file:///tmp/x.html")).toBe("file://");
    expect(originOf("chrome://settings")).toBeNull();
    expect(originOf("nope")).toBeNull();
    expect(hostOf("http://LocalHost:3000/")).toBe("localhost");
    expect(hostOf("::")).toBe("");
    expect(isBlank("")).toBe(true);
    expect(isBlank("about:blank")).toBe(true);
    expect(isBlank("about:srcdoc")).toBe(true);
    expect(isBlank("https://a")).toBe(false);
  });
  it.each([
    ["chrome://settings", true],
    ["chrome-extension://abc/popup.html", true],
    ["chrome-untrusted://x", true],
    ["devtools://devtools/bundled/x", true],
    ["view-source:https://a", true],
    ["about:config", true],
    ["https://chromewebstore.google.com/detail/x", true],
    ["https://chrome.google.com/webstore/detail/x", true],
    ["https://chrome.google.com/other", false],
    ["about:blank", false],
    ["https://a.example/", false],
    ["file:///tmp/a.html", false],
  ])("isHardDenied(%s) = %s", (url, want) => expect(isHardDenied(url)).toBe(want));
});

// D17 interim policy: every row is a test (roadmap TDD rule 5).
describe("D17 interim policy table", () => {
  it.each([
    // [description, request, state, decision, code]
    ["owned tab on a normal site", req(), {}, "allow", undefined],
    ["no tab (tabs list), no url", req({ tab: "none", url: "", level: null }), {}, "allow", undefined],
    ["owned blank tab", req({ url: "about:blank" }), {}, "allow", undefined],
    ["file page", req({ url: "file:///tmp/a.html" }), {}, "allow", undefined],
    ["full level is not limited before #12", req({ level: "full" }), {}, "allow", undefined],
    ["tab owned by another session", req({ tab: "other" }), {}, "deny", "TAB_BUSY"],
    ["tab owned by nobody", req({ tab: "nobody" }), {}, "deny", "NOT_FOUND"],
    ["chrome:// target", req({ url: "chrome://settings" }), {}, "deny", "PERMISSION_DENIED"],
    ["extension page", req({ url: "chrome-extension://abc/x.html" }), {}, "deny", "PERMISSION_DENIED"],
    ["Web Store", req({ url: "https://chromewebstore.google.com/" }), {}, "deny", "PERMISSION_DENIED"],
    ["hard deny is not unlocked by devAllowSensitive", req({ url: "chrome://settings" }), { devAllowSensitive: true }, "deny", "PERMISSION_DENIED"],
    ["non-web scheme", req({ url: "javascript:alert(1)" }), {}, "deny", "PERMISSION_DENIED"],
    ["data url", req({ url: "data:text/html,x" }), {}, "deny", "PERMISSION_DENIED"],
    ["ownership is checked before the denylist", req({ tab: "other", url: "chrome://settings" }), {}, "deny", "TAB_BUSY"],
  ] as const)("%s", (_d, r, st, decision, code) => {
    const d = resolve(st, r);
    expect(d.decision).toBe(decision);
    if (code) expect(d).toMatchObject({ code });
  });

  const CATS = Object.keys(CATEGORY_TEXT) as SensitiveCategory[];
  it("covers every D18 category a-f", () => expect(CATS).toEqual(["a", "b", "c", "d", "e", "f"]));
  it.each(CATS)("gated effect %s is refused unless devAllowSensitive", (c) => {
    const off = resolve({}, req({ sensitive: c }));
    expect(off).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED", origin: "https://a.example" });
    if (off.decision === "deny") {
      expect(off.message).toContain(CATEGORY_TEXT[c].toLowerCase());
      expect(off.hint).toBeTruthy();
    }
    expect(resolve({ devAllowSensitive: false }, req({ sensitive: c })).decision).toBe("deny");
    expect(resolve({ devAllowSensitive: true }, req({ sensitive: c }))).toEqual({ decision: "allow", origin: "https://a.example" });
  });
  it("a gated effect on a page with no origin (blank tab) is still refused", () => {
    expect(resolve({}, req({ url: "about:blank", sensitive: "c" }))).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED", origin: null });
  });
});
