// Tool registry: single source of truth for the MCP tool list, REST routes, CLI, extension handlers,
// permission levels (D16), static sensitivity (D18), wrapping (D21) and profiles (D29).
import { z } from "zod";
import { TabAgentError } from "./errors";
import { TIMEOUTS } from "./messages";
import { AUTH_TOOLS, OPT_IN_GROUPS } from "./auth";
import { CAPTCHA_TOOLS } from "./captcha";

export type Level = "read" | "act" | "full";
/** "none" = not site-scoped (no origin is involved). */
export type ToolLevel = Level | "none";
export const LEVEL_RANK: Record<Level | "deny", number> = { deny: 0, read: 1, act: 2, full: 3 };

/** D18 categories: a sensitive form submit, b risky click, c arbitrary JS, d credential read, e local file transfer, f tabs attach. */
export type SensitiveCategory = "a" | "b" | "c" | "d" | "e" | "f" | "p" | "r";
export const SENSITIVE_CATEGORIES: Record<SensitiveCategory, string> = {
  a: "Submitting a form with password, card or SSN-like fields",
  b: "Click that looks like purchase, delete, send or transfer",
  c: "Running arbitrary JavaScript in the page",
  d: "Reading credentials (cookies, storage, network headers/bodies)",
  e: "Transferring a local file (upload or reading a download)",
  f: "Taking over one of your tabs",
  p: "Changing the TabAgent denylist",
  r: "Accepting a proposed workflow repair",
};

export type Group = "tabs" | "nav" | "page" | "act" | "form" | "extract" | "dialog" | "dev" | "files" | "session" | "auth" | "policy" | "workflow";
export type Profile = "core" | "forms" | "data" | "dev" | "full" | "auth";
export const PROFILES: Profile[] = ["core", "forms", "data", "dev", "full", "auth"];

export type LiteSupport = "supported" | "degraded" | "unsupported";
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
  /** A higher site level when params[param] is one of values (nav.wait for=fn needs full, like js.eval). */
  levelWhen?: { param: string; values: string[]; level: Level };
  /** Per-action level/sensitivity (only `tabs` in v1, D13). */
  actions?: Record<string, ActionDef>;
  /** Result field paths that are page-derived (D21). `a.b`, `a[].b`; [] if none. */
  pageContent: string[];
  /** Profiles that list this tool besides `full` (D29). [] = full only. */
  profiles: Exclude<Profile, "full">[];
  lite: LiteSupport;
  handledBy: HandledBy;
  /** DA1: handles a secret; its result schema must have no free-text string (auth group). */
  secret?: boolean;
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
/** #64: a submit click that changed nothing returns the form's remaining blockers. */
const SUBMIT_RESULT = loose({ blockers: page(z.array(z.unknown())).optional(), hint: z.string().optional() });

