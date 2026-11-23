// Shared plumbing for tab-scoped tool handlers: tab resolution + per-tab lock,
// and the post-action report that becomes the D14 side-effect fields via
// `__side` (contract §3, D24).
import { levelFor, type Level, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { driverFor, type Driver } from "./driver";
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

export async function onTab<T>(c: Ctx, level: Level | null, fn: (t: TabCtx) => Promise<T>, opts: { create?: boolean; lock?: boolean } = {}): Promise<T> {
  const tabId = await resolveTab(c.s, c.p.tabId, opts.create);
  const run = async () => {
    const url = await tabUrl(tabId);
    if (level) await requireSite(c.meta, url, level, c.tool.name, summaryFor(c));
    const drv = await driverFor(tabId, url);
    return fn({ tabId, url, drv });
  };
  // Waiting tools must not hold the tab lock, or the action they wait on could never run.
  return opts.lock === false ? run() : withTabLock(tabId, run);
}

/** D18 dynamic gate (agent B's permission engine). */
export async function sensitiveGate(c: Ctx, url: string, category: "a" | "b" | "c" | "d" | "e" | "f", summary: string, reasons: string[]) {
  return requireSensitive(c.meta, url, category as never, c.tool.name, summary, reasons);
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

/** Shared post-action report (D14/D24): navigation or snapshot diff. */
export async function afterAction(c: Ctx, t: TabCtx, beforeEpoch: number, extra: Record<string, unknown> = {}) {
  const side: Side = {};
  const out: Record<string, unknown> = { ok: true, ...extra };
  await t.drv.settle(beforeEpoch);
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
  return Object.keys(side).length ? { ...out, __side: side } : out;
}

export async function act<T>(c: Ctx, level: Level, fn: (t: TabCtx) => Promise<void | T>, extra?: (r: any) => Record<string, unknown>) {
  return onTab(c, level, async (t) => {
    const before = t.drv.navEpoch();
    const r = (await fn(t)) as any;
    return afterAction(c, t, before, extra ? extra(r) : {});
  });
}
