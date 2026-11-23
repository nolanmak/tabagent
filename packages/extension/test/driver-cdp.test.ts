// CDP driver over a fake CDP tab: input sequences, staleness, DEBUGGER_DETACHED,
// dialogs, screenshot planning, denied frames, find.
import { describe, expect, it, vi } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import type { Observation } from "../src/background/autowait";
import { memoryStore, RefTable } from "../src/background/refs";
import { loadAx } from "./helpers";

const denied = new Set<string>();
vi.mock("../src/background/permissions", () => ({
  effectivePolicy: async (url: string) => ({ origin: new URL(url).origin, policy: denied.has(new URL(url).origin) ? "deny" : "full" }),
  requireSite: async () => {},
  requireSensitive: async () => {},
}));
vi.mock("../src/background/settings", () => ({ getSettings: async () => ({ showOverlay: false }), liteForUrl: async () => false }));
vi.mock("../src/background/refstore", async () => {
  const { Baselines } = await import("../src/background/diff");
  const { RefTable, memoryStore } = await import("../src/background/refs");
  return { refTable: new RefTable(memoryStore()), baselines: new Baselines(), forgetTab: () => {} };
});
vi.mock("../src/background/cdp", () => ({ getCdpTab: () => null, peekCdpTab: () => null, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) }));

const { CdpDriver, addMaskHook, mapEls, refSource } = await import("../src/background/driver");

const OK: Observation = { attached: true, visible: true, enabled: true, editable: true, box: { x: 10, y: 10, w: 100, h: 20 }, box2: { x: 10, y: 10, w: 100, h: 20 }, inView: true, point: { x: 60, y: 20 }, hit: { ok: true } };

function fake(page = "index", extraFrames: any[] = []) {
  const fx = loadAx(page);
  const calls: { m: string; p: any; sid?: string }[] = [];
  const detach = new Set<(r: string) => void>();
  const st = { obs: { ...OK } as Observation, dialog: null as any, waitDialog: false, onInput: undefined as undefined | ((m: string) => void) };
  const tab: any = {
    tabId: 1,
    attached: true,
    userDetached: false,
    get dialog() {
      return st.dialog;
    },
    loaders: new Map([["|main", "L1"]]),
    lifecycle: [],
    navEpoch: 0,
    mainFrameId: "main",
    url: "http://x/",
    dragData: null,
    onNavigated: () => () => {},
    onDetached: (f: (r: string) => void) => (detach.add(f), () => detach.delete(f)),
    ensure: async () => {
      if (tab.userDetached) throw tab.detachedError();
    },
    assertNoDialog: () => {
      if (st.dialog) throw new TabAgentError("DIALOG_OPEN", "dialog", undefined, { pageText: true });
    },
    detachedError: () => new TabAgentError("DEBUGGER_DETACHED", "The user cancelled debugging"),
    guard<T>(p: Promise<T>) {
      if (tab.userDetached) return Promise.reject(tab.detachedError());
      let off = () => {};
      const d = new Promise<never>((_r, rej) => {
        const f = (r: string) => r === "canceled_by_user" && rej(tab.detachedError());
        detach.add(f);
        off = () => detach.delete(f);
      });
      return Promise.race([p, d]).finally(off);
    },
    cancelByUser() {
      tab.userDetached = true;
      for (const f of [...detach]) f("canceled_by_user");
    },
    mainKey: () => "|main",
    frames: async () => [{ key: "|main", frameId: "main", url: "http://x/", loaderId: "L1" }, ...extraFrames],
    waitEvent: (pred: (m: string) => boolean) =>
      new Promise((res) => {
        if (st.waitDialog && pred("Page.javascriptDialogOpening")) setTimeout(() => res({ method: "Page.javascriptDialogOpening" }), 5);
      }),
    networkIdle: async () => true,
    evalMain: async () => ({ scrollX: 0, scrollY: 0 }),
    send: async (m: string, p: any = {}, sid?: string) => {
      calls.push({ m, p, sid });
      if (m.startsWith("Input.")) st.onInput?.(m);
      if (m === "Accessibility.getFullAXTree") return { nodes: sid === "S1" ? extraFrames[0]?.nodes ?? [] : fx.nodes };
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 100 }, cssContentSize: { width: 1200, height: 20000 } };
      if (m === "Page.captureScreenshot") return { data: "AAAA" };
      return {};
    },
    pagelib: async (fk: string, name: string, args: unknown[], self?: number, extra: number[] = []) => {
      calls.push({ m: `pagelib:${name}`, p: { fk, args, self, extra } });
      if (name === "sensitiveInputs") return { value: [], nodes: [] };
      if (name === "observe") return { value: st.obs, nodes: [] };
      if (name === "rectOf") return { value: { x: 20, y: 30, w: 80, h: 20 }, nodes: [] };
      if (name === "rectsOf") return { value: extra.map(() => ({ x: 5, y: 5, w: 10, h: 10 })), nodes: [] };
      if (name === "ownerMetrics") return { value: { rect: { left: 100, top: 200 }, clientLeft: 2, clientTop: 2, paddingLeft: 0, paddingTop: 0 }, nodes: [] };
      if (name === "findNodes") return { value: { total: 1, matches: [{ el: 0, role: "button", name: "Click me" }] }, nodes: [fx.nodes.find((n) => n.name?.value === "Click me")!.backendDOMNodeId] };
      return { value: true, nodes: [] };
    },
  };
  const clock = { t: 0, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
  const drv = new CdpDriver(tab, new RefTable(memoryStore()), clock);
  const input = () => calls.filter((c) => c.m.startsWith("Input."));
  return { drv, tab, calls, st, input };
}

