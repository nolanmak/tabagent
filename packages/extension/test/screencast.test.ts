// #164: the screencast manager (background). Chrome-free: CDP, tab ownership and URLs are injected.
import { beforeEach, describe, expect, it } from "vitest";
import { createScreencasts, liveDeniedReason, SCREENCAST_PARAMS, type LiveMsg, type ScreencastDeps } from "../src/background/screencast";

const SID = "mcp:local:a";

interface World {
  owner: Map<number, string>;
  urls: Map<number, string>;
  lite: Set<number>;
  sent: { tabId: number; method: string; params: Record<string, unknown> }[];
  attached: number[];
  attachFails?: string;
}

function setup(w: Partial<World> = {}) {
  const world: World = { owner: new Map([[1, SID], [2, SID], [9, "mcp:local:other"]]), urls: new Map([[1, "https://example.com/"], [2, "https://example.org/"], [9, "https://x.example/"]]), lite: new Set(), sent: [], attached: [], ...w };
  const deps: ScreencastDeps = {
    ownerOf: (t) => world.owner.get(t),
    url: async (t) => world.urls.get(t) ?? "",
    currentUrl: (t) => world.urls.get(t),
    lite: async (t) => world.lite.has(t),
    attach: async (t) => {
      if (world.attachFails) throw new Error(world.attachFails);
      world.attached.push(t);
    },
    send: async (tabId, method, params = {}) => {
      world.sent.push({ tabId, method, params });
      return {};
    },
  };
  return { world, mgr: createScreencasts(deps) };
}

function viewer() {
  const got: LiveMsg[] = [];
  return { got, post: (m: LiveMsg) => void got.push(m), frames: () => got.filter((m) => m.type === "live.frame"), states: () => got.filter((m) => m.type === "live.state").map((m) => (m as { state: string }).state) };
}

const methods = (w: World, m: string) => w.sent.filter((s) => s.method === m);
const frame = (n: number) => ({ data: `AAA${n}`, sessionId: n, metadata: { timestamp: n } });

describe("liveDeniedReason", () => {
  it("vault, hard-denied and non-web pages are refused; ordinary pages and about:blank are fine", () => {
    expect(liveDeniedReason("https://passwords.google.com/")).toBeTruthy();
    expect(liveDeniedReason("https://my.1password.com/vaults")).toBeTruthy();
    expect(liveDeniedReason("chrome://settings")).toBeTruthy();
    expect(liveDeniedReason("chrome-extension://abc/chat.html")).toBeTruthy();
    expect(liveDeniedReason("https://chrome.google.com/webstore/detail/x")).toBeTruthy();
    expect(liveDeniedReason("https://example.com/")).toBeNull();
    expect(liveDeniedReason("about:blank")).toBeNull();
  });
});

