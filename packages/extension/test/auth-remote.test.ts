// #61 Part B: the extension's input-only channel for a remotely handed-off tab.
import { describe, expect, it } from "vitest";
import { createRemoteHandoffs, inputToCdp, REMOTE_CDP_METHODS, type RemoteDeps } from "../src/background/auth/pure/remote";

const VP = { w: 400, h: 800 };

function fake(opts: { vp?: { w: number; h: number } } = {}) {
  const sent: any[] = [];
  const cdp: { tabId: number; method: string; params: any }[] = [];
  const attached = new Set<number>();
  const ended: { tabId: number; result: string }[] = [];
  let timer: (() => void) | null = null;
  let n = 0;
  const deps: RemoteDeps = {
    send: (m) => (sent.push(m), true),
    async attach(tabId) {
      attached.add(tabId);
    },
    async detach(tabId) {
      attached.delete(tabId);
    },
    async cdp(tabId, method, params) {
      cdp.push({ tabId, method, params });
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: (opts.vp ?? VP).w, clientHeight: (opts.vp ?? VP).h } };
      if (method === "Page.captureScreenshot") return { data: "SU1H" };
      return {};
    },
    end: (tabId, result) => (ended.push({ tabId, result }), true),
    newId: () => `r${++n}`,
    setTimeout: (fn) => ((timer = fn), 1),
    clearTimeout: () => (timer = null),
  };
  const r = createRemoteHandoffs(deps);
  const tick = () => new Promise((res) => setTimeout(res, 0));
  /** Open a handoff for `tabId` and have the bridge answer with handoffId `hid`. */
  async function open(tabId: number, hid: string | null, extra: Record<string, unknown> = {}) {
    const p = r.open("cmd-" + tabId, tabId, { origin: "https://id.example", reason: "Selfie", sessionLabel: "jarvis" });
    const req = sent.find((m) => m.type === "handoff.open" && m.commandId === "cmd-" + tabId);
    r.onMessage({ type: "handoff.opened", id: req.id, ok: true, handoffId: hid, url: hid ? `http://100.1.1.1:1/handoff/${hid}?t=x` : null, timeoutMs: 1_800_000, ...extra });
    return p;
  }
  return { r, deps, sent, cdp, attached, ended, tick, open, fireTimer: () => timer?.() };
}

