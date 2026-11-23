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

export type Group = "tabs" | "nav" | "page" | "act" | "session";
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
const ref = z.string().describe("Element ref, e.g. e12");
const actTimeout = zint().positive().max(TIMEOUTS.max).optional().describe(`ms, default ${TIMEOUTS.action}`);
const navTimeout = zint().positive().max(TIMEOUTS.max).optional().describe(`ms, default ${TIMEOUTS.navigation}`);
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const empty = loose({});
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
    description: "Manage this session's tabs. action=list|new|select|close|attach. attach adopts the user's active tab (gated).",
    params: z.object({
      action: z.enum(["list", "new", "select", "close", "attach"]),
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
      attach: { level: "read", sensitive: "f" },
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
  def({
    name: "nav.wait",
    group: "nav",
    description: "Wait for: load | networkidle | selector (CSS) | text | url (substring or /regex/) | fn (JS predicate; gated).",
    params: z.object({
      for: z.enum(["load", "networkidle", "selector", "text", "url", "fn"]),
      value: z.string().optional(),
      tabId,
      timeout: navTimeout,
    }),
    result: loose({ ok: z.boolean().optional(), url: page(z.string()).optional() }),
    level: "read",
    sensitive: "c",
    sensitiveWhen: { param: "for", values: ["fn"] },
    pageContent: ["url"],
    profiles: ["core"],
    handledBy: "extension",
  }),
  // ---------------- page ----------------
  def({
    name: "page.snapshot",
    group: "page",
    description: "Accessibility snapshot with [ref=eN] on interactive nodes. Act on refs.",
    params: z.object({
      tabId,
      mode: z.enum(["interactive", "full"]).optional(),
      root: ref.optional(),
      maxTokens: zint().positive().optional(),
    }),
    result: loose({
      ...urlTitle,
      snapshot: page(z.string()).optional(),
      refs: z.number().optional(),
      truncated: z.boolean().optional(),
    }),
    level: "read",
    pageContent: ["snapshot", "title", "url"],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "page.screenshot",
    group: "page",
    description: "Screenshot the viewport, full page, or an element ref. marks=true labels refs on the image.",
    params: z.object({
      tabId,
      target: z.enum(["viewport", "full", "ref"]).optional().describe("default viewport"),
      ref: ref.optional(),
      format: z.enum(["png", "jpeg"]).optional(),
      quality: zint().min(1).max(100).optional(),
      marks: z.boolean().optional(),
    }),
    result: loose({ mime: z.string(), dataBase64: z.string(), width: z.number(), height: z.number(), note: z.string().optional() }),
    level: "read",
    pageContent: [],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "page.find",
    group: "page",
    description: "Find elements by text, role (+name), label, css or xpath. Returns refs.",
    params: z.object({
      tabId,
      by: z.enum(["text", "role", "label", "css", "xpath"]),
      value: z.string(),
      name: z.string().optional().describe("Accessible name, with by=role"),
      root: ref.optional(),
      timeout: actTimeout,
    }),
    result: loose({ matches: page(z.array(loose({ ref: z.string(), role: z.string(), name: z.string() }))), truncated: z.boolean().optional() }),
    level: "read",
    pageContent: ["matches"],
    profiles: ["data"],
    handledBy: "extension",
  }),
  // ---------------- act ----------------
  def({
    name: "act.click",
    group: "act",
    description: "Click an element (auto-waits until actionable).",
    params: z.object({
      ref,
      tabId,
      button: z.enum(["left", "right", "middle"]).optional(),
      clickCount: zint().min(1).max(3).optional(),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
      timeout: actTimeout,
    }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "act.dblclick",
    group: "act",
    description: "Double-click an element.",
    params: z.object({ ref, tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "act.hover",
    group: "act",
    description: "Hover an element.",
    params: z.object({ ref, tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "act.type",
    group: "act",
    description: "Type text with real key events (into ref if given, else the focused element). submit=true presses Enter.",
    params: z.object({
      text: z.string(),
      ref: ref.optional(),
      tabId,
      submit: z.boolean().optional(),
      clear: z.boolean().optional(),
      timeout: actTimeout,
    }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "act.fill",
    group: "act",
    description: "Set an input/textarea/contenteditable value (clears first; React-safe).",
    params: z.object({ ref, value: z.string(), tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["forms"],
    handledBy: "extension",
  }),
  def({
    name: "act.press",
    group: "act",
    description: "Press a key or chord, e.g. Enter, Tab, Escape, ArrowDown, Control+a, Meta+Shift+k.",
    params: z.object({ key: z.string(), ref: ref.optional(), tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "act.select",
    group: "act",
    description: "Select option(s) in a <select> or ARIA combobox/listbox by label or value.",
    params: z.object({ ref, values: z.array(z.string()), tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["core"],
    handledBy: "extension",
  }),
  def({
    name: "act.check",
    group: "act",
    description: "Set a checkbox/radio/switch to checked or unchecked.",
    params: z.object({ ref, checked: z.boolean().optional(), tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: ["forms"],
    handledBy: "extension",
  }),
  def({
    // Scrolling only changes what is visible, so it is an observation aid: level read (D16 table).
    name: "act.scroll",
    group: "act",
    description: "Scroll a ref into view, or scroll the page/ref by dx,dy pixels.",
    params: z.object({ ref: ref.optional(), dx: z.number().optional(), dy: z.number().optional(), tabId }),
    result: empty,
    level: "read",
    pageContent: [],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "act.drag",
    group: "act",
    description: "Drag from one ref to another.",
    params: z.object({ from: ref, to: ref, tabId, timeout: actTimeout }),
    result: empty,
    level: "act",
    pageContent: [],
    profiles: [],
    handledBy: "extension",
  }),
  // ---------------- session ----------------
  def({
    name: "session.info",
    group: "session",
    description: "This session's id, label, tabs, mode and connection state.",
    params: z.object({}),
    result: loose({ tabs: z.array(loose({ url: page(z.string()).optional(), title: page(z.string()).optional() })).optional() }),
    level: "none",
    pageContent: ["tabs[].url", "tabs[].title"],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "session.permissions",
    group: "session",
    description: "Effective permission level for the current tab's site (or url) and this session's token scope.",
    params: z.object({ url: z.string().optional() }),
    result: empty,
    level: "none",
    pageContent: [],
    profiles: [],
    handledBy: "extension",
  }),
  def({
    name: "session.end",
    group: "session",
    description: "End this session and release its tabs.",
    params: z.object({}),
    result: empty,
    level: "none",
    pageContent: [],
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
  if (list.includes("full")) return tools.slice();
  const want = new Set<string>(["core", ...list]);
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
  return ["nav.goto", "nav.back", "nav.forward", "nav.reload", "nav.wait"].includes(toolName) ? TIMEOUTS.navigation : TIMEOUTS.action;
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
