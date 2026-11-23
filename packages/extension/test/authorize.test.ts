import { describe, expect, it } from "vitest";
import { getTool, TOOLS } from "@tabagent/protocol";
import { normalizeNavUrl, requirementsFor, type ToolLike } from "../src/background/authorize";

const reg = (n: string) => getTool(n) as unknown as ToolLike;

describe("requirementsFor: D18 categories reach the gate", () => {
  it("no M0 registry tool is sensitive", () => {
    for (const t of TOOLS as unknown as ToolLike[]) expect(requirementsFor(t, { action: "list", url: "https://a" }).sensitive, t.name).toBeUndefined();
  });
  it("a registry category passes through; sensitiveWhen limits it to matching params", () => {
    expect(requirementsFor({ name: "x.eval", level: "full", sensitive: "c" }, {}).sensitive).toBe("c");
    const when = { name: "x.wait", level: "read" as const, sensitive: "c" as const, sensitiveWhen: { param: "for", values: ["fn"] } };
    expect(requirementsFor(when, { for: "fn" }).sensitive).toBe("c");
    expect(requirementsFor(when, { for: "load" }).sensitive).toBeUndefined();
    expect(requirementsFor({ name: "x", level: "read", sensitive: true }, {}).sensitive).toBeUndefined();
    expect(requirementsFor({ name: "tabs", level: "none", actions: { grab: { level: "read", sensitive: "f" } } }, { action: "grab" }).sensitive).toBe("f");
  });
});

describe("requirementsFor: levels and tab resolution", () => {
  it("tabs actions", () => {
    expect(requirementsFor(reg("tabs"), { action: "list" })).toMatchObject({ level: null, needsTab: false });
    expect(requirementsFor(reg("tabs"), { action: "new" })).toMatchObject({ level: null, urlSource: "none" });
    expect(requirementsFor(reg("tabs"), { action: "new", url: "https://a" })).toMatchObject({ level: "act", urlSource: "param" });
    expect(requirementsFor(reg("tabs"), { action: "select" })).toMatchObject({ level: null });
    expect(requirementsFor(reg("tabs"), { action: "close" })).toMatchObject({ level: null });
    expect(requirementsFor({ name: "tabs", level: "none" }, { action: "bogus" })).toMatchObject({ level: null });
  });
  it("nav.goto authorizes its target and resolves a tab only when named", () => {
    expect(requirementsFor(reg("nav.goto"), { url: "x" })).toMatchObject({ level: "act", urlSource: "param", needsTab: false, tabOptional: true });
  });
  it("nav.back/forward/reload need a session tab and act level", () => {
    for (const n of ["nav.back", "nav.forward", "nav.reload"]) expect(requirementsFor(reg(n), {})).toMatchObject({ level: "act", urlSource: "tab", needsTab: true });
  });
  it("a tool with no level and no category still resolves its tab", () => {
    expect(requirementsFor({ name: "x", level: "none" }, {})).toMatchObject({ level: null, urlSource: "none", needsTab: true });
  });
  it("normalizeNavUrl", () => {
    expect(normalizeNavUrl("example.com")).toBe("https://example.com");
    expect(normalizeNavUrl("http://x")).toBe("http://x");
    expect(normalizeNavUrl("about:blank")).toBe("about:blank");
  });
});