async function refOf(drv: any, re: RegExp) {
  const s = await drv.snapshot({});
  return s.text.split("\n").find((l: string) => re.test(l))!.match(/ref=(e\d+)/)![1];
}

describe("CdpDriver actions (#7)", () => {
  it("click = move, down, up at the centre of the box", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    await f.drv.click(ref);
    expect(f.input().map((c) => [c.p.type, c.p.x, c.p.y])).toEqual([
      ["mouseMoved", 60, 20],
      ["mousePressed", 60, 20],
      ["mouseReleased", 60, 20],
    ]);
  });

  it("dblclick sends two press/release pairs with clickCount 1 and 2", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    await f.drv.click(ref, { clickCount: 2 });
    expect(f.input().map((c) => `${c.p.type}:${c.p.clickCount ?? ""}`)).toEqual(["mouseMoved:", "mousePressed:1", "mouseReleased:1", "mousePressed:2", "mouseReleased:2"]);
  });

  it("type uses Input.insertText (newline = Enter); press sends key down/up with modifiers", async () => {
    const f = fake();
    await f.drv.typeText("ab\ncd");
    expect(f.input().map((c) => (c.m === "Input.insertText" ? `insert:${c.p.text}` : `${c.p.type}:${c.p.key}`))).toEqual(["insert:ab", "keyDown:Enter", "keyUp:Enter", "insert:cd"]);
    expect(f.calls.some((c) => c.m === "Emulation.setFocusEmulationEnabled")).toBe(true);
    f.calls.length = 0;
    await f.drv.press("Control+a");
    expect(f.input().map((c) => `${c.p.type}:${c.p.key}:${c.p.modifiers}`)).toEqual(["rawKeyDown:Control:2", "rawKeyDown:a:2", "keyUp:a:2", "keyUp:Control:0"]);
    await expect(f.drv.press("Hyper+q")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("fill waits for an editable target, then sets through the page's native setter", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /searchbox "Search"/);
    await f.drv.fill(ref, "hi");
    expect(f.calls.filter((c) => c.m.startsWith("pagelib:")).map((c) => c.m)).toContain("pagelib:setValue");
    f.st.obs = { ...OK, editable: false };
    await expect(f.drv.fill(ref, "x")).rejects.toMatchObject({ code: "NOT_ACTIONABLE" });
  });

  it("stale ref -> REF_STALE without touching the page", async () => {
    const f = fake();
    f.calls.length = 0;
    await expect(f.drv.click("e4242")).rejects.toMatchObject({ code: "REF_STALE" });
    expect(f.calls).toEqual([]);
    // document replaced: loaderId changed
    const ref = await refOf(f.drv, /Click me/);
    f.tab.loaders.set("|main", "L2");
    f.calls.length = 0;
    await expect(f.drv.click(ref)).rejects.toMatchObject({ code: "REF_STALE" });
    expect(f.calls.filter((c) => c.m.startsWith("Input.") || c.m.startsWith("pagelib:"))).toEqual([]);
  });

  it("auto-wait: covered element reports the coverer; hover moves only", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    f.st.obs = { ...OK, hit: { ok: false, by: '<div#overlay> "Cookies"' } };
    const e = await f.drv.click(ref, { timeout: 300 }).catch((x) => x);
    expect(e.code).toBe("NOT_ACTIONABLE");
    expect(e.pageText).toBe(true);
    f.st.obs = OK;
    f.calls.length = 0;
    await f.drv.hover(ref);
    expect(f.input().map((c) => c.p.type)).toEqual(["mouseMoved"]);
  });

  it("debugger cancelled mid-action -> DEBUGGER_DETACHED", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    // the user cancels the debugging bar while the element is still disabled
    f.st.obs = { ...OK, enabled: false };
    const orig = f.tab.pagelib;
    let n = 0;
    f.tab.pagelib = async (...a: any[]) => {
      if (a[1] === "observe" && ++n === 3) f.tab.cancelByUser();
      return orig(...a);
    };
    const p = f.drv.click(ref, { timeout: 5000 });
    await expect(p).rejects.toMatchObject({ code: "DEBUGGER_DETACHED" });
    // and the tab stays stopped
    await expect(f.drv.snapshot({})).rejects.toMatchObject({ code: "DEBUGGER_DETACHED" });
  });

  it("an action that opens a dialog returns at once with the dialog (D28)", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    f.st.waitDialog = true;
    f.st.onInput = (m) => {
      if (m === "Input.dispatchMouseEvent") f.st.dialog = { type: "confirm", message: "Sure?" };
    };
    const r = await f.drv.click(ref);
    expect(r.dialog).toEqual({ type: "confirm", message: "Sure?" });
    await expect(f.drv.snapshot({})).rejects.toMatchObject({ code: "DIALOG_OPEN" });
  });
});

