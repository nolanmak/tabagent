import { describe, expect, it } from "vitest";
import { hostMatches, hostOf, isRestrictedUrl, LEVEL_RANK, originOf, redact } from "@tabagent/protocol";

describe("hostMatches", () => {
  it.each([
    ["*.github.com", "github.com", true],
    ["*.github.com", "gist.github.com", true],
    ["*.github.com", "github.com.evil.example", false],
    ["github.com", "GitHub.com", true],
    ["github.com", "api.github.com", false],
    ["*", "anything", true],
    ["<all>", "x", true],
  ] as const)("%s ~ %s = %s", (g, h, want) => expect(hostMatches(g, h)).toBe(want));
});

describe("url helpers", () => {
  it("originOf", () => {
    expect(originOf("https://a.example:8443/x?y")).toBe("https://a.example:8443");
    expect(originOf("file:///tmp/x.html")).toBe("file://");
    expect(originOf("chrome://settings")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
  it("hostOf", () => {
    expect(hostOf("http://localhost:3000/")).toBe("localhost");
    expect(hostOf("::")).toBe("");
  });
  it("isRestrictedUrl", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("chrome-extension://abc/x.html")).toBe(true);
    expect(isRestrictedUrl("about:blank")).toBe(false);
    expect(isRestrictedUrl("https://a")).toBe(false);
  });
  it("level order", () => {
    expect(LEVEL_RANK.deny < LEVEL_RANK.read && LEVEL_RANK.read < LEVEL_RANK.act && LEVEL_RANK.act < LEVEL_RANK.full).toBe(true);
  });
});

describe("redact", () => {
  it("masks sensitive keys, card and ssn values, truncates long strings", () => {
    expect(redact({ password: "hunter2", note: "4242 4242 4242 4242", ssn: "x", id: "123-45-6789", data: "y".repeat(2000), list: ["a"], n: 1, z: null })).toEqual({
      password: "[redacted]",
      note: "[redacted]",
      ssn: "[redacted]",
      id: "[redacted]",
      data: "[2000 bytes]",
      list: ["a"],
      n: 1,
      z: null,
    });
    expect((redact("a".repeat(600)) as string).length).toBe(501);
  });
});
