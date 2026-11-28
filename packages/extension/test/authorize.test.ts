import { describe, expect, it } from "vitest";
import { getTool, TOOLS } from "@tabagent/protocol";
import { normalizeNavUrl, requirementsFor, type ToolLike } from "../src/background/authorize";

const reg = (n: string) => getTool(n) as unknown as ToolLike;

describe("requirementsFor: every D18 static path reaches the gate", () => {
  it.each([
    ["js.eval", { expression: "1" }, "c"],
    ["nav.wait", { for: "fn", value: "true" }, "c"],
    ["cookies.get", {}, "d"],
    ["storage.get", { kind: "local" }, "d"],
    ["network.get", { requestId: "1" }, "d"],
    ["act.upload", { ref: "e1", paths: ["/x"] }, "e"],
    ["downloads.read", { id: 1 }, "e"],
    ["tabs", { action: "attach" }, "f"],
  ])("%s -> %s", (tool, params, cat) => {
    expect(requirementsFor(reg(tool), params as any).sensitive).toBe(cat);
  });
  it("nav.wait without fn is not sensitive", () => {
    for (const f of ["load", "networkidle", "selector", "text", "url"]) expect(requirementsFor(reg("nav.wait"), { for: f }).sensitive).toBeUndefined();
  });
  it("registry fallback map applies when the registry carries no category", () => {
    expect(requirementsFor({ name: "js.eval", level: "full" }, {}).sensitive).toBe("c");
    expect(requirementsFor({ name: "nav.wait", level: "read" }, { for: "load" }).sensitive).toBeUndefined();
    expect(requirementsFor({ name: "nav.wait", level: "read", sensitive: true }, { for: "fn" }).sensitive).toBe("c");
    expect(requirementsFor({ name: "tabs", level: "none" }, { action: "attach" })).toMatchObject({ level: "read", sensitive: "f" });
  });
  it("nav.wait for=fn needs full on the site, from the registry and from the fallback (review H2)", () => {
    expect(requirementsFor(reg("nav.wait"), { for: "fn", value: "1" }).level).toBe("full");
    expect(requirementsFor(reg("nav.wait"), { for: "text", value: "x" }).level).toBe("read");
    expect(requirementsFor({ name: "nav.wait", level: "read", sensitive: true }, { for: "fn" }).level).toBe("full");
  });
  it("category g is left to the auth handler", () => {
    expect(requirementsFor({ name: "auth.login", level: "act", sensitive: "g" }, {}).sensitive).toBeUndefined();
  });
});

describe("requirementsFor: levels and tab resolution", () => {
  it("tabs actions", () => {
    expect(requirementsFor(reg("tabs"), { action: "list" })).toMatchObject({ level: null, needsTab: false });
    expect(requirementsFor(reg("tabs"), { action: "new" })).toMatchObject({ level: null, urlSource: "none" });
    expect(requirementsFor(reg("tabs"), { action: "new", url: "https://a" })).toMatchObject({ level: "act", urlSource: "param" });
    expect(requirementsFor(reg("tabs"), { action: "select" })).toMatchObject({ level: null });
    expect(requirementsFor(reg("tabs"), { action: "close" })).toMatchObject({ level: null });
    expect(requirementsFor(reg("tabs"), { action: "attach" })).toMatchObject({ urlSource: "attach-target", needsTab: false });
    expect(requirementsFor({ name: "tabs", level: "none" }, { action: "bogus" })).toMatchObject({ level: null });
  });
  it("nav.goto authorizes its target and resolves a tab only when named", () => {
    expect(requirementsFor(reg("nav.goto"), { url: "x" })).toMatchObject({ level: "act", urlSource: "param", needsTab: false, tabOptional: true });
  });
  it("tools with no tab", () => {
    for (const n of ["downloads.list", "downloads.wait", "session.info", "session.permissions", "session.end", "workflow.list", "workflow.unschedule", "workflow.runs", "workflow.review_repair", "policy.denylist_change", "policy.site_change", "session.kill_all", "settings.get", "settings.change"]) expect(requirementsFor(reg(n) ?? { name: n, level: "none" }, {})).toMatchObject({ needsTab: false, urlSource: "none", level: n.startsWith("policy.") || n === "workflow.review_repair" ? "full" : n === "settings.change" ? "act" : null });
    expect(requirementsFor(reg("downloads.read"), { id: 1 })).toMatchObject({ urlSource: "download" });
  });
  it("cookies.get may target a url param", () => {
    expect(requirementsFor(reg("cookies.get"), {})).toMatchObject({ level: "full", urlSource: "tab-or-param", needsTab: true });
  });
  it("every other site-scoped registry tool needs a tab and its registry level", () => {
    for (const t of TOOLS as unknown as ToolLike[]) {
      if (["tabs", "nav.goto", "downloads.read", "cookies.get", "policy.denylist_change", "policy.site_change", "workflow.list", "workflow.unschedule", "workflow.runs", "workflow.review_repair"].includes(t.name) || t.name.startsWith("downloads.") || t.name.startsWith("session.") || t.name.startsWith("settings.")) continue;
      const r = requirementsFor(t, {});
      expect(r.needsTab).toBe(true);
      expect(r.level).toBe(t.level === "none" ? null : t.level);
    }
  });
  it("normalizeNavUrl", () => {
    expect(normalizeNavUrl("example.com")).toBe("https://example.com");
    expect(normalizeNavUrl("http://x")).toBe("http://x");
    expect(normalizeNavUrl("about:blank")).toBe("about:blank");
  });
});
