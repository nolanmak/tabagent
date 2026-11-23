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
  "session.info": "none",
  "session.permissions": "none",
  "session.end": "none",
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
});

describe("D18 static sensitivity", () => {
  it.each([
    ["nav.wait", { for: "fn" }, "c"],
    ["nav.wait", { for: "text" }, undefined],
    ["tabs", { action: "attach" }, "f"],
    ["tabs", { action: "new" }, undefined],
    ["act.click", {}, undefined],
  ] as const)("%s %j -> %s", (name, params, cat) => {
    expect(sensitiveFor(getTool(name)!, params as Record<string, unknown>)).toBe(cat);
  });
  it("no other tool is statically sensitive", () => {
    const statics = tools.filter((t) => t.sensitive || Object.values(t.actions ?? {}).some((a) => a.sensitive)).map((t) => t.name);
    expect(statics.sort()).toEqual(["nav.wait", "tabs"].sort());
  });
});

// D29 lists only registered tools: at the end of M1 core has 9 (form.fill, extract.table,
// page.markdown and dialog.handle arrive in M2).
const CORE = ["tabs", "nav.goto", "nav.wait", "page.snapshot", "page.screenshot", "act.click", "act.type", "act.press", "act.select"];
const D29: Record<string, string[]> = {
  core: CORE,
  forms: [...CORE, "act.fill", "act.check"],
  data: [...CORE, "page.find"],
  dev: [...CORE],
  full: tools.map((t) => t.name),
};

describe("D29 profiles", () => {
  it("core has 9 tools and excludes act.fill", () => {
    expect(toolsForProfiles("core")).toHaveLength(9);
    expect(names(toolsForProfiles("core"))).not.toContain("act.fill");
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
    expect(PROFILES).toEqual(["core", "forms", "data", "dev", "full"]);
  });
  it("lists only registered tools (works on a smaller registry)", () => {
    const small = tools.filter((t) => ["tabs", "nav.goto", "act.fill"].includes(t.name));
    expect(names(toolsForProfiles("core", small))).toEqual(["nav.goto", "tabs"]);
    expect(names(toolsForProfiles("forms", small))).toEqual(["act.fill", "nav.goto", "tabs"]);
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
    for (const n of ["page.snapshot", "page.find", "tabs", "session.info"]) {
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
