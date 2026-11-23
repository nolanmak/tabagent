// Drivers: CdpDriver (chrome.debugger, trusted input, AX snapshot) and
// LiteDriver (content scripts only). Tool handlers talk to the Driver API.
import { hostMatches, TabAgentError } from "@tabagent/protocol";
import { CdpTab, getCdpTab, sleep, splitKey, type FrameInfo } from "./cdp";
import { editCommand, keyDef, MOD_BITS, parseChord } from "./keys";
import { diffLines, renderFrames, renderWithBudget, serialize, type AXNode, type FrameTree } from "./snapshot";
import { getSettings } from "./settings";

export interface SnapshotOpts {
  mode?: "interactive" | "full";
  root?: string;
  maxTokens?: number;
  diff?: boolean;
}

export interface ClickOpts {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: string[];
  timeout?: number;
}

export interface Driver {
  kind: "cdp" | "lite";
  tabId: number;
  hasSnapshot(): boolean;
  snapshot(o: SnapshotOpts): Promise<{ snapshot: string; refs: number; truncated: boolean; diff?: { text: string; added: number; removed: number } }>;
  diffSinceLast(): Promise<{ text: string; added: number; removed: number } | null>;
  call(fn: string, args: unknown[], o?: { ref?: string; frameKey?: string }): Promise<any>;
  callAllFrames(fn: string, args: unknown[]): Promise<any[]>;
  click(ref: string, o?: ClickOpts): Promise<{ dialog?: unknown }>;
  hover(ref: string, timeout?: number): Promise<void>;
  focus(ref: string, end?: boolean): Promise<void>;
  typeText(text: string): Promise<{ dialog?: unknown }>;
  press(chord: string): Promise<{ dialog?: unknown }>;
  fill(ref: string, value: string, timeout?: number): Promise<void>;
  scroll(ref: string | undefined, dx: number, dy: number): Promise<unknown>;
  drag(from: string, to: string, timeout?: number): Promise<void>;
  upload(ref: string, paths: string[]): Promise<void>;
  screenshot(o: { fullPage?: boolean; ref?: string; marks?: boolean; format?: "png" | "jpeg" }): Promise<{ data: string; mimeType: string; width?: number; height?: number }>;
  evaluate(expression: string, world: "main" | "isolated"): Promise<unknown>;
  navigate(url: string, waitUntil: string, timeout: number): Promise<{ url: string; warning?: string }>;
  history(action: "back" | "forward" | "reload", timeout: number): Promise<void>;
  waitLoad(timeout: number): Promise<boolean>;
  networkIdle(quiet: number, timeout: number): Promise<boolean>;
  settle(beforeEpoch: number, timeout?: number): Promise<void>;
  navEpoch(): number;
  currentUrl(): Promise<string>;
  dialog(): unknown;
  handleDialog(accept: boolean, promptText?: string): Promise<unknown>;
  resolveRef(ref: string): RefInfo;
  dispose(): void;
}

export interface RefInfo {
  frameKey: string;
  backendNodeId: number;
}

const drivers = new Map<number, { cdp?: CdpDriver; lite?: LiteDriver }>();

export async function driverFor(tabId: number, url: string): Promise<Driver> {
  const s = await getSettings();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* about:blank etc */
  }
  const lite = s.forceLite || (!!host && s.liteSites.some((g) => hostMatches(g, host)));
  let d = drivers.get(tabId);
  if (!d) drivers.set(tabId, (d = {}));
  if (lite) return (d.lite ??= new LiteDriver(tabId));
  return (d.cdp ??= new CdpDriver(getCdpTab(tabId)));
}

export function disposeDrivers(tabId: number) {
  const d = drivers.get(tabId);
  d?.cdp?.dispose();
  d?.lite?.dispose();
  drivers.delete(tabId);
}

