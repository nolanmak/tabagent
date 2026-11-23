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
  ])("tabs %s requires %s", (action, level) => {
    expect(levelFor(getTool("tabs")!, { action })).toBe(level);
  });
  it("levelFor falls back to the tool level", () => {
    expect(levelFor(getTool("nav.goto")!)).toBe("act");
    expect(levelFor(getTool("tabs")!, { action: "bogus" })).toBe("none");
  });
});

describe("D18 static sensitivity", () => {
  it("no M0 tool is statically sensitive", () => {
    for (const t of tools) expect(sensitiveFor(t, {}), t.name).toBeUndefined();
    for (const action of ["list", "new", "select", "close"]) expect(sensitiveFor(getTool("tabs")!, { action })).toBeUndefined();
  });
  it("sensitiveFor reads the static category, per action and with sensitiveWhen", () => {
    const base = getTool("nav.goto")!;
    expect(sensitiveFor({ ...base, sensitive: "c", sensitiveWhen: { param: "for", values: ["fn"] } }, { for: "fn" })).toBe("c");
    expect(sensitiveFor({ ...base, sensitive: "c", sensitiveWhen: { param: "for", values: ["fn"] } }, { for: "text" })).toBeUndefined();
    expect(sensitiveFor({ ...base, sensitive: "d" }, {})).toBe("d");
    expect(sensitiveFor({ ...base, actions: { x: { level: "read", sensitive: "f" } } }, { action: "x" })).toBe("f");
  });
});

// D29 lists only registered tools: at the end of M0 core is tabs + nav.goto.
const CORE = ["tabs", "nav.goto"];
const D29: Record<string, string[]> = {
  core: CORE,
  forms: CORE,
  data: CORE,
  dev: CORE,
  full: tools.map((t) => t.name),
};

describe("D29 profiles", () => {
  it("core has only the registered core tools", () => {
    expect(toolsForProfiles("core")).toHaveLength(2);
  });
  it.each(Object.entries(D29))("%s lists exactly the D29 tools", (p, want) => {
    expect(names(toolsForProfiles(p))).toEqual([...want].sort());
  });
  it("default is core", () => {
    expect(names(toolsForProfiles(undefined))).toEqual([...CORE].sort());
  });
  it("profiles combine as a union (string or array)", () => {
    expect(names(toolsForProfiles("forms,data"))).toEqual([...CORE].sort());
    expect(names(toolsForProfiles(["forms", " data "]))).toEqual([...CORE].sort());
    expect(names(toolsForProfiles("dev,full"))).toEqual([...D29.full].sort());
  });
  it("unknown profile throws with the valid list", () => {
    expect(() => toolsForProfiles("core,bogus")).toThrow(/bogus.*core, forms, data, dev, full/);
    expect(PROFILES).toEqual(["core", "forms", "data", "dev", "full"]);
  });
  it("lists only registered tools (works on a smaller registry)", () => {
    const small = tools.filter((t) => ["tabs", "nav.back"].includes(t.name));
    expect(names(toolsForProfiles("core", small))).toEqual(["tabs"]);
    expect(names(toolsForProfiles("full", small))).toEqual(["nav.back", "tabs"]);
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
    for (const n of ["tabs", "nav.goto", "nav.back", "nav.forward", "nav.reload"]) {
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
    expect(defaultTimeout("tabs")).toBe(5000);
    expect(defaultTimeout("nav.goto")).toBe(30000);
    expect(defaultTimeout("nav.reload")).toBe(30000);
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
  };
  return m[t.name] ?? {};
}

describe("validateParams", () => {
  it("returns parsed params", () => {
    expect(validateParams(getTool("nav.goto")!, { url: "https://a" })).toEqual({ url: "https://a" });
    expect(validateParams(getTool("nav.reload")!, undefined)).toEqual({});
  });
  it("throws BAD_REQUEST naming the field", () => {
    try {
      validateParams(getTool("nav.goto")!, {});
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TabAgentError);
      expect((e as TabAgentError).code).toBe("BAD_REQUEST");
      expect((e as TabAgentError).message).toContain("url");
    }
  });
  it("root-level errors are labelled", () => {
    expect(() => validateParams(getTool("nav.goto")!, 5)).toThrow(/\(root\)/);
  });
});
