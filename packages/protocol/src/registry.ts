// Tool registry: single source of truth for the MCP tool list, REST routes, CLI, extension handlers,
// permission levels (D16), static sensitivity (D18), wrapping (D21) and profiles (D29).
import { z } from "zod";
import { TabAgentError } from "./errors";
import { TIMEOUTS } from "./messages";

export type Level = "read" | "act" | "full";
/** "none" = not site-scoped (no origin is involved). */
export type ToolLevel = Level | "none";
export const LEVEL_RANK: Record<Level | "deny", number> = { deny: 0, read: 1, act: 2, full: 3 };

/** D18 categories: a sensitive form submit, b risky click, c arbitrary JS, d credential read, e local file transfer, f tabs attach. */
export type SensitiveCategory = "a" | "b" | "c" | "d" | "e" | "f";
export const SENSITIVE_CATEGORIES: Record<SensitiveCategory, string> = {
  a: "Submitting a form with password, card or SSN-like fields",
  b: "Click that looks like purchase, delete, send or transfer",
  c: "Running arbitrary JavaScript in the page",
  d: "Reading credentials (cookies, storage, network headers/bodies)",
  e: "Transferring a local file (upload or reading a download)",
  f: "Taking over one of your tabs",
};

export type Group = "tabs" | "nav" | "page" | "act" | "form" | "extract" | "dialog" | "dev" | "files" | "session";
export type Profile = "core" | "forms" | "data" | "dev" | "full";
export const PROFILES: Profile[] = ["core", "forms", "data", "dev", "full"];

export type HandledBy = "extension" | "bridge" | "both";

export interface ActionDef {
  level: ToolLevel;
  sensitive?: SensitiveCategory;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  group: Group;
  description: string;
  params: S;
  result: z.ZodType;
  /** Site-policy level (D16). For merged tools: the lowest action level; see `actions`. */
  level: ToolLevel;
  /** Static D18 category. a/b are additionally detected at runtime by the extension. */
  sensitive?: SensitiveCategory;
  /** Static sensitivity applies only when params[param] is one of values (nav.wait for=fn). */
  sensitiveWhen?: { param: string; values: string[] };
  /** Per-action level/sensitivity (only `tabs` in v1, D13). */
  actions?: Record<string, ActionDef>;
  /** Result field paths that are page-derived (D21). `a.b`, `a[].b`; [] if none. */
  pageContent: string[];
  /** Profiles that list this tool besides `full` (D29). [] = full only. */
  profiles: Exclude<Profile, "full">[];
  handledBy: HandledBy;
}

/** Mark a result field as page-derived; the registry sweep test checks pageContent against these marks. */
function page<T extends z.ZodType>(s: T): T {
  return s.meta({ pageContent: true }) as T;
}
export function isPageField(s: z.ZodType): boolean {
  return (s.meta() as { pageContent?: boolean } | undefined)?.pageContent === true;
}

/** Integer without zod's ±2^53 bounds, which bloat the MCP tools/list JSON (#30 budget). */
const zint = () => z.number().refine(Number.isInteger, { message: "Expected an integer" });
const tabId = zint().optional().describe("Default: active tab");
const navTimeout = zint().positive().max(TIMEOUTS.max).optional().describe(`ms, default ${TIMEOUTS.navigation}`);
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const urlTitle = { url: page(z.string()).optional(), title: page(z.string()).optional() };

function def<S extends z.ZodObject>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const NAV_RESULT = loose({ ...urlTitle, status: z.number().optional() });

