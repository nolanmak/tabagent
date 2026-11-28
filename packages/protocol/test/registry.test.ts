import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defaultTimeout,
  fromMcpName,
  getTool,
  isPageField,
  levelFor,
  MCP_NAME_PATTERN,
  PROFILES,
  sensitiveFor,
  TIMEOUTS,
  toMcpName,
  TOOLS,
  toolsForProfiles,
  validateParams,
  TabAgentError,
  type ToolDef,
} from "@tabagent/protocol";

const tools = TOOLS as unknown as ToolDef[];
const names = (ts: ToolDef[]) => ts.map((t) => t.name).sort();

describe("registry invariants", () => {
  it("names are unique", () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
  it.each(tools.map((t) => [t.name, t] as const))("%s: wire name, description, required fields", (_n, t) => {
    expect(toMcpName(t.name)).toMatch(MCP_NAME_PATTERN);
    expect(fromMcpName(toMcpName(t.name))).toBe(t.name);
    expect(getTool(toMcpName(t.name))).toBe(getTool(t.name));
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.description.length).toBeLessThanOrEqual(200);
    expect(["none", "read", "act", "full"]).toContain(t.level);
    expect(Array.isArray(t.profiles)).toBe(true);
    expect(["extension", "bridge", "both"]).toContain(t.handledBy);
    expect(["supported", "degraded", "unsupported"]).toContain(t.lite);
    expect(Array.isArray(t.pageContent)).toBe(true);
    expect(t.params).toBeInstanceOf(z.ZodObject);
    expect(t.result).toBeInstanceOf(z.ZodType);
  });
  it("only tabs is merged, and every action has its own level", () => {
    const merged = tools.filter((t) => t.actions);
    expect(merged.map((t) => t.name)).toEqual(["tabs"]);
    const tabs = getTool("tabs")!;
    const actionEnum = (tabs.params.shape.action as z.ZodEnum).options as string[];
    expect(Object.keys(tabs.actions!).sort()).toEqual([...actionEnum].sort());
    for (const a of Object.values(tabs.actions!)) expect(["none", "read", "act", "full"]).toContain(a.level);
  });
  it("unknown tool lookups return undefined", () => {
    expect(getTool("nope")).toBeUndefined();
    expect(fromMcpName("nope_x")).toBe("nope_x");
  });
});

// D16: read = observe; act = input and navigation; full = Script, Storage, Dev groups.
const LEVELS: Record<string, string> = {
  tabs: "none",
  "nav.goto": "act",
  "nav.back": "act",
  "nav.forward": "act",
  "nav.reload": "act",
  "nav.wait": "read",
  "page.snapshot": "read",
  "page.screenshot": "read",
  "page.text": "read",
  "page.markdown": "read",
  "page.find": "read",
  "act.click": "act",
  "act.dblclick": "act",
  "act.hover": "act",
  "act.type": "act",
  "act.fill": "act",
  "act.press": "act",
  "act.select": "act",
  "act.check": "act",
  "act.scroll": "read",
  "act.drag": "act",
  "act.upload": "act",
  "form.describe": "read",
  "form.blockers": "read",
  "form.fill": "act",
  "form.submit": "act",
  "extract.table": "read",
  "extract.links": "read",
  "extract.schema": "read",
  "extract.paginate": "read",
  "dialog.handle": "act",
  "js.eval": "full",
  "console.list": "read",
  "network.list": "read",
  "network.get": "full",
  "network.waitFor": "read",
  "cookies.get": "full",
  "storage.get": "full",
  "downloads.list": "none",
  "downloads.wait": "none",
  "downloads.read": "none",
  "policy.denylist_change": "full",
  "policy.site_change": "full",
  "policy.mode_change": "full",
  "workflow.capture_start": "act",
  "workflow.capture_stop": "act",
  "workflow.list": "none",
  "workflow.run": "act",
  "workflow.schedule": "act",
  "workflow.unschedule": "none",
  "workflow.runs": "none",
  "workflow.review_repair": "full",
  "workflow.edit_draft": "none",
  "session.info": "none",
  "session.permissions": "none",
  "session.end": "none",
  "session.kill_all": "none",
  "settings.get": "none",
  "settings.change": "act",
  "auth.status": "read",
  "auth.login": "act",
  "auth.code": "act",
  "auth.signup": "act",
  "auth.confirm_link": "act",
  "auth.handoff": "read",
  "captcha.solve": "act",
  "task.start": "none",
  "task.end": "none",
};

