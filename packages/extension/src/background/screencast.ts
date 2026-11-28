// #164: live view of an agent's tab for the chat page. CDP Page.startScreencast on a tab the agent's session
// owns; every frame is acked and handed to the chat pages watching that tab (over their runtime port), and
// to nothing else: frames never go to the bridge, storage, logs or the audit. One screencast per tab, shared
// by every viewer. Chrome-free: index.ts injects CDP, tab ownership and URLs.
import { isHardDenied, isVaultDenied } from "./policy";

/** Agreed in #164: small enough to stream over a port, sharp enough to read. */
export const SCREENCAST_PARAMS = { format: "jpeg", quality: 60, maxWidth: 900, maxHeight: 900, everyNthFrame: 1 } as const;

export type LiveStateWire = "starting" | "live" | "ended" | "unavailable";
export type LiveMsg = { type: "live.state"; tabId: number; state: LiveStateWire; reason?: string } | { type: "live.frame"; tabId: number; data: string };

export interface Viewer {
  post(m: LiveMsg): void;
}

export interface ScreencastDeps {
  /** The session that owns the tab (sessions.ts), if any. */
  ownerOf(tabId: number): string | undefined;
  /** The tab's URL now (chrome.tabs). */
  url(tabId: number): Promise<string>;
  /** The URL CDP last saw for the main frame; checked on every frame. */
  currentUrl(tabId: number): string | undefined;
  /** The tab runs in Lite mode (#21): no debugger, so nothing to cast. */
  lite(tabId: number): Promise<boolean>;
  /** Attach CDP (shared with the agent's own driver). Throws when it cannot. */
  attach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Why a page is never shown live, or null. Same lines as for agents: vault hosts and hard-denied pages. */
export function liveDeniedReason(url: string): string | null {
  if (isVaultDenied(url)) return "This page holds passwords or mail, so it is never shown live";
  if (isHardDenied(url)) return "Browser and extension pages are not shown live";
  return null;
}

interface Cast {
  tabId: number;
  sessionId: string;
  viewers: Set<Viewer>;
  live: boolean;
  /** Start finished (the screencast is running in Chrome). */
  started: boolean;
}

export function createScreencasts(deps: ScreencastDeps) {
  const casts = new Map<number, Cast>();
  const watching = new Map<Viewer, number>();

  const post = (c: Cast, m: LiveMsg) => {
    for (const v of [...c.viewers])
      try {
        v.post(m);
      } catch {
        // The page went away without a disconnect event: drop it.
        c.viewers.delete(v);
        watching.delete(v);
      }
  };

  const tell = (v: Viewer, m: LiveMsg) => {
    try {
      v.post(m);
    } catch {
      /* page gone */
    }
  };

  /** End a cast: tell its viewers why, and stop Chrome's screencast unless the debugger is already gone. */
  async function end(c: Cast, state: "ended" | "unavailable", reason?: string, stop = true) {
    if (casts.get(c.tabId) !== c) return;
    casts.delete(c.tabId);
    post(c, { type: "live.state", tabId: c.tabId, state, ...(reason ? { reason } : {}) });
    for (const v of c.viewers) if (watching.get(v) === c.tabId) watching.delete(v);
    c.viewers.clear();
    if (stop && c.started) await deps.send(c.tabId, "Page.stopScreencast").catch(() => {});
  }

  /** Leave whatever this viewer watches; the last viewer out stops the cast. */
  async function unwatch(v: Viewer) {
    const tabId = watching.get(v);
    watching.delete(v);
    if (tabId == null) return;
    const c = casts.get(tabId);
    if (!c) return;
    c.viewers.delete(v);
    if (c.viewers.size) return;
    casts.delete(tabId);
    if (c.started) await deps.send(tabId, "Page.stopScreencast").catch(() => {});
  }

  async function watch(v: Viewer, sessionId: string, tabId: number) {
    if (watching.get(v) === tabId && casts.get(tabId)?.sessionId === sessionId) return;
    await unwatch(v);
    const refuse = (reason: string) => tell(v, { type: "live.state", tabId, state: "unavailable", reason });
    // Only a tab this agent's session owns: never the user's other tabs, never another agent's.
    if (!sessionId || deps.ownerOf(tabId) !== sessionId) return refuse("This tab is not one the agent is using");
    const existing = casts.get(tabId);
    if (existing) {
      existing.viewers.add(v);
      watching.set(v, tabId);
      tell(v, { type: "live.state", tabId, state: existing.live ? "live" : "starting" });
      return;
    }
    const c: Cast = { tabId, sessionId, viewers: new Set([v]), live: false, started: false };
    casts.set(tabId, c);
    watching.set(v, tabId);
    post(c, { type: "live.state", tabId, state: "starting" });
    try {
      const url = await deps.url(tabId);
      const denied = liveDeniedReason(url);
      if (denied) return void (await end(c, "unavailable", denied));
      if (await deps.lite(tabId)) return void (await end(c, "unavailable", "This site runs in Lite mode (no debugger), so it can't be shown live"));
      await deps.attach(tabId);
      if (casts.get(tabId) !== c) return;
      await deps.send(tabId, "Page.startScreencast", { ...SCREENCAST_PARAMS });
      c.started = true;
      // Everyone left while it was starting.
      if (casts.get(tabId) !== c) await deps.send(tabId, "Page.stopScreencast").catch(() => {});
    } catch {
      await end(c, "unavailable", "Live view isn't available for this tab right now", false);
    }
  }

  /** CDP Page.screencastFrame. Checked before anything is forwarded: still owned, still an allowed page. */
  async function onFrame(tabId: number, p: { data?: unknown; sessionId?: unknown }) {
    const c = casts.get(tabId);
    if (!c) return;
    if (deps.ownerOf(tabId) !== c.sessionId) return end(c, "ended", "The agent no longer uses this tab");
    const denied = liveDeniedReason(deps.currentUrl(tabId) ?? "");
    if (denied) return end(c, "unavailable", denied);
    if (typeof p.sessionId === "number") await deps.send(tabId, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    if (typeof p.data !== "string" || casts.get(tabId) !== c) return;
    if (!c.live) {
      c.live = true;
      post(c, { type: "live.state", tabId, state: "live" });
    }
    post(c, { type: "live.frame", tabId, data: p.data });
    if (!c.viewers.size) await unwatchAllOf(c);
  }

  async function unwatchAllOf(c: Cast) {
    if (casts.get(c.tabId) !== c) return;
    casts.delete(c.tabId);
    if (c.started) await deps.send(c.tabId, "Page.stopScreencast").catch(() => {});
  }

  function onTabClosed(tabId: number) {
    const c = casts.get(tabId);
    if (c) void end(c, "ended", "Tab closed", false);
  }

  /** chrome.debugger detached (TabAgent let go of the tab, or the user cancelled the debugging bar). */
  function onDetached(tabId: number, reason: string) {
    const c = casts.get(tabId);
    if (!c) return;
    if (reason === "canceled_by_user") void end(c, "unavailable", "Debugging was cancelled on this tab", false);
    else void end(c, "ended", undefined, false);
  }

  async function onSessionEnded(sessionId: string) {
    for (const c of [...casts.values()]) if (c.sessionId === sessionId) await end(c, "ended", "The agent's session ended");
  }

  /** Sessions changed: stop every cast whose tab its session no longer owns. */
  async function recheck() {
    for (const c of [...casts.values()]) if (deps.ownerOf(c.tabId) !== c.sessionId) await end(c, "ended", "The agent no longer uses this tab");
  }

  return {
    watch,
    unwatch,
    onFrame,
    onTabClosed,
    onDetached,
    onSessionEnded,
    recheck,
    casts: () => [...casts.values()].map((c) => ({ tabId: c.tabId, sessionId: c.sessionId, viewers: c.viewers.size, live: c.live })),
  };
}