export const TOOLS = [
  // ---------------- tabs ----------------
  def({
    name: "tabs",
    group: "tabs",
    description: "Manage this session's tabs. action=list|new|select|close.",
    params: z.object({
      action: z.enum(["list", "new", "select", "close"]),
      tabId,
      url: z.string().optional().describe("For new"),
    }),
    result: loose({
      tabs: z.array(loose({ tabId: z.number(), url: page(z.string()), title: page(z.string()), active: z.boolean().optional() })).optional(),
      tabId: z.number().optional(),
      ...urlTitle,
    }),
    level: "none",
    actions: {
      list: { level: "none" },
      new: { level: "act" },
      select: { level: "none" },
      close: { level: "none" },
    },
    pageContent: ["tabs[].url", "tabs[].title", "url", "title"],
    profiles: ["core"],
    handledBy: "extension",
  }),
  // ---------------- nav ----------------
  def({
    name: "nav.goto",
    group: "nav",
    description: "Navigate the tab to a URL and wait for load.",
    params: z.object({
      url: z.string(),
      tabId,
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "none"]).optional(),
      timeout: navTimeout,
    }),
    result: NAV_RESULT,
    level: "act",
    pageContent: ["url", "title"],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "nav.back",
    group: "nav",
    description: "Go back in history.",
    params: z.object({ tabId, timeout: navTimeout }),
    result: NAV_RESULT,
    level: "act",
    pageContent: ["url", "title"],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "nav.forward",
    group: "nav",
    description: "Go forward in history.",
    params: z.object({ tabId, timeout: navTimeout }),
    result: NAV_RESULT,
    level: "act",
    pageContent: ["url", "title"],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "nav.reload",
    group: "nav",
    description: "Reload the tab.",
    params: z.object({ tabId, timeout: navTimeout }),
    result: NAV_RESULT,
    level: "act",
    pageContent: ["url", "title"],
    profiles: [],
    handledBy: "extension",
  }),
] as const satisfies readonly ToolDef[];

export type ToolName = (typeof TOOLS)[number]["name"];

export const TOOL_MAP: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t as unknown as ToolDef]));

export const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** MCP / Claude tool names cannot contain dots (D13). */
export function toMcpName(name: string): string {
  return name.replace(/\./g, "_");
}
export function fromMcpName(name: string): string {
  const hit = TOOLS.find((t) => toMcpName(t.name) === name);
  return hit ? hit.name : name;
}

/** Look a tool up by registry name or MCP wire name. */
export function getTool(name: string): ToolDef | undefined {
  return TOOL_MAP.get(name) ?? TOOL_MAP.get(fromMcpName(name));
}

/** Tools for a profile list like "forms,data". core is always included; "full" is everything (D29). */
export function toolsForProfiles(profiles: string | string[] | undefined, tools: readonly ToolDef[] = TOOLS as unknown as ToolDef[]): ToolDef[] {
  const list = (Array.isArray(profiles) ? profiles : (profiles ?? "core").split(",")).map((p) => p.trim()).filter(Boolean);
  for (const p of list) if (!PROFILES.includes(p as Profile)) throw new Error(`Unknown profile "${p}". Valid profiles: ${PROFILES.join(", ")}`);
  const want = new Set<string>(["core", ...list]);
  if (list.includes("full")) return [...tools];
  return tools.filter((t) => t.profiles.some((p) => want.has(p)));
}

/** Site level a call needs (per action for merged tools). */
export function levelFor(tool: ToolDef, params: Record<string, unknown> = {}): ToolLevel {
  if (tool.actions) {
    const a = tool.actions[String(params.action)];
    if (a) return a.level;
  }
  return tool.level;
}

/** Static D18 category for a call, or undefined. Dynamic a/b detection happens in the extension. */
export function sensitiveFor(tool: ToolDef, params: Record<string, unknown> = {}): SensitiveCategory | undefined {
  if (tool.actions) {
    const a = tool.actions[String(params.action)];
    if (a) return a.sensitive;
  }
  if (!tool.sensitive) return undefined;
  if (tool.sensitiveWhen && !tool.sensitiveWhen.values.includes(String(params[tool.sensitiveWhen.param]))) return undefined;
  return tool.sensitive;
}

/** D15 default timeout for a tool's `timeout` param. */
export function defaultTimeout(toolName: string): number {
  return ["nav.goto", "nav.back", "nav.forward", "nav.reload"].includes(toolName) ? TIMEOUTS.navigation : TIMEOUTS.action;
}

export function validateParams(tool: ToolDef, params: unknown): Record<string, unknown> {
  const r = tool.params.safeParse(params ?? {});
  if (!r.success) {
    throw new TabAgentError(
      "BAD_REQUEST",
      `Invalid params for ${tool.name}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data as Record<string, unknown>;
}