describe("D16 level table", () => {
  it("covers every registered tool", () => {
    expect(Object.keys(LEVELS).sort()).toEqual(names(tools));
  });
  it.each(Object.entries(LEVELS))("%s requires %s", (name, level) => {
    expect(getTool(name)!.level).toBe(level);
  });
  it.each([
    ["list", "none"],
    ["new", "act"],
    ["select", "none"],
    ["close", "none"],
    ["attach", "read"],
  ])("tabs %s requires %s", (action, level) => {
    expect(levelFor(getTool("tabs")!, { action })).toBe(level);
  });
  it("levelFor falls back to the tool level", () => {
    expect(levelFor(getTool("act.click")!)).toBe("act");
    expect(levelFor(getTool("tabs")!, { action: "bogus" })).toBe("none");
  });
  it("nav.wait for=fn is arbitrary JS and needs full, like js.eval; the other waits stay read (review H2)", () => {
    expect(levelFor(getTool("nav.wait")!, { for: "fn", value: "true" })).toBe("full");
    expect(levelFor(getTool("nav.wait")!, { for: "fn" })).toBe(levelFor(getTool("js.eval")!, {}));
    for (const f of ["load", "networkidle", "selector", "text", "url"]) expect(levelFor(getTool("nav.wait")!, { for: f })).toBe("read");
  });
});

describe("D18 static sensitivity", () => {
  it.each([
    ["js.eval", {}, "c"],
    ["nav.wait", { for: "fn" }, "c"],
    ["nav.wait", { for: "text" }, undefined],
    ["cookies.get", {}, "d"],
    ["storage.get", {}, "d"],
    ["network.get", {}, "d"],
    ["act.upload", {}, "e"],
    ["downloads.read", {}, "e"],
    ["tabs", { action: "attach" }, "f"],
    ["tabs", { action: "new" }, undefined],
    ["policy.denylist_change", {}, "p"],
    ["policy.site_change", {}, "p"],
    ["policy.mode_change", {}, "p"],
    ["act.click", {}, undefined],
    ["network.list", {}, undefined],
  ] as const)("%s %j -> %s", (name, params, cat) => {
    expect(sensitiveFor(getTool(name)!, params as Record<string, unknown>)).toBe(cat);
  });
  it("no other tool is statically sensitive", () => {
    const statics = tools.filter((t) => t.sensitive || Object.values(t.actions ?? {}).some((a) => a.sensitive)).map((t) => t.name);
    expect(statics.sort()).toEqual(["act.upload", "cookies.get", "downloads.read", "js.eval", "nav.wait", "network.get", "policy.denylist_change", "policy.mode_change", "policy.site_change", "storage.get", "tabs", "workflow.review_repair"].sort());
  });
});

const CORE = ["tabs", "nav.goto", "nav.wait", "page.snapshot", "page.screenshot", "act.click", "act.type", "act.press", "act.select", "form.fill", "extract.table", "page.markdown", "dialog.handle", "task.start", "task.end"];
const D29: Record<string, string[]> = {
  core: CORE,
  forms: [...CORE, "form.describe", "form.blockers", "form.submit", "act.fill", "act.check", "act.upload"],
  data: [...CORE, "page.text", "page.find", "extract.links", "extract.schema", "extract.paginate", "downloads.list", "downloads.wait", "downloads.read"],
  dev: [...CORE, "js.eval", "console.list", "network.list", "network.get", "network.waitFor", "cookies.get", "storage.get"],
  // DA10: full is everything except the opt-in auth group.
  full: tools.filter((t) => t.group !== "auth").map((t) => t.name),
  auth: [...CORE, "auth.status", "auth.login", "auth.signup", "auth.code", "auth.confirm_link", "auth.handoff", "captcha.solve"],
};

