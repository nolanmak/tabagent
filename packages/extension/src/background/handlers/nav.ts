// nav.goto / back / forward / reload (#3, D15). Until the Driver interface lands (#7) navigation
// goes through chrome.tabs: no debugger, no page access.
import { TabAgentError } from "@tabagent/protocol";
import { resolveTab, type Session } from "../sessions";
import type { SessionMeta, ToolDef } from "@tabagent/protocol";

export interface Ctx {
  s: Session;
  meta: SessionMeta;
  p: any;
  tool: ToolDef;
  tabId?: number;
  url?: string;
}

type Handler = (c: Ctx) => Promise<unknown>;

/** A navigation that does not start loading within this long was same-document (or nothing happened). */
const START_GRACE_MS = 1000;

async function tabInfo(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return { url: t.pendingUrl || t.url || "", title: t.title ?? "" };
}

/**
 * Run `start` and wait for the tab to finish loading. Resolves false on timeout.
 * The listener is registered before `start`, so a fast load is never missed.
 */
export function loadAfter(tabId: number, start: () => Promise<unknown>, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let loading = false;
    let done = false;
    const finish = (ok: boolean, err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(grace);
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (err) reject(err);
      else resolve(ok);
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabId) return;
      if (info.status === "loading") loading = true;
      else if (info.status === "complete" && loading) finish(true);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(false, new TabAgentError("NOT_FOUND", `Tab ${tabId} was closed`));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const grace = setTimeout(() => !loading && finish(true), Math.min(START_GRACE_MS, timeout));
    const timer = setTimeout(() => finish(false), timeout);
    start().catch((e) => finish(false, e));
  });
}

/** A tab that was just created is still committing about:blank; a navigation started now can be lost. */
async function settleBlank(tabId: number, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    const blank = /^about:blank/.test(t.pendingUrl || t.url || "about:blank");
    if (!blank || t.status === "complete") return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Navigate a session tab and wait for load (or not, with waitUntil=none). */
export async function navigate(tabId: number, url: string, waitUntil: string, timeout: number) {
  await settleBlank(tabId);
  const go = () => chrome.tabs.update(tabId, { url });
  const ok = waitUntil === "none" ? (await go(), true) : await loadAfter(tabId, go, timeout);
  const t = await tabInfo(tabId);
  return { url: t.url, ...(ok ? {} : { warning: "Timed out waiting for load" }) };
}

async function navResult(tabId: number, r: { url: string; warning?: string }, kind: string) {
  const { title } = await tabInfo(tabId);
  return { ...r, title, __side: { navigation: { url: r.url, title, kind } } };
}

/**
 * Back/forward run history.back()/forward() in the page. chrome.tabs.goBack skips entries the
 * browser marks as added without a user gesture, which is every entry an agent creates.
 */
async function step(tabId: number, dir: "back" | "forward") {
  let moved = false;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (d: string) => {
        const nav = (globalThis as any).navigation as { canGoBack?: boolean; canGoForward?: boolean } | undefined;
        if (nav && !(d === "back" ? nav.canGoBack : nav.canGoForward)) return false;
        if (d === "back") history.back();
        else history.forward();
        return true;
      },
      args: [dir],
    });
    moved = r?.result === true;
  } catch {
    moved = false;
  }
  if (!moved) throw new TabAgentError("BAD_REQUEST", `No ${dir} history entry`);
}

async function historyNav(c: Ctx, action: "back" | "forward" | "reload") {
  const tabId = c.tabId ?? (await resolveTab(c.s, c.p.tabId));
  const start = () => (action === "reload" ? chrome.tabs.reload(tabId) : step(tabId, action));
  const ok = await loadAfter(tabId, start, c.p.timeout ?? 30000);
  const { url } = await tabInfo(tabId);
  return navResult(tabId, { url, ...(ok ? {} : { warning: "Timed out waiting for load" }) }, action);
}

export const navHandlers: Record<string, Handler> = {
  async "nav.goto"(c) {
    const { url, waitUntil = "load", timeout = 30000 } = c.p;
    let target = String(url);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = "https://" + target;
    // The router authorized the target origin (D16) before we got here.
    const tabId = await resolveTab(c.s, c.p.tabId, true);
    const r = await navigate(tabId, target, waitUntil, timeout);
    return navResult(tabId, r, "navigate");
  },
  "nav.back": (c) => historyNav(c, "back"),
  "nav.forward": (c) => historyNav(c, "forward"),
  "nav.reload": (c) => historyNav(c, "reload"),
};
