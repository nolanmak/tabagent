// Shared plumbing for tab-scoped tool handlers: tab resolution + per-tab lock,
// DIALOG_OPEN (D28), lite UNSUPPORTED (#21), and the post-action report that
// becomes the D14 side-effect fields via `__side` (contract §3, D24).
import { levelFor, type Level, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { peekCdpTab } from "./cdp";
import { driverFor, type DialogInfo, type Driver } from "./driver";
import { downloadsSince, noteAction } from "./downloads";
import { taErr } from "./errors";
import { requireSensitive, requireSite } from "./permissions";
import { baselines } from "./refstore";
import { resolveTab, type Session } from "./sessions";

export interface Ctx {
  s: Session;
  meta: SessionMeta;
  p: any;
  tool: ToolDef;
}

export interface TabCtx {
  tabId: number;
  url: string;
  drv: Driver;
}

export interface Side {
  snapshotDiff?: string;
  navigation?: { url: string; title: string; kind: string };
  dialogs?: DialogInfo[];
  downloads?: { id: number; filename: string; state: string }[];
}

export async function tabUrl(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return t.pendingUrl || t.url || "";
}

export async function titleOf(tabId: number) {
  return (await chrome.tabs.get(tabId)).title ?? "";
}

const locks = new Map<number, Promise<unknown>>();
/** Serialise commands per tab, in arrival order (D9). */
export async function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(tabId, chain);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(tabId) === chain) locks.delete(tabId);
  }
}

export function summaryFor(c: Ctx): string {
  const p = c.p ?? {};
  switch (c.tool.name) {
    case "nav.goto":
      return `open ${p.url}`;
    case "act.click":
      return `click ${p.ref}`;
    case "act.type":
      return `type into ${p.ref ?? "focused element"}`;
    case "form.fill":
      return `fill ${Object.keys(p.fields ?? {}).join(", ")}`;
    default:
      return c.tool.name;
  }
}

/** Level the site policy must allow for this call (registry, D16). */
export function levelOf(c: Ctx, fallback: Level): Level {
  try {
    const l = levelFor(c.tool, c.p ?? {}) as string;
    return l === "none" ? fallback : (l as Level);
  } catch {
    return fallback;
  }
}

/** D28: while a dialog is open, everything on the tab except dialog.handle gets DIALOG_OPEN. */
export function assertNoDialog(tabId: number, tool: string) {
  if (tool === "dialog.handle") return;
  const d = peekCdpTab(tabId)?.dialog;
  if (d) throw taErr("DIALOG_OPEN", `A ${d.type} dialog is open on this tab: "${String(d.message).slice(0, 200)}"`, "Call dialog.handle with accept=true|false first.", { pageText: true });
}

/** #21: tools the lite driver can't do return UNSUPPORTED without touching the page. */
export function assertLiteSupport(drv: Driver, tool: ToolDef) {
  const lite = (tool as unknown as { lite?: string }).lite;
  if (drv.kind === "lite" && lite === "unsupported") {
    throw taErr("UNSUPPORTED", `${tool.name} is not available in lite mode`, "Lite mode avoids chrome.debugger. Turn lite mode off for this site in the TabAgent side panel.");
  }
}

export async function onTab<T>(c: Ctx, level: Level | null, fn: (t: TabCtx) => Promise<T>, opts: { create?: boolean; lock?: boolean } = {}): Promise<T> {
  const tabId = await resolveTab(c.s, c.p.tabId, opts.create);
  const run = async () => {
    assertNoDialog(tabId, c.tool.name);
    const url = await tabUrl(tabId);
    if (level) await requireSite(c.meta, url, level, c.tool.name, summaryFor(c));
    const drv = await driverFor(tabId, url);
    assertLiteSupport(drv, c.tool);
    return fn({ tabId, url, drv });
  };
  // Waiting tools must not hold the tab lock, or the action they wait on could never run.
  return opts.lock === false ? run() : withTabLock(tabId, run);
}

/** D18 dynamic gate; adapts to both permission-engine signatures. */
export async function sensitiveGate(c: Ctx, url: string, category: "a" | "b" | "c" | "d" | "e" | "f", summary: string, reasons: string[]) {
  const rs = requireSensitive as unknown as (...a: unknown[]) => Promise<void>;
  if (rs.length >= 6) return rs(c.meta, url, category, c.tool.name, summary, reasons);
  return rs(c.meta, url, c.tool.name, summary, reasons);
}

function stripHash(u: string) {
  return u.split("#")[0];
}

/** Snapshot the tab and diff it against this session's baseline (advancing it). */
export async function diffSince(c: Ctx, t: TabCtx): Promise<string | undefined> {
  if (!baselines.get(c.meta.id, t.tabId)) return undefined;
  await t.drv.quiet();
  const r = await t.drv.snapshot({});
  const d = baselines.deliver(c.meta.id, t.tabId, r.lines, { maxChars: 6000 * 4 });
  return d && (d.added || d.removed || d.changed) ? d.text : undefined;
}

/** Shared post-action report (D14/D24/D28): dialogs, navigation, downloads, snapshot diff. */
export async function afterAction(c: Ctx, t: TabCtx, beforeEpoch: number, started: number, early: { dialog?: DialogInfo } = {}, extra: Record<string, unknown> = {}) {
  const side: Side = {};
  const out: Record<string, unknown> = { ok: true, ...extra };
  const dlg = early.dialog ?? t.drv.dialog();
  if (dlg) {
    // D28: return at once, no diff.
    side.dialogs = [dlg];
    return { ...out, __side: side };
  }
  await t.drv.settle(beforeEpoch);
  const d2 = t.drv.dialog();
  if (d2) {
    side.dialogs = [d2];
    return { ...out, __side: side };
  }
  const url = await t.drv.currentUrl();
  const crossDoc = t.drv.navEpoch() !== beforeEpoch;
  if (crossDoc || stripHash(url) !== stripHash(t.url)) {
    baselines.clearTab(t.tabId);
    side.navigation = { url, title: await titleOf(t.tabId), kind: crossDoc ? "navigate" : "same-document" };
  } else {
    try {
      const diff = await diffSince(c, t);
      if (diff) side.snapshotDiff = diff;
    } catch {
      /* page busy */
    }
  }
  const dls = downloadsSince(c.meta.id, started);
  if (dls.length) side.downloads = dls.map((d) => ({ id: d.id, filename: d.filename, state: d.state }));
  return Object.keys(side).length ? { ...out, __side: side } : out;
}

export async function act<T>(c: Ctx, level: Level, fn: (t: TabCtx) => Promise<{ dialog?: DialogInfo } | void | T>, extra?: (r: any) => Record<string, unknown>) {
  noteAction(c.meta.id);
  return onTab(c, level, async (t) => {
    const before = t.drv.navEpoch();
    const started = Date.now();
    const r = (await fn(t)) as any;
    return afterAction(c, t, before, started, r && typeof r === "object" && "dialog" in r ? r : {}, extra ? extra(r) : {});
  });
}