describe("D29 profiles", () => {
  it("core has 15 tools and excludes form.describe", () => {
    expect(toolsForProfiles("core")).toHaveLength(15);
    expect(names(toolsForProfiles("core"))).not.toContain("form.describe");
  });
  it.each(Object.entries(D29))("%s lists exactly the D29 tools", (p, want) => {
    expect(names(toolsForProfiles(p))).toEqual([...want].sort());
  });
  it("default is core", () => {
    expect(names(toolsForProfiles(undefined))).toEqual([...CORE].sort());
  });
  it("profiles combine as a union (string or array)", () => {
    const union = [...new Set([...D29.forms, ...D29.data])].sort();
    expect(names(toolsForProfiles("forms,data"))).toEqual(union);
    expect(names(toolsForProfiles(["forms", " data "]))).toEqual(union);
    expect(names(toolsForProfiles("dev,full"))).toEqual([...D29.full].sort());
  });
  it("unknown profile throws with the valid list", () => {
    expect(() => toolsForProfiles("core,bogus")).toThrow(/bogus.*core, forms, data, dev, full/);
    expect(PROFILES).toEqual(["core", "forms", "data", "dev", "full", "auth"]);
  });
  it("lists only registered tools (works on a smaller registry)", () => {
    const small = tools.filter((t) => ["tabs", "nav.goto", "js.eval"].includes(t.name));
    expect(names(toolsForProfiles("core", small))).toEqual(["nav.goto", "tabs"]);
    expect(names(toolsForProfiles("dev", small))).toEqual(["js.eval", "nav.goto", "tabs"]);
  });
});

describe("D21 pageContent sweep", () => {
  /** Paths of result fields marked page-derived in the result schema. */
  function markedPaths(schema: z.ZodType, prefix = ""): string[] {
    let s: z.ZodType = schema;
    while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      if (isPageField(s)) break;
      s = s.unwrap() as z.ZodType;
    }
    if (prefix && isPageField(s)) return [prefix];
    if (s instanceof z.ZodObject) return Object.entries(s.shape).flatMap(([k, v]) => markedPaths(v as z.ZodType, prefix ? `${prefix}.${k}` : k));
    if (s instanceof z.ZodArray) return markedPaths(s.element as z.ZodType, `${prefix}[]`);
    return [];
  }
  it.each(tools.map((t) => [t.name, t] as const))("%s declares every page-derived result field", (_n, t) => {
    expect([...t.pageContent].sort()).toEqual(markedPaths(t.result).sort());
  });
  it("a tool returning page text without pageContent fails the sweep", () => {
    const bad = z.looseObject({ text: z.string().meta({ pageContent: true }) });
    expect(markedPaths(bad)).toEqual(["text"]);
  });
  it("tools with free-text page results are covered", () => {
    for (const n of ["page.snapshot", "page.text", "page.markdown", "extract.table", "console.list", "tabs", "downloads.list", "dialog.handle"]) {
      expect(getTool(n)!.pageContent.length, n).toBeGreaterThan(0);
    }
  });
});

describe("D15 timeouts", () => {
  it("defaults", () => {
    expect(TIMEOUTS.action).toBe(5000);
    expect(TIMEOUTS.navigation).toBe(30000);
    expect(TIMEOUTS.max).toBe(120000);
    expect(TIMEOUTS.prompt).toBe(120000);
    expect(defaultTimeout("act.click")).toBe(5000);
    expect(defaultTimeout("page.find")).toBe(5000);
    expect(defaultTimeout("nav.goto")).toBe(30000);
    expect(defaultTimeout("nav.wait")).toBe(30000);
  });
  it("every waiting tool caps timeout at 120000", () => {
    for (const t of tools) {
      if (!("timeout" in t.params.shape)) continue;
      expect(t.params.safeParse({ ...minimal(t), timeout: 120_000 }).success, t.name).toBe(true);
      expect(t.params.safeParse({ ...minimal(t), timeout: 120_001 }).success, t.name).toBe(false);
    }
  });
});