describe("CdpDriver screenshot (#8)", () => {
  it("target=ref clips to the element's box in page coordinates", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    const s = await f.drv.screenshot({ target: "ref", ref });
    const cap = f.calls.find((c) => c.m === "Page.captureScreenshot")!;
    expect(cap.p.clip).toEqual({ x: 20, y: 130, width: 80, height: 20, scale: 1 });
    expect(s).toEqual({ mime: "image/png", dataBase64: "AAAA", width: 80, height: 20 });
    // overlay hidden during capture, then restored (D40)
    const hides = f.calls.filter((c) => c.m === "pagelib:hideOverlay").map((c) => c.p.args[0]);
    expect(hides).toEqual([true, false]);
  });

  it("full page is capped at 16000px with a note; jpeg quality", async () => {
    const f = fake();
    const s = await f.drv.screenshot({ target: "full", format: "jpeg", quality: 55 });
    const cap = f.calls.find((c) => c.m === "Page.captureScreenshot")!;
    expect(cap.p.clip.height).toBe(16000);
    expect(cap.p.quality).toBe(55);
    expect(s.mime).toBe("image/jpeg");
    expect(s.note).toContain("capped at 16000px");
  });

  it("stale ref -> REF_STALE; marks label interactive refs from the table", async () => {
    const f = fake();
    await expect(f.drv.screenshot({ target: "ref", ref: "e999" })).rejects.toMatchObject({ code: "REF_STALE" });
    const snap = await f.drv.snapshot({});
    await f.drv.screenshot({ marks: true });
    const draw = f.calls.find((c) => c.m === "pagelib:drawMarks")!;
    const labels = (draw.p.args[0] as { label: string }[]).map((m) => m.label);
    expect(labels).toEqual(snap.refs);
    expect(f.calls.some((c) => c.m === "pagelib:clearOverlay")).toBe(true);
  });
});