describe("screencast manager", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("starts CDP Page.startScreencast on an owned tab with the agreed params", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    expect(s.world.attached).toEqual([1]);
    expect(methods(s.world, "Page.startScreencast")).toEqual([{ tabId: 1, method: "Page.startScreencast", params: SCREENCAST_PARAMS }]);
    expect(SCREENCAST_PARAMS).toEqual({ format: "jpeg", quality: 60, maxWidth: 900, maxHeight: 900, everyNthFrame: 1 });
    expect(v.states()).toEqual(["starting"]);
  });

  it("acks every frame and forwards it to the viewer; first frame makes it live", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    await s.mgr.onFrame(1, frame(1));
    await s.mgr.onFrame(1, frame(2));
    expect(methods(s.world, "Page.screencastFrameAck").map((x) => x.params)).toEqual([{ sessionId: 1 }, { sessionId: 2 }]);
    expect(v.frames()).toEqual([
      { type: "live.frame", tabId: 1, data: "AAA1" },
      { type: "live.frame", tabId: 1, data: "AAA2" },
    ]);
    expect(v.states()).toEqual(["starting", "live"]);
  });

  it("refuses a tab the session does not own, or another session's tab", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 9);
    await s.mgr.watch(v, SID, 404);
    expect(methods(s.world, "Page.startScreencast")).toEqual([]);
    expect(s.world.attached).toEqual([]);
    expect(v.got.map((m) => m.type === "live.state" && m.state)).toEqual(["unavailable", "unavailable"]);
  });

  it("refuses vault and hard-denied pages, and Lite-mode tabs (no debugger)", async () => {
    s.world.urls.set(1, "https://passwords.google.com/");
    s.world.lite.add(2);
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    await s.mgr.watch(v, SID, 2);
    expect(methods(s.world, "Page.startScreencast")).toEqual([]);
    expect(v.states()).toEqual(["starting", "unavailable", "starting", "unavailable"]);
  });

  it("an attach failure (the user cancelled debugging) is unavailable, not a crash", async () => {
    s.world.attachFails = "The user cancelled debugging";
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    expect(v.states()).toEqual(["starting", "unavailable"]);
    expect(s.mgr.casts()).toEqual([]);
  });

  it("one screencast per tab, shared across viewers; it stops when the last viewer leaves (port disconnect)", async () => {
    const a = viewer();
    const b = viewer();
    await s.mgr.watch(a, SID, 1);
    await s.mgr.watch(b, SID, 1);
    expect(methods(s.world, "Page.startScreencast")).toHaveLength(1);
    await s.mgr.onFrame(1, frame(1));
    expect(a.frames()).toHaveLength(1);
    expect(b.frames()).toHaveLength(1);
    // A late joiner is told it is already live.
    expect(b.states()).toContain("live");
    await s.mgr.unwatch(a);
    expect(methods(s.world, "Page.stopScreencast")).toHaveLength(0);
    await s.mgr.unwatch(b);
    expect(methods(s.world, "Page.stopScreencast")).toHaveLength(1);
    expect(s.mgr.casts()).toEqual([]);
    // Frames after the stop are neither acked nor forwarded.
    await s.mgr.onFrame(1, frame(9));
    expect(methods(s.world, "Page.screencastFrameAck")).toHaveLength(1);
  });

  it("a viewer switching tabs leaves the old cast", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    await s.mgr.watch(v, SID, 2);
    expect(methods(s.world, "Page.stopScreencast").map((x) => x.tabId)).toEqual([1]);
    expect(s.mgr.casts().map((c) => c.tabId)).toEqual([2]);
  });

  it("tab closed: viewers hear ended, the cast is gone", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    s.mgr.onTabClosed(1);
    expect(v.states()).toEqual(["starting", "ended"]);
    expect(s.mgr.casts()).toEqual([]);
  });

  it("session end stops its casts only", async () => {
    const a = viewer();
    const b = viewer();
    s.world.owner.set(3, "mcp:local:other");
    s.world.urls.set(3, "https://y.example/");
    await s.mgr.watch(a, SID, 1);
    await s.mgr.watch(b, "mcp:local:other", 3);
    await s.mgr.onSessionEnded(SID);
    expect(a.states()).toEqual(["starting", "ended"]);
    expect(b.states()).toEqual(["starting"]);
    expect(s.mgr.casts().map((c) => c.tabId)).toEqual([3]);
  });

  it("the agent no longer owns the tab (released, private sign-in tab): the next frame stops it, unforwarded", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    s.world.owner.delete(1);
    await s.mgr.onFrame(1, frame(1));
    expect(v.frames()).toEqual([]);
    expect(v.states()).toEqual(["starting", "ended"]);
    expect(methods(s.world, "Page.stopScreencast")).toHaveLength(1);
    // recheck() catches it without waiting for a frame.
    const w = viewer();
    s.world.owner.set(2, SID);
    await s.mgr.watch(w, SID, 2);
    s.world.owner.set(2, "mcp:local:other");
    await s.mgr.recheck();
    expect(w.states()).toEqual(["starting", "ended"]);
  });

  it("navigating to a vault or hard-denied page stops the cast; that frame is never forwarded", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    await s.mgr.onFrame(1, frame(1));
    s.world.urls.set(1, "https://mail.google.com/mail/u/0/");
    await s.mgr.onFrame(1, frame(2));
    expect(v.frames().map((f) => (f as { data: string }).data)).toEqual(["AAA1"]);
    expect(v.states()).toEqual(["starting", "live", "unavailable"]);
    expect(methods(s.world, "Page.stopScreencast")).toHaveLength(1);
  });

  it("debugger detached: ended, no stop command needed", async () => {
    const v = viewer();
    await s.mgr.watch(v, SID, 1);
    s.mgr.onDetached(1, "canceled_by_user");
    expect(v.states()).toEqual(["starting", "unavailable"]);
    expect(s.mgr.casts()).toEqual([]);
  });

  it("a viewer that throws on post is dropped without breaking the others", async () => {
    const bad = { post: () => { throw new Error("port gone"); } };
    const good = viewer();
    await s.mgr.watch(bad, SID, 1);
    await s.mgr.watch(good, SID, 1);
    await s.mgr.onFrame(1, frame(1));
    expect(good.frames()).toHaveLength(1);
    expect(s.mgr.casts()[0].viewers).toBe(1);
  });

  it("frames never leave through anything but the viewers (no logging hooks exist)", () => {
    expect(Object.keys(s.mgr).sort()).toEqual(["casts", "onDetached", "onFrame", "onSessionEnded", "onTabClosed", "recheck", "unwatch", "watch"]);
  });
});