function minimal(t: ToolDef): Record<string, unknown> {
  const m: Record<string, Record<string, unknown>> = {
    "nav.goto": { url: "https://x" },
    "nav.wait": { for: "load" },
    "page.find": { by: "text", value: "x" },
    "act.type": { text: "x" },
    "act.fill": { ref: "e1", value: "x" },
    "act.press": { key: "Enter" },
    "act.select": { ref: "e1", values: ["a"] },
    "act.drag": { from: "e1", to: "e2" },
    "act.upload": { ref: "e1", paths: ["/x"] },
    "form.fill": { fields: {} },
    "extract.paginate": { extractor: "table" },
    "js.eval": { expression: "1" },
  };
  return m[t.name] ?? (t.params.shape.ref ? { ref: "e1" } : {});
}

describe("validateParams", () => {
  it("returns parsed params", () => {
    expect(validateParams(getTool("nav.goto")!, { url: "https://a" })).toEqual({ url: "https://a" });
    expect(validateParams(getTool("session.end")!, undefined)).toEqual({});
  });
  it("throws BAD_REQUEST naming the field", () => {
    try {
      validateParams(getTool("act.click")!, {});
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TabAgentError);
      expect((e as TabAgentError).code).toBe("BAD_REQUEST");
      expect((e as TabAgentError).message).toContain("ref");
    }
  });
  it("root-level errors are labelled", () => {
    expect(() => validateParams(getTool("act.click")!, 5)).toThrow(/\(root\)/);
  });
});

describe("policy.site_change accepts authAuto (#131)", () => {
  const t = () => getTool("policy.site_change")!;
  it("takes authAuto alone or with other changes, and rejects unknown keys", () => {
    expect(() => validateParams(t(), { origin: "https://a.example", changes: { authAuto: true }, reason: "r" })).not.toThrow();
    expect(() => validateParams(t(), { origin: "https://a.example", changes: { auth: true, authAuto: false }, reason: "r" })).not.toThrow();
    expect(() => validateParams(t(), { origin: "https://a.example", changes: { authAuto: "yes" }, reason: "r" })).toThrow();
    expect(() => validateParams(t(), { origin: "https://a.example", changes: { authAlways: ["x"] }, reason: "r" })).toThrow();
    expect(() => validateParams(t(), { origin: "https://a.example", changes: {}, reason: "r" })).toThrow();
  });
  it("its result reports authAuto", () => {
    const shape = (t().result as any).shape.site.shape;
    expect(Object.keys(shape)).toContain("authAuto");
  });
});

describe("workflow.edit_draft params (#107)", () => {
  const tool = () => getTool("workflow.edit_draft")!;
  const id = "7b0f3c1e-2d4a-4c6b-9e8f-0a1b2c3d4e5f";
  it("accepts remove_step and parameterize ops", () => {
    const ops = [{ op: "remove_step", index: 0 }, { op: "parameterize", index: 2, name: "SEARCH_TERM" }];
    expect(validateParams(tool(), { id, ops })).toEqual({ id, ops });
  });
  it.each([
    ["no ops", { id, ops: [] }],
    ["unknown op", { id, ops: [{ op: "rename", index: 0 }] }],
    ["negative index", { id, ops: [{ op: "remove_step", index: -1 }] }],
    ["fractional index", { id, ops: [{ op: "remove_step", index: 1.5 }] }],
    ["parameterize without a name", { id, ops: [{ op: "parameterize", index: 0 }] }],
    ["lower-case name", { id, ops: [{ op: "parameterize", index: 0, name: "search" }] }],
    ["braced name", { id, ops: [{ op: "parameterize", index: 0, name: "{{SEARCH}}" }] }],
    ["name starting with an underscore", { id, ops: [{ op: "parameterize", index: 0, name: "_X" }] }],
    ["name over 80 characters", { id, ops: [{ op: "parameterize", index: 0, name: "A".repeat(81) }] }],
    ["extra field", { id, ops: [{ op: "remove_step", index: 0, name: "X" }] }],
    ["non-uuid id", { id: "abc", ops: [{ op: "remove_step", index: 0 }] }],
  ])("rejects %s with BAD_REQUEST", (_why, params) => {
    expect(() => validateParams(tool(), params)).toThrow(TabAgentError);
  });
  it("is a full-profile, no-tab, no-prompt authoring tool", () => {
    expect(tool()).toMatchObject({ group: "workflow", level: "none", profiles: [], handledBy: "extension" });
    expect(tool().sensitive).toBeUndefined();
  });
});