describe("CdpDriver frames (#19) and find (#26)", () => {
  it("child frame clicks are translated by the owner iframe's offset; denied frames are placeholders", async () => {
    const child = loadAx("index");
    const ownerId = 777;
    const main = loadAx("index").nodes;
    const iframeNode = { nodeId: "if1", role: { value: "Iframe" }, name: { value: "Child" }, backendDOMNodeId: ownerId, parentId: main[0].nodeId };
    main[0].childIds = [...(main[0].childIds ?? []), "if1"];
    const f = fake("index", [{ key: "S1|child", sessionId: "S1", frameId: "child", parentKey: "|main", url: "http://child.test/", ownerBackendNodeId: ownerId, loaderId: "C1", nodes: child.nodes }]);
    f.tab.loaders.set("S1|child", "C1");
    // feed the AX tree with the iframe node
    const origSend = f.tab.send;
    f.tab.send = async (m: string, p: any, sid?: string) => (m === "Accessibility.getFullAXTree" && !sid ? { nodes: [...main, iframeNode] } : origSend(m, p, sid));
    const s = await f.drv.snapshot({});
    const refs = s.text.split("\n").filter((l) => /button "Click me"/.test(l)).map((l) => l.match(/ref=(e\d+)/)![1]);
    expect(refs).toHaveLength(2);
    f.calls.length = 0;
    await f.drv.click(refs[1]);
    const press = f.input().find((c) => c.p.type === "mousePressed")!;
    expect([press.p.x, press.p.y]).toEqual([100 + 2 + 60, 200 + 2 + 20]);

    denied.add("http://child.test");
    const s2 = await f.drv.snapshot({});
    expect(s2.text).toContain('- iframe "Child" (content hidden: http://child.test is denied by site policy)');
    expect(s2.shown.some((x) => x.frameKey === "S1|child")).toBe(false);
    const all = await f.drv.callAllFrames("findNodes", [{}]);
    expect(all.map((x) => x.frameKey)).toEqual(["|main"]);
    denied.clear();
  });

  it("find mints refs from the shared table (same ref as the snapshot)", async () => {
    const f = fake();
    const ref = await refOf(f.drv, /Click me/);
    const r = await f.drv.find({ by: "role", value: "button", name: "Click me" });
    expect(r).toEqual({ matches: [{ ref, role: "button", name: "Click me" }], truncated: false });
  });

  it("mask hooks mask extra nodes", async () => {
    const f = fake("index");
    const search = loadAx("index").nodes.find((n) => n.name?.value === "Search")!;
    search.value = { value: "secret" };
    const origSend = f.tab.send;
    f.tab.send = async (m: string, p: any, sid?: string) => (m === "Accessibility.getFullAXTree" ? { nodes: loadAx("index").nodes.map((n) => (n.nodeId === search.nodeId ? search : n)) } : origSend(m, p, sid));
    const off = addMaskHook((_t, id) => id === search.backendDOMNodeId);
    const s = await f.drv.snapshot({});
    expect(s.text).toMatch(/searchbox "Search" \[ref=e\d+\] value="••••"/);
    off();
    expect((await f.drv.snapshot({})).text).toContain('value="secret"');
  });

  it("mapEls and refSource helpers", () => {
    expect(mapEls({ a: [{ el: 0 }, { submit: 1 }], b: 2 }, ["e1", "e2"])).toEqual({ a: [{ ref: "e1" }, { submitRef: "e2" }], b: 2 });
    const t = new RefTable(memoryStore());
    const src = refSource(t, 3, () => "L");
    const r = src.mint("|m", 5);
    expect(src.peek("|m", 5)).toBe(r);
    expect(src.nextNumber()).toBe(2);
  });
});