describe("inputToCdp: coordinate scaling and the event set", () => {
  it("a tap at normalised (x, y) becomes move/press/release at viewport CSS pixels", () => {
    const ev = inputToCdp({ kind: "tap", x: 0.5, y: 0.25 }, VP);
    expect(ev.map((e) => [e.method, e.params.type])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
    for (const e of ev) expect([e.params.x, e.params.y]).toEqual([200, 200]);
    expect(ev[1].params).toMatchObject({ button: "left", clickCount: 1 });
  });

  it("scales to any phone/desktop ratio and clamps to the viewport", () => {
    expect(inputToCdp({ kind: "tap", x: 1, y: 1 }, { w: 1280, h: 720 })[0].params).toMatchObject({ x: 1279, y: 719 });
    expect(inputToCdp({ kind: "tap", x: 0, y: 0 }, { w: 1280, h: 720 })[0].params).toMatchObject({ x: 0, y: 0 });
    expect(inputToCdp({ kind: "tap", x: 0.1, y: 0.9 }, { w: 1000, h: 500 })[0].params).toMatchObject({ x: 100, y: 450 });
  });

  it("text is inserted; keys are key events (Enter carries \\r so forms submit)", () => {
    expect(inputToCdp({ kind: "text", text: "héllo" }, VP)).toEqual([{ method: "Input.insertText", params: { text: "héllo" } }]);
    const enter = inputToCdp({ kind: "key", key: "Enter" }, VP);
    expect(enter.map((e) => e.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(enter[0].params).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    const bs = inputToCdp({ kind: "key", key: "Backspace" }, VP);
    expect(bs.map((e) => e.params.type)).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("scroll is a wheel event at the scaled point", () => {
    expect(inputToCdp({ kind: "scroll", x: 0.5, y: 0.5, dy: 300 }, VP)).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 200, y: 400, deltaX: 0, deltaY: 300 } }]);
  });

  it("only ever uses the allow-listed CDP methods (no Runtime, no Page.navigate, no DOM)", () => {
    expect([...REMOTE_CDP_METHODS].sort()).toEqual(["Emulation.setFocusEmulationEnabled", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.insertText", "Page.captureScreenshot", "Page.getLayoutMetrics"]);
    const all = [inputToCdp({ kind: "tap", x: 0, y: 0 }, VP), inputToCdp({ kind: "text", text: "x" }, VP), inputToCdp({ kind: "key", key: "Tab" }, VP), inputToCdp({ kind: "scroll", x: 0, y: 0, dy: 1 }, VP)].flat();
    for (const e of all) expect(REMOTE_CDP_METHODS.has(e.method)).toBe(true);
  });
});

describe("remote handoffs: open", () => {
  it("asks the bridge and returns its link and timeout", async () => {
    const t = fake();
    const r = await t.open(7, "h7");
    expect(r).toEqual({ handoffId: "h7", url: "http://100.1.1.1:1/handoff/h7?t=x", timeoutMs: 1_800_000 });
    expect(t.sent[0]).toEqual({ type: "handoff.open", id: "r1", commandId: "cmd-7", origin: "https://id.example", reason: "Selfie", sessionLabel: "jarvis" });
    // the tab id never goes to the bridge
    expect(JSON.stringify(t.sent[0])).not.toContain("7,");
    expect("tabId" in t.sent[0]).toBe(false);
  });

  it("an older bridge that never answers → local defaults (null) after the wait", async () => {
    const t = fake();
    const p = t.r.open("c", 3, { origin: "https://a.b", reason: "r", sessionLabel: "s" });
    t.fireTimer();
    await expect(p).resolves.toEqual({ handoffId: null, url: null, timeoutMs: null });
  });

  it("a refusal from the bridge → local defaults", async () => {
    const t = fake();
    const p = t.r.open("c", 3, { origin: "https://a.b", reason: "r", sessionLabel: "s" });
    t.r.onMessage({ type: "handoff.opened", id: t.sent[0].id, ok: false, timeoutMs: 300_000, error: { code: "PERMISSION_DENIED", message: "no" } });
    await expect(p).resolves.toEqual({ handoffId: null, url: null, timeoutMs: 300_000 });
  });

  it("no bridge connection → local defaults at once", async () => {
    const t = fake();
    t.deps.send = () => false;
    const r2 = createRemoteHandoffs(t.deps);
    await expect(r2.open("c", 3, { origin: "https://a.b", reason: "r", sessionLabel: "s" })).resolves.toEqual({ handoffId: null, url: null, timeoutMs: null });
  });
});

describe("remote handoffs: input only to the one handed-off tab", () => {
  it("frame: attaches the input-only session lazily, wakes the tab, returns a JPEG", async () => {
    const t = fake();
    await t.open(7, "h7");
    expect(t.attached.size).toBe(0); // nothing is attached until the phone asks
    t.r.onMessage({ type: "handoff.frame", id: "f1", handoffId: "h7" });
    await t.tick();
    await t.tick();
    expect(t.attached.has(7)).toBe(true);
    expect(t.cdp.map((c) => c.method)).toEqual(["Emulation.setFocusEmulationEnabled", "Page.captureScreenshot"]);
    expect(t.cdp.every((c) => c.tabId === 7)).toBe(true);
    expect(t.sent.at(-1)).toEqual({ type: "handoff.frame.result", id: "f1", ok: true, mime: "image/jpeg", dataBase64: "SU1H" });
  });

  it("input goes to the handoff's own tab whatever the message says", async () => {
    const t = fake();
    await t.open(7, "h7");
    await t.open(8, "h8");
    t.r.onMessage({ type: "handoff.input", id: "i1", handoffId: "h8", tabId: 7, input: { kind: "tap", x: 0.5, y: 0.5 } });
    await new Promise((r) => setTimeout(r, 5));
    const used = new Set(t.cdp.map((c) => c.tabId));
    expect([...used]).toEqual([8]);
    expect(t.sent.at(-1)).toEqual({ type: "handoff.input.result", id: "i1", ok: true });
  });

  it("unknown handoff id → NOT_FOUND, nothing attached or sent", async () => {
    const t = fake();
    await t.open(7, "h7");
    t.r.onMessage({ type: "handoff.input", id: "i1", handoffId: "nope", input: { kind: "text", text: "x" } });
    t.r.onMessage({ type: "handoff.frame", id: "f1", handoffId: "nope" });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.cdp).toEqual([]);
    expect(t.attached.size).toBe(0);
    expect(t.sent.filter((m) => m.type !== "handoff.open").map((m) => [m.id, m.ok, m.error?.code])).toEqual([
      ["i1", false, "NOT_FOUND"],
      ["f1", false, "NOT_FOUND"],
    ]);
  });

  it("malformed input (eval, navigation, out-of-range) is refused before any CDP call", async () => {
    const t = fake();
    await t.open(7, "h7");
    for (const input of [{ kind: "eval", code: "1" }, { kind: "nav", url: "https://x" }, { kind: "tap", x: 5, y: 0 }, { kind: "key", key: "F12" }]) {
      t.r.onMessage({ type: "handoff.input", id: "bad", handoffId: "h7", input });
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(t.cdp).toEqual([]);
    expect(t.sent.filter((m) => m.id === "bad").every((m) => m.ok === false && m.error.code === "BAD_REQUEST")).toBe(true);
  });

  it("a local-only handoff (no handoffId) registers nothing remote", async () => {
    const t = fake();
    await t.open(7, null);
    expect(t.r.active()).toBe(0);
  });

  it("handoff.end from the bridge ends the handoff on that tab only", async () => {
    const t = fake();
    await t.open(7, "h7");
    await t.open(8, "h8");
    t.r.onMessage({ type: "handoff.end", handoffId: "h8", result: "done" });
    t.r.onMessage({ type: "handoff.end", handoffId: "zzz", result: "done" });
    t.r.onMessage({ type: "handoff.end", handoffId: "h7", result: "weird" });
    expect(t.ended).toEqual([
      { tabId: 8, result: "done" },
      { tabId: 7, result: "cancel" },
    ]);
  });

  it("close: detaches the input session, tells the bridge, and refuses later input", async () => {
    const t = fake();
    await t.open(7, "h7");
    t.r.onMessage({ type: "handoff.frame", id: "f1", handoffId: "h7" });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.attached.has(7)).toBe(true);
    await t.r.close("h7", "done");
    expect(t.attached.has(7)).toBe(false);
    expect(t.sent.at(-1)).toEqual({ type: "handoff.closed", handoffId: "h7", outcome: "done" });
    const before = t.cdp.length;
    t.r.onMessage({ type: "handoff.input", id: "i9", handoffId: "h7", input: { kind: "text", text: "x" } });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.cdp.length).toBe(before);
    expect(t.sent.at(-1)).toMatchObject({ id: "i9", ok: false, error: { code: "NOT_FOUND" } });
    expect(t.r.active()).toBe(0);
  });

  it("close without a frame ever requested does not attach or detach", async () => {
    const t = fake();
    let detaches = 0;
    t.deps.detach = async () => void detaches++;
    await t.open(7, "h7");
    await t.r.close("h7", "cancel");
    expect(detaches).toBe(0);
  });

  it("a CDP failure re-attaches on the next request", async () => {
    const t = fake();
    await t.open(7, "h7");
    let fail = true;
    const real = t.deps.cdp;
    t.deps.cdp = async (tabId, m, p) => {
      if (m === "Page.captureScreenshot" && fail) {
        fail = false;
        throw new Error("Debugger is not attached to the tab");
      }
      return real(tabId, m, p);
    };
    let attaches = 0;
    const ra = t.deps.attach;
    t.deps.attach = async (id) => (attaches++, ra(id));
    t.r.onMessage({ type: "handoff.frame", id: "f1", handoffId: "h7" });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent.at(-1)).toMatchObject({ id: "f1", ok: false });
    t.r.onMessage({ type: "handoff.frame", id: "f2", handoffId: "h7" });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent.at(-1)).toMatchObject({ id: "f2", ok: true });
    expect(attaches).toBe(2);
  });

  it("onMessage ignores other message types", () => {
    const t = fake();
    expect(t.r.onMessage({ type: "secret" })).toBe(false);
    expect(t.r.onMessage(null)).toBe(false);
    expect(t.r.onMessage({ type: "handoff.frame", id: "x", handoffId: "y" })).toBe(true);
  });
});
