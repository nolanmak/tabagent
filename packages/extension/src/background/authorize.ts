// What a command needs before its handler may run (D16, D17, D18). Pure.
import type { Level, SensitiveCategory } from "./policy";

/** Minimal view of a registry entry (contract §2). */
export interface ToolLike {
  name: string;
  level: Level | "none";
  sensitive?: SensitiveCategory | boolean;
  actions?: Record<string, { level: Level | "none"; sensitive?: SensitiveCategory }>;
  sensitiveWhen?: { param: string; values: string[] };
  levelWhen?: { param: string; values: string[]; level: Level };
}

/**
 * Static D18 categories. The registry `sensitive` field is the source of truth;
 * this map is the fallback while the registry still carries booleans.
 */
export const STATIC_SENSITIVE: Record<string, SensitiveCategory> = {
  "js.eval": "c",
  "nav.wait": "c", // only when for=fn
  "cookies.get": "d",
  "storage.get": "d",
  "network.get": "d",
  "act.upload": "e",
  "downloads.read": "e",
  "tabs.attach": "f",
};

const TABS_ACTIONS: Record<string, { level: Level | "none"; sensitive?: SensitiveCategory }> = {
  list: { level: "none" },
  new: { level: "act" },
  select: { level: "none" },
  close: { level: "none" },
  attach: { level: "read", sensitive: "f" },
};

const CATEGORIES = new Set(["a", "b", "c", "d", "e", "f", "g", "p", "r"]);

/** Where the URL being authorized comes from. */
export type UrlSource = "tab" | "param" | "tab-or-param" | "download" | "attach-target" | "none";

export interface Requirements {
  action?: string;
  level: Level | null;
  sensitive?: SensitiveCategory;
  urlSource: UrlSource;
  /** The router resolves a session tab before authorizing (NOT_FOUND / TAB_BUSY come from here). */
  needsTab: boolean;
  /** Resolve the tab only if the caller named one (nav.goto creates its own tab). */
  tabOptional?: boolean;
}

/** Tools that work without a session tab. */
const NO_TAB = new Set(["tabs", "downloads.list", "downloads.wait", "downloads.read", "session.info", "session.permissions", "session.end", "policy.denylist_change", "workflow.list", "workflow.unschedule", "workflow.runs", "workflow.review_repair"]);

export function requirementsFor(tool: ToolLike, params: Record<string, unknown>): Requirements {
  const levelOf = (l: Level | "none" | undefined) => (l && l !== "none" ? l : null);
  if (tool.name === "tabs") {
    const action = String(params.action ?? "");
    const a = tool.actions?.[action] ?? TABS_ACTIONS[action] ?? { level: "none" };
    const sensitive = normalizeCat(a.sensitive) ?? (action === "attach" ? "f" : undefined);
    if (action === "new") return { action, level: params.url ? levelOf(a.level) ?? "act" : null, urlSource: params.url ? "param" : "none", needsTab: false };
    if (action === "attach") return { action, level: levelOf(a.level) ?? "read", sensitive, urlSource: "attach-target", needsTab: false };
    return { action, level: null, urlSource: "none", needsTab: false };
  }
  // nav.wait for=fn is arbitrary JS: it needs js.eval's level (review H2), also via the fallback.
  const lw = tool.levelWhen ?? (tool.name === "nav.wait" ? { param: "for", values: ["fn"], level: "full" as Level } : undefined);
  const level = lw && lw.values.includes(String(params[lw.param])) ? lw.level : levelOf(tool.level);
  let sensitive: SensitiveCategory | undefined = normalizeCat(tool.sensitive) ?? STATIC_SENSITIVE[tool.name];
  const when = tool.sensitiveWhen ?? (tool.name === "nav.wait" ? { param: "for", values: ["fn"] } : undefined);
  if (sensitive && when && !when.values.includes(String(params[when.param]))) sensitive = undefined;
  // g (auth) needs the account, so the auth handler gates it with requireSensitive(..., "g", ..., {auth}).
  if (sensitive === "g") sensitive = undefined;
  if (tool.name === "nav.goto") return { level: level ?? "act", sensitive, urlSource: "param", needsTab: false, tabOptional: true };
  if (tool.name === "downloads.read") return { level: null, sensitive: sensitive ?? "e", urlSource: "download", needsTab: false };
  // Most no-tab tools are level none, but policy mutation / repair review are deliberately
  // full-capability commands and must still pass through the token-cap check.
  if (NO_TAB.has(tool.name)) return { level, sensitive, urlSource: "none", needsTab: false };
  if (tool.name === "cookies.get") return { level, sensitive, urlSource: "tab-or-param", needsTab: true };
  return { level, sensitive, urlSource: level || sensitive ? "tab" : "none", needsTab: true };
}

function normalizeCat(v: unknown): SensitiveCategory | undefined {
  return typeof v === "string" && CATEGORIES.has(v) ? (v as SensitiveCategory) : undefined;
}

/** nav.goto targets without a scheme get https:// (matches the handler). */
export function normalizeNavUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
}