export function mapEls(v: unknown, refs: (string | null)[]): unknown {
  if (Array.isArray(v)) return v.map((x) => mapEls(x, refs));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "el" && typeof x === "number") o.ref = refs[x] ?? null;
      else if (k === "submit" && typeof x === "number") o.submitRef = refs[x] ?? null;
      else o[k] = mapEls(x, refs);
    }
    return o;
  }
  return v;
}

function notActionable(ref: string, reason: string): TabAgentError {
  let hint = "Take a fresh page.snapshot.";
  if (reason.startsWith("covered")) hint = "Another element is on top (modal, cookie banner, sticky header?). Close it first, or scroll.";
  else if (reason === "not visible") hint = "The element is hidden. Open its parent menu/section first; for custom checkboxes use act.check.";
  else if (reason === "disabled") hint = "The element is disabled. Required fields may need filling first.";
  else if (reason === "not editable") hint = "Not a text field. Use act.select for selects, act.check for checkboxes.";
  else if (reason.startsWith("not stable")) hint = "The element is animating; try again.";
  return new TabAgentError("NOT_ACTIONABLE", `${ref} is ${reason}`, hint);
}

// ===========================================================================
// CDP driver
// ===========================================================================
export class CdpDriver implements Driver {
  kind = "cdp" as const;
  tabId: number;
  private refs = new Map<string, RefInfo>();
  private byNode = new Map<string, string>();
  private n = 0;
  private last: string[] | null = null;
  private frameCache: { at: number; frames: FrameInfo[] } | null = null;

  constructor(public tab: CdpTab) {
    this.tabId = tab.tabId;
  }

  dispose() {
    this.refs.clear();
    this.byNode.clear();
  }

  hasSnapshot() {
    return !!this.last;
  }

  refFor = (frameKey: string, backendNodeId: number): string => {
    const [sid] = splitKey(frameKey);
    const k = `${sid ?? ""}:${backendNodeId}`;
    let r = this.byNode.get(k);
    if (!r) {
      r = "e" + ++this.n;
      this.byNode.set(k, r);
    }
    this.refs.set(r, { frameKey, backendNodeId });
    return r;
  };

  resolveRef(ref: string): RefInfo {
    const r = this.refs.get(ref);
    if (!r) throw new TabAgentError("REF_STALE", `Unknown ref "${ref}"`, "Refs come from page.snapshot/page.find/form.describe on this tab. Take a new snapshot.");
    return r;
  }

  private async frames(): Promise<FrameInfo[]> {
    if (this.frameCache && Date.now() - this.frameCache.at < 300) return this.frameCache.frames;
    const frames = await this.tab.frames();
    this.frameCache = { at: Date.now(), frames };
    return frames;
  }