export const TOOLS = [
  // ---------------- tabs ----------------
  def({
    name: "tabs",
    group: "tabs",
    description: "Manage this session's tabs. action=list|new|select|close|attach. attach adopts the user's active tab (always asks).",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "nav.wait",
    group: "nav",
    description: "Wait for: load | networkidle | selector (CSS) | text | url (substring or /regex/) | fn (JS predicate, re-run every 100ms; needs full access, asks the user).",
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
    levelWhen: { param: "for", values: ["fn"], level: "full" },
    pageContent: ["url"],
    profiles: ["core"],
    lite: "supported",
    handledBy: "extension",
  }),
  // ---------------- page ----------------
  def({
    name: "page.snapshot",
    group: "page",
    description: "Accessibility snapshot with [ref=eN] on interactive nodes. Act on refs. diff=true returns only changes.",
    params: z.object({
      tabId,
      mode: z.enum(["interactive", "full"]).optional(),
      root: ref.optional(),
      maxTokens: zint().positive().optional(),
      diff: z.boolean().optional(),
    }),
    result: loose({
      ...urlTitle,
      snapshot: page(z.string()).optional(),
      refs: z.number().optional(),
      truncated: z.boolean().optional(),
      /** true when `snapshot` holds +/-/~ diff lines (diff=true with a baseline). */
      diff: z.boolean().optional(),
      /** true when diff=true was asked but there was no baseline, so `snapshot` is the full tree. */
      full: z.boolean().optional(),
    }),
    level: "read",
    pageContent: ["snapshot", "title", "url"],
    profiles: ["core"],
    lite: "supported",
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
    lite: "degraded",
    handledBy: "extension",
  }),
  def({
    name: "page.text",
    group: "page",
    description: "Visible text of the page (or of a ref).",
    params: z.object({ tabId, ref: ref.optional() }),
    result: loose({ text: page(z.string()) }),
    level: "read",
    pageContent: ["text"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "page.markdown",
    group: "page",
    description: "Main readable content as Markdown.",
    params: z.object({ tabId, maxChars: zint().positive().optional() }),
    result: loose({ markdown: page(z.string()), title: page(z.string()).optional() }),
    level: "read",
    pageContent: ["markdown", "title"],
    profiles: ["core"],
    lite: "supported",
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
    lite: "supported",
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
    result: SUBMIT_RESULT,
    level: "act",
    pageContent: ["blockers"],
    profiles: ["core"],
    lite: "supported",
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
    lite: "degraded",
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
    lite: "degraded",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
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
    lite: "degraded",
    handledBy: "extension",
  }),
  def({
    name: "act.upload",
    group: "act",
    description: "Set files on a file input. Paths must be inside the bridge's upload dirs (default ~/.tabagent/uploads). Asks the user.",
    params: z.object({ ref, paths: z.array(z.string()).min(1), tabId, timeout: actTimeout }),
    result: loose({ files: z.array(loose({ name: z.string(), size: z.number().optional() })).optional() }),
    level: "act",
    sensitive: "e",
    pageContent: [],
    profiles: ["forms"],
    lite: "unsupported",
    handledBy: "both",
  }),
  // ---------------- form ----------------
  def({
    name: "form.describe",
    group: "form",
    description: "List form fields: ref, label, type, required, options, current value.",
    params: z.object({ tabId, ref: ref.optional().describe("A form or container ref; default: all forms") }),
    result: loose({ fields: page(z.array(z.unknown())).optional(), forms: page(z.array(z.unknown())).optional() }),
    level: "read",
    pageContent: ["fields", "forms"],
    profiles: ["forms"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "form.fill",
    group: "form",
    description: "Fill many fields in one call: fields maps label or ref -> value (string; boolean for checkboxes; string[] for multi-select).",
    params: z.object({
      fields: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])),
      tabId,
      ref: ref.optional().describe("Limit to this form/container"),
      timeout: actTimeout.describe(`ms per field, default ${TIMEOUTS.action}`),
    }),
    result: loose({ filled: z.unknown().optional(), failed: z.array(loose({ key: z.string(), code: z.string(), message: page(z.string()) })).optional() }),
    level: "act",
    pageContent: ["failed[].message"],
    profiles: ["core"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "form.blockers",
    group: "form",
    description: "Why a form can't submit: required fields empty or unchecked, invalid fields (with the page's error text), and whether the submit button is disabled.",
    params: z.object({ tabId, ref: ref.optional().describe("A form, field or submit button; default: the focused form, else the main form") }),
    result: loose({ form: page(z.unknown()).optional(), submit: page(z.unknown()).optional(), blockers: page(z.array(z.unknown())).optional(), more: z.number().optional() }),
    level: "read",
    pageContent: ["blockers", "form", "submit"],
    profiles: ["forms"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "form.submit",
    group: "form",
    description: "Submit a form (by form ref, or the form containing ref). Password/card forms ask the user.",
    params: z.object({ ref: ref.optional(), tabId, timeout: actTimeout }),
    result: SUBMIT_RESULT,
    level: "act",
    pageContent: ["blockers"],
    profiles: ["forms"],
    lite: "supported",
    handledBy: "extension",
  }),
  // ---------------- extract ----------------
  def({
    name: "extract.table",
    group: "extract",
    description: "Extract an HTML/ARIA table to rows. Picks the largest table unless ref/index given.",
    params: z.object({
      tabId,
      ref: ref.optional(),
      index: zint().min(0).optional(),
      format: z.enum(["json", "csv"]).optional(),
    }),
    result: loose({ headers: page(z.array(z.string())).optional(), rows: page(z.array(z.unknown())).optional(), csv: page(z.string()).optional() }),
    level: "read",
    pageContent: ["headers", "rows", "csv"],
    profiles: ["core"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "extract.links",
    group: "extract",
    description: "All links (text, href), optionally filtered by substring or /regex/ on text or href.",
    params: z.object({ tabId, root: ref.optional(), filter: z.string().optional(), limit: zint().positive().optional() }),
    result: loose({ links: page(z.array(z.unknown())), count: z.number().optional() }),
    level: "read",
    pageContent: ["links"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "extract.schema",
    group: "extract",
    description: "Extract structured data (JSON-LD, microdata, then repeated items). Returns data plus selectors; pass selectors back to skip detection.",
    params: z.object({
      schema: z.record(z.string(), z.any()).optional(),
      hint: z.string().optional(),
      selectors: z.object({ item: z.string().optional(), fields: z.record(z.string(), z.string()) }).optional(),
      tabId,
    }),
    result: loose({ data: page(z.unknown()), selectors: page(z.unknown()).optional() }),
    level: "read",
    pageContent: ["data", "selectors"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "extract.paginate",
    group: "extract",
    description: "Run an extractor (table|links|schema) across pages, following next (ref or CSS; default: a Next control) up to maxPages (5).",
    params: z.object({
      extractor: z.enum(["table", "links", "schema"]),
      next: z.string().optional(),
      maxPages: zint().min(1).max(50).optional(),
      schema: z.record(z.string(), z.any()).optional(),
      selectors: z.object({ item: z.string().optional(), fields: z.record(z.string(), z.string()) }).optional(),
      timeout: actTimeout.describe(`ms per page, default ${TIMEOUTS.action}`),
      tabId,
    }),
    result: loose({
      pages: z.number().optional(),
      headers: page(z.array(z.string())).optional(),
      rows: page(z.array(z.unknown())).optional(),
      links: page(z.array(z.unknown())).optional(),
      data: page(z.unknown()).optional(),
      urls: page(z.array(z.string())).optional(),
      error: loose({ code: z.string(), message: page(z.string()) }).optional(),
    }),
    level: "read",
    pageContent: ["rows", "links", "data", "headers", "urls", "error.message"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  // ---------------- dialog ----------------
  def({
    name: "dialog.handle",
    group: "dialog",
    description: "Accept or dismiss the open alert/confirm/prompt/beforeunload dialog.",
    params: z.object({ action: z.enum(["accept", "dismiss"]), promptText: z.string().optional(), tabId }),
    result: loose({ dialog: page(z.unknown()).optional() }),
    level: "act",
    pageContent: ["dialog"],
    profiles: ["core"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  // ---------------- dev ----------------
  def({
    name: "js.eval",
    group: "dev",
    description: "Evaluate a JS expression (awaits promises, returns JSON). world=main|isolated. Asks the user.",
    params: z.object({ expression: z.string(), world: z.enum(["main", "isolated"]).optional(), tabId, timeout: actTimeout }),
    result: loose({ value: page(z.unknown()) }),
    level: "full",
    sensitive: "c",
    pageContent: ["value"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "console.list",
    group: "dev",
    description: "Recent console messages and errors for the tab.",
    params: z.object({ tabId, level: z.string().optional(), limit: zint().positive().optional() }),
    result: loose({ messages: page(z.array(z.unknown())) }),
    level: "read",
    pageContent: ["messages"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "network.list",
    group: "dev",
    description: "Recent requests of the top-level page (no headers or bodies). Filter by url substring, method, status, type.",
    params: z.object({
      tabId,
      url: z.string().optional(),
      method: z.string().optional(),
      status: zint().optional(),
      type: z.string().optional(),
      limit: zint().positive().optional(),
    }),
    result: loose({ requests: page(z.array(z.unknown())) }),
    level: "read",
    pageContent: ["requests"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "network.get",
    group: "dev",
    description: "Full request/response for a request id, including headers and body. Asks the user.",
    params: z.object({ id: z.string(), tabId }),
    result: loose({ request: page(z.unknown()).optional(), response: page(z.unknown()).optional(), body: page(z.unknown()).optional() }),
    level: "full",
    sensitive: "d",
    pageContent: ["request", "response", "body"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "network.waitFor",
    group: "dev",
    description: "Wait for a request completing after this call that matches url (substring or /regex/), method, status.",
    params: z.object({ url: z.string().optional(), method: z.string().optional(), status: zint().optional(), tabId, timeout: actTimeout }),
    result: loose({ request: page(z.unknown()).optional(), url: page(z.string()).optional() }),
    level: "read",
    pageContent: ["request", "url"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "cookies.get",
    group: "dev",
    description: "Cookies for the tab's current origin. Asks the user.",
    params: z.object({ url: z.string().optional(), tabId }),
    result: loose({ cookies: page(z.array(z.unknown())) }),
    level: "full",
    sensitive: "d",
    pageContent: ["cookies"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  def({
    name: "storage.get",
    group: "dev",
    description: "Read localStorage or sessionStorage for the tab's origin. Asks the user.",
    params: z.object({ kind: z.enum(["local", "session"]), tabId }),
    result: loose({ entries: page(z.unknown()) }),
    level: "full",
    sensitive: "d",
    pageContent: ["entries"],
    profiles: ["dev"],
    lite: "unsupported",
    handledBy: "extension",
  }),
  // ---------------- files ----------------
  def({
    name: "downloads.list",
    group: "files",
    description: "Downloads started by this session's tabs.",
    params: z.object({}),
    result: loose({ downloads: z.array(loose({ id: z.number(), filename: page(z.string()), url: page(z.string()).optional(), state: z.string() })) }),
    level: "none",
    pageContent: ["downloads[].filename", "downloads[].url"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "downloads.wait",
    group: "files",
    description: "Wait for the next (or a given) download of this session to complete.",
    params: z.object({ id: zint().optional(), timeout: navTimeout }),
    result: loose({ id: z.number(), filename: page(z.string()), url: page(z.string()).optional(), state: z.string() }),
    level: "none",
    pageContent: ["filename", "url"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "downloads.read",
    group: "files",
    description: "Read a completed download of this session (UTF-8 text or base64; max 5 MB). Asks the user.",
    params: z.object({ id: zint() }),
    result: loose({
      id: z.number(),
      filename: page(z.string()),
      encoding: z.enum(["utf8", "base64"]),
      size: z.number(),
      text: page(z.string()).optional(),
      data: page(z.string()).optional(),
    }),
    level: "none",
    sensitive: "e",
    pageContent: ["filename", "text", "data"],
    profiles: ["data"],
    lite: "supported",
    handledBy: "both",
  }),
  // ---------------- session ----------------
  def({
    name: "policy.denylist_change",
    group: "policy",
    description: "Request an exact add/remove change to the extension denylist. Always requires a visible extension approval; YOLO and saved site permissions do not bypass it.",
    params: z.object({
      changes: z.array(z.object({ op: z.enum(["add", "remove"]), glob: z.string() })).min(1).max(50),
      reason: z.string().min(1).max(500),
    }),
    result: loose({ status: z.literal("applied"), denylist: z.array(z.string()), applied: z.array(z.object({ op: z.enum(["add", "remove"]), glob: z.string() })) }),
    level: "full",
    sensitive: "p",
    pageContent: [],
    profiles: [],
    lite: "supported",
    handledBy: "extension",
  }),
  // ---------------- workflow ----------------
  def({
    name: "workflow.capture_start",
    group: "workflow",
    description: "Start recording an agent-run or manual browser task in this tab into a reviewable recipe. Secret, password, card and MFA values are omitted.",
    params: z.object({ tabId, source: z.enum(["agent", "manual"]), name: z.string().min(1).max(120) }),
    result: loose({ started: z.boolean(), tabId: z.number(), source: z.enum(["agent", "manual"]) }),
    level: "act",
    pageContent: [],
    profiles: [],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "workflow.capture_stop",
    group: "workflow",
    description: "Stop a capture and save a draft recipe. Review it before any replay or schedule.",
    params: z.object({ tabId }),
    result: loose({ recipe: z.unknown() }),
    level: "act",
    pageContent: [],
    profiles: [],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "workflow.list",
    group: "workflow",
    description: "List locally stored workflow recipes and their review state.",
    params: z.object({}),
    result: loose({ workflows: z.array(z.unknown()) }),
    level: "none",
    pageContent: [],
    profiles: [],
    lite: "supported",
    handledBy: "extension",
  }),
  def({
    name: "workflow.run",
    group: "workflow",
    description: "Run a user-reviewed low-risk recipe in an owned tab. Stops for secrets, sign-in, MFA, risky actions, missing targets, or ambiguous repairs.",
    params: z.object({ id: z.string().uuid(), tabId }),
    result: loose({ run: z.unknown() }),
    level: "act",
    pageContent: [],
    profiles: [],
    lite: "supported",
    handledBy: "extension",
  }),
  def({ name: "workflow.schedule", group: "workflow", description: "Schedule a reviewed low-risk recipe using five-field cron and an IANA timezone. Missed runs are not replayed.", params: z.object({ id: z.string().uuid(), tabId, cron: z.string(), timeZone: z.string() }), result: loose({ schedule: z.unknown() }), level: "act", pageContent: [], profiles: [], lite: "supported", handledBy: "extension" }),
  def({ name: "workflow.unschedule", group: "workflow", description: "Disable a saved workflow schedule.", params: z.object({ id: z.string().uuid() }), result: loose({ ok: z.boolean() }), level: "none", pageContent: [], profiles: [], lite: "supported", handledBy: "extension" }),
  def({ name: "workflow.runs", group: "workflow", description: "List inspectable local run history for workflow recipes.", params: z.object({ id: z.string().uuid().optional() }), result: loose({ runs: z.array(z.unknown()) }), level: "none", pageContent: [], profiles: [], lite: "supported", handledBy: "extension" }),
  def({ name: "workflow.review_repair", group: "workflow", description: "Accept or reject a proposed locator repair after inspecting the run.", params: z.object({ recipeId: z.string().uuid(), repairId: z.string().uuid(), decision: z.enum(["accept", "reject"]) }), result: loose({ repair: z.unknown(), recipe: z.unknown() }), level: "full", sensitive: "r", pageContent: [], profiles: [], lite: "supported", handledBy: "extension" }),
  def({
    name: "session.info",
    group: "session",
    description: "This session's id, label, tabs, mode and connection state.",
    params: z.object({}),
    result: loose({ tabs: z.array(loose({ url: page(z.string()).optional(), title: page(z.string()).optional() })).optional() }),
    level: "none",
    pageContent: ["tabs[].url", "tabs[].title"],
    profiles: [],
    lite: "supported",
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
    lite: "supported",
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
    lite: "supported",
    handledBy: "extension",
  }),
  ...AUTH_TOOLS,
  ...CAPTCHA_TOOLS,
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
  // full = everything except opt-in groups (DA10: auth only via --profile auth).
  if (list.includes("full")) return tools.filter((t) => !OPT_IN_GROUPS.includes(t.group) || t.profiles.some((p) => want.has(p)));
  return tools.filter((t) => t.profiles.some((p) => want.has(p)));
}

/** Site level a call needs (per action for merged tools). */
export function levelFor(tool: ToolDef, params: Record<string, unknown> = {}): ToolLevel {
  if (tool.actions) {
    const a = tool.actions[String(params.action)];
    if (a) return a.level;
  }
  if (tool.levelWhen && tool.levelWhen.values.includes(String(params[tool.levelWhen.param]))) return tool.levelWhen.level;
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
  return ["nav.goto", "nav.back", "nav.forward", "nav.reload", "nav.wait", "downloads.wait"].includes(toolName) ? TIMEOUTS.navigation : TIMEOUTS.action;
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