  async snapshot(o: SnapshotOpts) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const frames = await this.frames();
    const trees: FrameTree[] = [];
    for (const f of frames) {
      try {
        const r = await this.tab.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: f.frameId }, f.sessionId);
        trees.push({ key: f.key, nodes: r.nodes, ownerBackendNodeId: f.ownerBackendNodeId });
      } catch {
        if (!f.parentKey) throw new TabAgentError("INTERNAL", "Could not read the accessibility tree");
      }
    }
    // main frame first
    trees.sort((a, b) => (a.key === this.tab.mainKey() ? -1 : b.key === this.tab.mainKey() ? 1 : 0));
    const mode = o.mode ?? "interactive";
    let root: { frameKey: string; backendNodeId: number } | undefined;
    if (o.root) {
      const ri = this.resolveRef(o.root);
      root = { frameKey: ri.frameKey, backendNodeId: ri.backendNodeId };
    }
    const nodes = renderFrames(trees, { mode, refFor: this.refFor, root });
    const { text, truncated } = renderWithBudget(nodes, o.maxTokens ?? 8000);
    const full = serialize(nodes);
    let diff: { text: string; added: number; removed: number } | undefined;
    if (o.diff && this.last && !root) diff = diffLines(this.last, full, 200);
    if (!root) this.last = full;
    return { snapshot: text, refs: this.refs.size, truncated, ...(diff ? { diff } : {}) };
  }

  async diffSinceLast() {
    if (!this.last) return null;
    const prev = this.last;
    await this.snapshot({});
    return diffLines(prev, this.last!, 60);
  }

  private async toRefs(frameKey: string, value: unknown, nodes: number[]) {
    const refs = nodes.map((n) => (n > 0 ? this.refFor(frameKey, n) : null));
    return mapEls(value, refs);
  }

  async call(fn: string, args: unknown[], o: { ref?: string; frameKey?: string } = {}) {
    await this.tab.ensure();
    let frameKey = o.frameKey ?? this.tab.mainKey();
    let self: number | undefined;
    if (o.ref) {
      const ri = this.resolveRef(o.ref);
      frameKey = ri.frameKey;
      self = ri.backendNodeId;
    }
    const r = await this.tab.pagelib(frameKey, fn, args, self);
    return this.toRefs(frameKey, r.value, r.nodes);
  }

  async callAllFrames(fn: string, args: unknown[]) {
    await this.tab.ensure();
    const frames = await this.frames();
    const out: any[] = [];
    for (const f of frames) {
      try {
        const r = await this.tab.pagelib(f.key, fn, args);
        out.push({ frameKey: f.key, url: f.url, isMain: !f.parentKey, value: await this.toRefs(f.key, r.value, r.nodes) });
      } catch (e) {
        if (!f.parentKey) throw e;
      }
    }
    return out;
  }

  private async frameOffset(frameKey: string): Promise<{ x: number; y: number }> {
    const frames = await this.frames();
    const f = frames.find((x) => x.key === frameKey);
    if (!f || !f.parentKey || f.ownerBackendNodeId == null) return { x: 0, y: 0 };
    const parent = await this.frameOffset(f.parentKey);
    const own = (await this.tab.pagelib(f.parentKey, "frameOffset", [], f.ownerBackendNodeId)).value as { x: number; y: number };
    return { x: parent.x + own.x, y: parent.y + own.y };
  }

  async actionPoint(ref: string, opts: { timeout?: number; needEditable?: boolean } = {}) {
    const ri = this.resolveRef(ref);
    const deadline = Date.now() + (opts.timeout ?? 5000);
    let st: any;
    for (;;) {
      st = (await this.tab.pagelib(ri.frameKey, "prepareAction", [{ needEditable: opts.needEditable }], ri.backendNodeId)).value;
      if (st.ok) break;
      if (st.reason === "detached") throw new TabAgentError("REF_STALE", `${ref} was removed from the page`, "Take a new page.snapshot.");
      if (Date.now() > deadline) throw notActionable(ref, st.reason);
      await sleep(100);
    }
    const off = await this.frameOffset(ri.frameKey);
    return { x: st.x + off.x, y: st.y + off.y, ri };
  }

  /** Run an input promise, but return early if it opens a JS dialog (which blocks the renderer). */
  private async raceDialog<T>(p: Promise<T>): Promise<{ dialog?: unknown }> {
    const dlg = this.tab.waitEvent((m) => m === "Page.javascriptDialogOpening", 30000);
    const r = await Promise.race([p.then(() => "done" as const), dlg.then((d) => (d ? ("dialog" as const) : ("done" as const)))]);
    if (r === "dialog") {
      p.catch(() => {});
      await sleep(50);
      return { dialog: this.tab.dialog };
    }
    return this.tab.dialog ? { dialog: this.tab.dialog } : {};
  }

  private modBits(mods: string[] = []) {
    return mods.reduce((a, m) => a | (MOD_BITS[m] ?? 0), 0);
  }

  async click(ref: string, o: ClickOpts = {}) {
    const { x, y } = await this.actionPoint(ref, { timeout: o.timeout });
    await this.overlay(ref);
    const button = o.button ?? "left";
    const clickCount = o.clickCount ?? 1;
    const modifiers = this.modBits(o.modifiers);
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    const seq = (async () => {
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      for (let i = 1; i <= clickCount; i++) {
        await this.tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: i, modifiers });
        await this.tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i, modifiers });
      }
    })();
    return this.raceDialog(seq);
  }

  async hover(ref: string, timeout?: number) {
    const { x, y } = await this.actionPoint(ref, { timeout });
    await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async focus(ref: string, end = true) {
    await this.call("focus", [{ end }], { ref });
  }

  private async keyEvent(def: ReturnType<typeof keyDef>, mods: string[], commands?: string[]) {
    const modifiers = this.modBits(def.shift && !mods.includes("Shift") ? [...mods, "Shift"] : mods);
    const hasText = def.text && !mods.some((m) => m === "Control" || m === "Meta" || m === "Alt");
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, location: def.location ?? 0 };
    await this.tab.send("Input.dispatchKeyEvent", { type: hasText ? "keyDown" : "rawKeyDown", ...base, ...(hasText ? { text: def.text, unmodifiedText: def.text } : {}), ...(commands ? { commands } : {}) });
    await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async press(chord: string) {
    let parsed: { mods: string[]; key: string };
    let def: ReturnType<typeof keyDef>;
    try {
      parsed = parseChord(chord);
      def = keyDef(parsed.key);
    } catch (e) {
      throw new TabAgentError("BAD_REQUEST", (e as Error).message, "Examples: Enter, Tab, Escape, ArrowDown, Control+a, Meta+Shift+k");
    }
    const seq = (async () => {
      const held: string[] = [];
      for (const m of parsed.mods) {
        held.push(m);
        const md = keyDef(m);
        await this.tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: md.key, code: md.code, windowsVirtualKeyCode: md.keyCode, modifiers: this.modBits(held), location: 1 });
      }
      await this.keyEvent(def, parsed.mods, editCommand(parsed.mods, parsed.key));
      for (const m of [...parsed.mods].reverse()) {
        held.pop();
        const md = keyDef(m);
        await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: md.key, code: md.code, windowsVirtualKeyCode: md.keyCode, modifiers: this.modBits(held), location: 1 });
      }
    })();
    return this.raceDialog(seq);
  }

  async typeText(text: string) {
    const seq = (async () => {
      for (const ch of text) {
        if (ch === "\n") {
          await this.keyEvent(keyDef("Enter"), []);
          continue;
        }
        let def: ReturnType<typeof keyDef>;
        try {
          def = keyDef(ch);
        } catch {
          def = { key: ch, code: "", keyCode: 0, text: ch };
        }
        if (!def.keyCode) {
          await this.tab.send("Input.insertText", { text: ch });
          continue;
        }
        await this.keyEvent(def, []);
      }
    })();
    return this.raceDialog(seq);
  }

  async fill(ref: string, value: string, timeout?: number) {
    await this.actionPoint(ref, { timeout, needEditable: true });
    await this.overlay(ref);
    const st = (await this.call("focusSelect", [], { ref })) as { mode: string; empty: boolean };
    if (st.mode === "insert") {
      if (value === "") {
        if (!st.empty) await this.press("Delete");
      } else await this.tab.send("Input.insertText", { text: value });
      // verify; fall back to setter (some masked inputs reformat — accept those)
      const v = (await this.call("valueOf", [], { ref })) as string;
      if (v === "" && value !== "") await this.call("setValue", [value], { ref });
    } else {
      await this.call("setValue", [value], { ref });
    }
  }

  async scroll(ref: string | undefined, dx: number, dy: number) {
    await this.tab.ensure();
    if (ref && !dx && !dy) return this.call("scrollIntoView", [], { ref });
    let x = 200;
    let y = 200;
    if (ref) {
      const p = await this.actionPoint(ref).catch(() => null);
      if (p) ({ x, y } = p);
    } else {
      const m = await this.tab.send<any>("Page.getLayoutMetrics", {});
      x = m.cssVisualViewport.clientWidth / 2;
      y = m.cssVisualViewport.clientHeight / 2;
    }
    await this.tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    await sleep(150);
    return this.call("pageState", []).then(async () => (await this.tab.evalMain("({scrollX, scrollY})")) as unknown);
  }

  async drag(from: string, to: string, timeout?: number) {
    const a = await this.actionPoint(from, { timeout });
    const b = await this.actionPoint(to, { timeout });
    this.tab.dragData = null;
    await this.tab.send("Input.setInterceptDrags", { enabled: true });
    try {
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
      await this.tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = a.x + ((b.x - a.x) * i) / steps;
        const y = a.y + ((b.y - a.y) * i) / steps;
        await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        if (this.tab.dragData) break;
      }
      await sleep(30);
      if (this.tab.dragData) {
        const data = this.tab.dragData;
        await this.tab.send("Input.dispatchDragEvent", { type: "dragEnter", x: b.x, y: b.y, data });
        await this.tab.send("Input.dispatchDragEvent", { type: "dragOver", x: b.x, y: b.y, data });
        await this.tab.send("Input.dispatchDragEvent", { type: "drop", x: b.x, y: b.y, data });
      }
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    } finally {
      await this.tab.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
      this.tab.dragData = null;
    }
  }

  async upload(ref: string, paths: string[]) {
    const ri = this.resolveRef(ref);
    const inf = (await this.call("info", [], { ref })) as { isFile: boolean };
    if (!inf.isFile) throw new TabAgentError("NOT_ACTIONABLE", `${ref} is not a file input`, "Use page.find css='input[type=file]' to locate the file input (it may be hidden behind a button).");
    const [sid] = splitKey(ri.frameKey);
    await this.tab.send("DOM.setFileInputFiles", { files: paths, backendNodeId: ri.backendNodeId }, sid);
  }

  async screenshot(o: { fullPage?: boolean; ref?: string; marks?: boolean; format?: "png" | "jpeg" }) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const format = o.format ?? "png";
    const params: Record<string, unknown> = { format, ...(format === "jpeg" ? { quality: 80 } : {}), fromSurface: true };
    const metrics = await this.tab.send<any>("Page.getLayoutMetrics", {});
    const vv = metrics.cssVisualViewport;
    let width = vv.clientWidth;
    let height = vv.clientHeight;
    if (o.ref) {
      const ri = this.resolveRef(o.ref);
      await this.call("scrollIntoView", [], { ref: o.ref });
      const r = (await this.tab.pagelib(ri.frameKey, "rectOf", [], ri.backendNodeId)).value as { x: number; y: number; w: number; h: number };
      const off = await this.frameOffset(ri.frameKey);
      const m2 = await this.tab.send<any>("Page.getLayoutMetrics", {});
      params.clip = { x: r.x + off.x + m2.cssVisualViewport.pageX, y: r.y + off.y + m2.cssVisualViewport.pageY, width: Math.max(1, r.w), height: Math.max(1, r.h), scale: 1 };
      width = r.w;
      height = r.h;
    } else if (o.fullPage) {
      const cs = metrics.cssContentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 16000), scale: 1 };
      width = cs.width;
      height = Math.min(cs.height, 16000);
    }
    let marked = false;
    if (o.marks) {
      if (!this.last) await this.snapshot({});
      const mk = this.tab.mainKey();
      const entries = [...this.refs.entries()].filter(([, v]) => v.frameKey === mk).slice(-300);
      const marks: { label: string; x: number; y: number; w: number; h: number }[] = [];
      for (const [ref, v] of entries) {
        try {
          const r = (await this.tab.pagelib(mk, "rectOf", [], v.backendNodeId)).value as { x: number; y: number; w: number; h: number };
          if (r.w > 0 && r.h > 0 && r.y < vv.clientHeight && r.y + r.h > 0) marks.push({ label: ref, ...r });
        } catch {
          /* stale */
        }
      }
      await this.tab.pagelib(mk, "drawMarks", [marks]);
      marked = true;
    }
    try {
      const r = await this.tab.send<{ data: string }>("Page.captureScreenshot", params);
      return { data: r.data, mimeType: `image/${format}`, width: Math.round(width), height: Math.round(height) };
    } finally {
      if (marked) await this.tab.pagelib(this.tab.mainKey(), "clearOverlay", []).catch(() => {});
    }
  }

  async evaluate(expression: string, world: "main" | "isolated") {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    if (world === "main") return this.tab.evalMain(expression);
    const ctx = await this.tab.isolatedContext(this.tab.mainKey());
    const r = await this.tab.send<any>("Runtime.evaluate", { expression, contextId: ctx, awaitPromise: true, returnByValue: true, replMode: true });
    if (r.exceptionDetails) throw new TabAgentError("BAD_REQUEST", `Evaluation failed: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  navEpoch() {
    return this.tab.navEpoch;
  }

  async currentUrl() {
    if (this.tab.attached && this.tab.url) return this.tab.url;
    return (await chrome.tabs.get(this.tabId)).url ?? "";
  }

  private async waitLifecycle(loaderId: string | undefined, names: string[], timeout: number): Promise<boolean> {
    const mf = this.tab.mainFrameId;
    const match = (e: { frameId: string; loaderId: string; name: string; sessionId?: string }) => !e.sessionId && e.frameId === mf && names.includes(e.name) && (!loaderId || e.loaderId === loaderId);
    if (this.tab.lifecycle.some(match)) return true;
    const ev = await this.tab.waitEvent((m, p, sid) => m === "Page.lifecycleEvent" && match({ ...p, sessionId: sid }), timeout);
    return !!ev;
  }

  async navigate(url: string, waitUntil: string, timeout: number) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    this.last = null;
    const r = await this.tab.send<any>("Page.navigate", { url, transitionType: "typed" });
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") throw new TabAgentError("BAD_REQUEST", `Navigation failed: ${r.errorText}`);
    let warning: string | undefined;
    if (r.loaderId && waitUntil !== "none") {
      const names = waitUntil === "domcontentloaded" ? ["DOMContentLoaded", "load"] : ["load"];
      const ok = await this.waitLifecycle(r.loaderId, names, timeout);
      if (!ok) warning = `Timed out after ${timeout}ms waiting for ${waitUntil}; the page may still be loading.`;
      else if (waitUntil === "networkidle") {
        if (!(await this.tab.networkIdle(500, timeout))) warning = "Network did not go idle before timeout.";
      }
    }
    await sleep(50);
    return { url: await this.currentUrl(), ...(warning ? { warning } : {}) };
  }

  async history(action: "back" | "forward" | "reload", timeout: number) {
    await this.tab.ensure();
    this.last = null;
    const before = this.tab.navEpoch;
    if (action === "reload") await this.tab.send("Page.reload", {});
    else {
      const h = await this.tab.send<any>("Page.getNavigationHistory", {});
      const idx = h.currentIndex + (action === "back" ? -1 : 1);
      const entry = h.entries[idx];
      if (!entry) throw new TabAgentError("BAD_REQUEST", `No ${action} history entry`);
      await this.tab.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    await this.settle(before, timeout);
  }

  async waitLoad(timeout: number) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const rs = await this.tab.evalMain("document.readyState");
        if (rs === "complete") return true;
      } catch {
        /* navigating */
      }
      await sleep(100);
    }
    return false;
  }

  networkIdle(quiet: number, timeout: number) {
    return this.tab.networkIdle(quiet, timeout);
  }

  /** After an action: wait for any navigation it triggered, then a short network quiet period. */
  async settle(beforeEpoch: number, timeout = 5000) {
    await sleep(120);
    if (this.tab.dialog) return;
    if (this.tab.navEpoch !== beforeEpoch) {
      this.last = null;
      const end = Date.now() + timeout;
      // wait for load of the latest main-frame loader
      while (Date.now() < end) {
        const mf = this.tab.mainFrameId;
        const lastStart = [...this.tab.lifecycle].reverse().find((e) => !e.sessionId && e.frameId === mf && e.name === "init");
        if (lastStart && this.tab.lifecycle.some((e) => !e.sessionId && e.loaderId === lastStart.loaderId && e.name === "load")) break;
        if (this.tab.dialog) return;
        await sleep(50);
      }
    }
    await this.tab.networkIdle(300, 1500);
  }

  dialog() {
    return this.tab.dialog;
  }

  handleDialog(accept: boolean, promptText?: string) {
    return this.tab.handleDialog(accept, promptText);
  }

  private async overlay(ref: string) {
    const s = await getSettings();
    if (!s.showOverlay) return;
    await this.call("showActivity", [""], { ref }).catch(() => {});
  }
}

// ===========================================================================
// Lite driver (content scripts only; synthetic events)
// ===========================================================================
function liteUnsupported(what: string): TabAgentError {
  return new TabAgentError("BAD_REQUEST", `${what} is not available in lite mode`, "Lite mode avoids chrome.debugger. Remove this site from Lite sites in the TabAgent side panel to use full mode.");
}

export class LiteDriver implements Driver {
  kind = "lite" as const;
  private last: string[] | null = null;
  private epoch = 0;
  constructor(public tabId: number) {}
  dispose() {}

  hasSnapshot() {
    return !!this.last;
  }

  resolveRef(ref: string): RefInfo {
    return { frameKey: "lite", backendNodeId: 0, ...{ ref } } as unknown as RefInfo;
  }

  private async exec<T>(func: (...a: any[]) => T, args: unknown[]): Promise<Awaited<T>> {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: this.tabId, frameIds: [0] }, func: func as any, args: args as any[] });
    return r?.result as Awaited<T>;
  }

  private async ensureLib() {
    const has = await this.exec(() => !!(globalThis as any).__ta, []);
    if (!has) await chrome.scripting.executeScript({ target: { tabId: this.tabId, frameIds: [0] }, files: ["pagelib.js"] });
  }

  async call(fn: string, args: unknown[], o: { ref?: string } = {}) {
    await this.ensureLib();
    const r = (await this.exec((n: string, ref: string | null, a: unknown[]) => (globalThis as any).__ta.callLite(null, n, ref, a), [fn, o.ref ?? null, args])) as { value?: unknown; stale?: boolean };
    if (r?.stale) throw new TabAgentError("REF_STALE", `${o.ref} is no longer in the page`, "Take a new page.snapshot.");
    return r?.value;
  }

  async callAllFrames(fn: string, args: unknown[]) {
    return [{ frameKey: "lite", isMain: true, value: await this.call(fn, args) }];
  }

  async snapshot(o: SnapshotOpts) {
    const r = (await this.call("snapshotDom", [o.mode ?? "interactive"], o.root ? { ref: o.root } : {})) as { snapshot: string };
    const lines = r.snapshot.split("\n");
    const budget = (o.maxTokens ?? 8000) * 4;
    let text = r.snapshot;
    let truncated = false;
    if (text.length > budget) {
      text = text.slice(0, budget);
      text = text.slice(0, text.lastIndexOf("\n")) + "\n- … [truncated]";
      truncated = true;
    }
    let diff;
    if (o.diff && this.last) diff = diffLines(this.last, lines, 200);
    if (!o.root) this.last = lines;
    return { snapshot: text, refs: (text.match(/\[ref=/g) ?? []).length, truncated, ...(diff ? { diff } : {}) };
  }

  async diffSinceLast() {
    if (!this.last) return null;
    const prev = this.last;
    await this.snapshot({});
    return diffLines(prev, this.last!, 60);
  }

  private async prep(ref: string, timeout = 5000, needEditable = false) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const st = (await this.call("prepareAction", [{ needEditable }], { ref })) as { ok: boolean; reason?: string };
      if (st.ok) return;
      if (st.reason === "detached") throw new TabAgentError("REF_STALE", `${ref} was removed`, "Take a new page.snapshot.");
      if (Date.now() > deadline) throw notActionable(ref, st.reason ?? "not actionable");
      await sleep(100);
    }
  }

  async click(ref: string, o: ClickOpts = {}) {
    await this.prep(ref, o.timeout);
    this.epoch++;
    await this.call("syntheticClick", [{ button: o.button === "right" ? 2 : o.button === "middle" ? 1 : 0, clickCount: o.clickCount }], { ref });
    return {};
  }
  async hover(ref: string, timeout?: number) {
    await this.prep(ref, timeout);
    await this.call("syntheticHover", [], { ref });
  }
  async focus(ref: string, end = true) {
    await this.call("focus", [{ end }], { ref });
  }
  async typeText(text: string) {
    await this.call("syntheticType", [text]);
    return {};
  }
  async press(chord: string) {
    this.epoch++;
    await this.call("syntheticKey", [chord]);
    return {};
  }
  async fill(ref: string, value: string, timeout?: number) {
    await this.prep(ref, timeout, true);
    await this.call("setValue", [value], { ref });
  }
  async scroll(ref: string | undefined, dx: number, dy: number) {
    if (ref && !dx && !dy) return this.call("scrollIntoView", [], { ref });
    return this.call("scrollBy", [dx, dy], ref ? { ref } : {});
  }
  async drag(): Promise<void> {
    throw liteUnsupported("act.drag");
  }
  async upload(): Promise<void> {
    throw liteUnsupported("act.upload");
  }
  async screenshot(o: { fullPage?: boolean; ref?: string; format?: "png" | "jpeg" }) {
    if (o.fullPage || o.ref) throw liteUnsupported("Full-page/element screenshots");
    const tab = await chrome.tabs.get(this.tabId);
    if (!tab.active) await chrome.tabs.update(this.tabId, { active: true });
    const fmt = o.format ?? "png";
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: fmt });
    return { data: url.split(",")[1], mimeType: `image/${fmt}` };
  }
  async evaluate(): Promise<unknown> {
    throw liteUnsupported("js.eval");
  }
  navEpoch() {
    return this.epoch;
  }
  async currentUrl() {
    return (await chrome.tabs.get(this.tabId)).url ?? "";
  }
  private waitComplete(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(l);
        resolve(false);
      }, timeout);
      const l = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (id === this.tabId && info.status === "complete") {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(l);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(l);
    });
  }
  async navigate(url: string, _w: string, timeout: number) {
    this.last = null;
    const p = this.waitComplete(timeout);
    await chrome.tabs.update(this.tabId, { url });
    const ok = await p;
    return { url: await this.currentUrl(), ...(ok ? {} : { warning: "Timed out waiting for load" }) };
  }
  async history(action: "back" | "forward" | "reload", timeout: number) {
    this.last = null;
    const p = this.waitComplete(timeout);
    if (action === "reload") await chrome.tabs.reload(this.tabId);
    else if (action === "back") await chrome.tabs.goBack(this.tabId);
    else await chrome.tabs.goForward(this.tabId);
    await p;
  }
  async waitLoad(timeout: number) {
    const t = await chrome.tabs.get(this.tabId);
    if (t.status === "complete") return true;
    return this.waitComplete(timeout);
  }
  async networkIdle(): Promise<boolean> {
    await sleep(300);
    return true;
  }
  async settle(before: number, timeout = 5000) {
    await sleep(200);
    const t = await chrome.tabs.get(this.tabId);
    if (t.status !== "complete") {
      this.last = null;
      await this.waitComplete(timeout);
    }
    void before;
  }
  dialog() {
    return null;
  }
  async handleDialog(): Promise<unknown> {
    throw liteUnsupported("dialog.handle");
  }
}
