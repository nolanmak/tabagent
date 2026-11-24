// D26 Driver interface + the CDP driver. Tool handlers talk only to a Driver;
// nothing outside cdp.ts / driver.ts calls chrome.debugger. Decisions live in
// the pure modules (snapshot, refs, autowait, frames, screenshot-plan, wait);
// this file wires them to CDP.
import { TabAgentError } from "@tabagent/protocol";
import { autoWait, type Observation } from "./autowait";
import { CdpTab, getCdpTab, sleep, type FrameInfo } from "./cdp";
import { staleRef, taErr } from "./errors";
import { ancestry, contentOffset, translate, translateBox, splitKey, type Offset, type OwnerMetrics } from "./frames";
import { editCommand, keyDef, MOD_BITS, parseChord } from "./keys";
import { LiteDriver } from "./lite-driver";
import { effectivePolicy } from "./permissions";
import { baselines, refTable } from "./refstore";
import type { RefTable, RefTarget } from "./refs";
import { marksInView, planCapture, type Metrics, type Target } from "./screenshot-plan";
import { getSettings, liteForUrl } from "./settings";
import { render, type FrameTree, type RefSource, type RenderResult, type AXNode } from "./snapshot";
import { capMatches, type FindMatch, type FindSpec } from "./wait";

export interface SnapshotOpts {
  mode?: "interactive" | "full";
  root?: string;
  maxTokens?: number;
  collapse?: boolean;
}

export interface ClickOpts {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: string[];
  timeout?: number;
}

export interface ScreenshotOpts {
  target?: Target;
  ref?: string;
  format?: "png" | "jpeg";
  quality?: number;
  marks?: boolean;
}

export interface Screenshot {
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  note?: string;
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
}

export interface FrameCall {
  frameKey: string;
  url: string;
  isMain: boolean;
  value: any;
}

/** D26: what tool handlers may ask of a tab. CDP is one implementation, lite (#21) the other. */
export interface Driver {
  kind: "cdp" | "lite";
  tabId: number;
  snapshot(o: SnapshotOpts): Promise<RenderResult>;
  find(spec: FindSpec): Promise<{ matches: FindMatch[]; truncated: boolean }>;
  resolveRef(ref: string): Promise<RefTarget>;
  call(fn: string, args: unknown[], o?: { ref?: string; frameKey?: string }): Promise<any>;
  callAllFrames(fn: string, args: unknown[]): Promise<FrameCall[]>;
  click(ref: string, o?: ClickOpts): Promise<{ dialog?: DialogInfo }>;
  hover(ref: string, timeout?: number): Promise<void>;
  focus(ref: string, end?: boolean): Promise<void>;
  /** Wait until `ref` can take text input (attached, visible, enabled, editable). */
  prepareInput(ref: string, timeout?: number): Promise<void>;
  typeText(text: string): Promise<{ dialog?: DialogInfo }>;
  press(chord: string): Promise<{ dialog?: DialogInfo }>;
  fill(ref: string, value: string, timeout?: number): Promise<void>;
  scroll(ref: string | undefined, dx: number, dy: number): Promise<unknown>;
  drag(from: string, to: string, timeout?: number): Promise<void>;
  upload(ref: string, paths: string[]): Promise<void>;
  screenshot(o: ScreenshotOpts): Promise<Screenshot>;
  /**
   * nav.wait for=fn: an evaluator bound to an isolated world of its own (never pagelib's, which
   * agent code could otherwise tamper with), created on first use and again after the document changes.
   */
  evaluator(): (expression: string) => Promise<unknown>;
  navigate(url: string, waitUntil: string, timeout: number): Promise<{ url: string; warning?: string }>;
  history(action: "back" | "forward" | "reload", timeout: number): Promise<void>;
  waitLoad(timeout: number): Promise<boolean>;
  networkIdle(quiet: number, timeout: number): Promise<boolean>;
  /** D24: wait for the DOM to be quiet (100ms, max 1s). */
  quiet(): Promise<void>;
  settle(beforeEpoch: number, timeout?: number): Promise<void>;
  navEpoch(): number;
  currentUrl(): Promise<string>;
  dialog(): DialogInfo | null;
  handleDialog(accept: boolean, promptText?: string): Promise<unknown>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Extra masking (D18 + M6 auth): a hook returns true for nodes whose value must
// render as •••• in snapshots and diffs (e.g. fields TabAgent autofilled).
// ---------------------------------------------------------------------------
type MaskHook = (tabId: number, backendNodeId: number, frameKey: string) => boolean;
const maskHooks: MaskHook[] = [];
let waitWorldSeq = 0;
export function addMaskHook(fn: MaskHook): () => void {
  maskHooks.push(fn);
  return () => {
    const i = maskHooks.indexOf(fn);
    if (i >= 0) maskHooks.splice(i, 1);
  };
}
export function maskedByHook(tabId: number, backendNodeId: number, frameKey: string): boolean {
  return maskHooks.some((f) => {
    try {
      return f(tabId, backendNodeId, frameKey);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// driverFor: per-origin mode (D26/D32), never switches automatically
// ---------------------------------------------------------------------------
const drivers = new Map<number, { cdp?: CdpDriver; lite?: LiteDriver }>();

export async function driverFor(tabId: number, url: string): Promise<Driver> {
  const lite = await liteForUrl(url);
  let d = drivers.get(tabId);
  if (!d) drivers.set(tabId, (d = {}));
  if (lite) return (d.lite ??= new LiteDriver(tabId, refTable));
  return (d.cdp ??= new CdpDriver(getCdpTab(tabId), refTable));
}

export function peekDriver(tabId: number): Driver | undefined {
  const d = drivers.get(tabId);
  return d?.cdp ?? d?.lite;
}

export function disposeDrivers(tabId: number) {
  const d = drivers.get(tabId);
  d?.cdp?.dispose();
  d?.lite?.dispose();
  drivers.delete(tabId);
  refTable.dropTab(tabId);
  baselines.clearTab(tabId);
}

/** Replace `{el: i}` (and `submit: i`) in pagelib results with refs. */
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

/** Frames whose origin is denied by site policy (D16): placeholder only, never touched. */
export async function deniedOrigin(url: string): Promise<string | null> {
  if (!url || /^(about|data|blob|javascript):/i.test(url)) return null;
  try {
    const e = (await effectivePolicy(url)) as unknown as { origin?: string | null; policy?: string; level?: string } | string;
    const pol = typeof e === "string" ? e : (e?.policy ?? e?.level);
    if (pol === "deny") return (typeof e === "object" && e?.origin) || new URL(url).origin;
  } catch {
    /* policy engine unavailable: treat as allowed (router already checked the tab) */
  }
  return null;
}

export function refSource(table: RefTable, tabId: number, loaderOf: (frameKey: string) => string): RefSource {
  return {
    peek: (frameKey, backendNodeId) => table.peek({ tabId, frameKey, backendNodeId, loaderId: loaderOf(frameKey) }),
    mint: (frameKey, backendNodeId) => table.mint({ tabId, frameKey, backendNodeId, loaderId: loaderOf(frameKey) }),
    nextNumber: () => table.peekNext(),
  };
}

// ===========================================================================
// CDP driver
// ===========================================================================
export class CdpDriver implements Driver {
  kind = "cdp" as const;
  tabId: number;
  private frameCache: { at: number; frames: FrameInfo[]; allowed: FrameInfo[] } | null = null;
  private offs: (() => void)[] = [];

  constructor(
    public tab: CdpTab,
    private refs: RefTable,
    private clock: { now(): number; sleep(ms: number): Promise<void> } = { now: () => Date.now(), sleep: (ms) => sleep(ms) as Promise<void> },
  ) {
    this.tabId = tab.tabId;
    // D24: a navigation clears every session's baseline for this tab.
    this.offs.push(tab.onNavigated?.(() => baselines.clearTab(this.tabId)) ?? (() => {}));
  }

  dispose() {
    this.offs.forEach((f) => f());
    this.offs = [];
  }

  private loaderOf = (frameKey: string) => this.tab.loaders.get(frameKey) ?? "";

  private async frames(fresh = false): Promise<{ frames: FrameInfo[]; allowed: FrameInfo[] }> {
    if (!fresh && this.frameCache && this.clock.now() - this.frameCache.at < 300) return this.frameCache;
    const frames = await this.tab.frames();
    // main frame first
    const mk = this.tab.mainKey();
    frames.sort((a, b) => (a.key === mk ? -1 : b.key === mk ? 1 : 0));
    const denied = new Map<string, string>();
    for (const f of frames) {
      if (!f.parentKey) continue;
      const d = await deniedOrigin(f.url);
      if (d) denied.set(f.key, d);
    }
    const blocked = (f: FrameInfo): boolean => denied.has(f.key) || (!!f.parentKey && frames.some((p) => p.key === f.parentKey && blocked(p)));
    const allowed = frames.filter((f) => !blocked(f));
    this.frameCache = { at: this.clock.now(), frames, allowed };
    (this.frameCache as unknown as { denied: Map<string, string> }).denied = denied;
    return this.frameCache;
  }

  async resolveRef(ref: string): Promise<RefTarget> {
    await this.tab.ensure();
    try {
      return this.refs.resolve(ref, this.tabId, (fk) => this.tab.loaders.get(fk));
    } catch (e) {
      // The frame may simply not be in our loader map yet (late OOPIF): refresh once.
      const t = this.refs.get(ref);
      if (t && t.tabId === this.tabId && !this.tab.loaders.has(t.frameKey)) {
        await this.frames(true);
        return this.refs.resolve(ref, this.tabId, (fk) => this.tab.loaders.get(fk));
      }
      throw e;
    }
  }

  async snapshot(o: SnapshotOpts): Promise<RenderResult> {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const { frames } = await this.frames(true);
    const denied = (this.frameCache as unknown as { denied: Map<string, string> }).denied;
    const trees: FrameTree[] = [];
    let total = 0;
    for (const f of frames) {
      if (denied.has(f.key)) {
        trees.push({ key: f.key, nodes: [], ownerBackendNodeId: f.ownerBackendNodeId, ownerFrameKey: f.parentKey, denied: denied.get(f.key) });
        continue;
      }
      if (f.parentKey && !this.frameCache!.allowed.includes(f)) continue;
      try {
        const r = await this.tab.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: f.frameId }, f.sessionId);
        let sensitive: number[] = [];
        try {
          sensitive = (await this.tab.pagelib(f.key, "sensitiveInputs", [])).nodes.filter((n) => n > 0);
        } catch {
          /* frame busy: values still masked by the bullet heuristic */
        }
        total += r.nodes.length;
        if (maskHooks.length) for (const n of r.nodes) if (n.backendDOMNodeId != null && maskedByHook(this.tabId, n.backendDOMNodeId, f.key)) sensitive.push(n.backendDOMNodeId);
        trees.push({ key: f.key, nodes: r.nodes, ownerBackendNodeId: f.ownerBackendNodeId, ownerFrameKey: f.parentKey, sensitive });
      } catch (e) {
        if (!f.parentKey) throw taErr("INTERNAL", `Could not read the accessibility tree: ${(e as Error).message}`);
      }
    }
    let root: { frameKey: string; backendNodeId: number } | undefined;
    if (o.root) {
      const t = await this.resolveRef(o.root);
      root = { frameKey: t.frameKey, backendNodeId: t.backendNodeId };
    }
    await this.refs.reserve(total + 1);
    return render(trees, { mode: o.mode, maxTokens: o.maxTokens, root, collapse: o.collapse, refs: refSource(this.refs, this.tabId, this.loaderOf) });
  }

  private toRefs(frameKey: string, value: unknown, nodes: number[]) {
    const loaderId = this.loaderOf(frameKey);
    const refs = nodes.map((n) => (n > 0 ? this.refs.mint({ tabId: this.tabId, frameKey, backendNodeId: n, loaderId }) : null));
    return mapEls(value, refs);
  }

  async find(spec: FindSpec) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const per: FindMatch[][] = [];
    const run = async (frameKey: string, self?: number) => {
      const r = await this.tab.pagelib(frameKey, "findNodes", [{ by: spec.by, value: spec.value, name: spec.name, limit: 20 }], self);
      const v = this.toRefs(frameKey, r.value, r.nodes) as { matches: { ref: string | null; role: string; name: string }[] };
      per.push(v.matches.filter((m) => m.ref).map((m) => ({ ref: m.ref!, role: m.role, name: m.name })));
    };
    if (spec.root) {
      const t = await this.resolveRef(spec.root);
      await run(t.frameKey, t.backendNodeId);
    } else {
      const { allowed } = await this.frames(true);
      for (const f of allowed) {
        if (per.flat().length > 20) break;
        try {
          await run(f.key);
        } catch (e) {
          if (!f.parentKey) throw e instanceof TabAgentError ? e : taErr("BAD_REQUEST", `page.find failed: ${(e as Error).message}`);
        }
      }
    }
    return capMatches(per);
  }

  async call(fn: string, args: unknown[], o: { ref?: string; frameKey?: string } = {}) {
    await this.tab.ensure();
    let frameKey = o.frameKey ?? this.tab.mainKey();
    let self: number | undefined;
    if (o.ref) {
      const t = await this.resolveRef(o.ref);
      frameKey = t.frameKey;
      self = t.backendNodeId;
    }
    const r = await this.tab.pagelib(frameKey, fn, args, self);
    return this.toRefs(frameKey, r.value, r.nodes);
  }

  async callAllFrames(fn: string, args: unknown[]): Promise<FrameCall[]> {
    await this.tab.ensure();
    const { allowed } = await this.frames();
    const out: FrameCall[] = [];
    for (const f of allowed) {
      try {
        const r = await this.tab.pagelib(f.key, fn, args);
        out.push({ frameKey: f.key, url: f.url, isMain: !f.parentKey, value: this.toRefs(f.key, r.value, r.nodes) });
      } catch (e) {
        if (!f.parentKey) throw e;
      }
    }
    return out;
  }

  /** Offsets from a frame's viewport to the top-level viewport, innermost first (#19). */
  async offsetChain(frameKey: string): Promise<Offset[]> {
    const { frames } = await this.frames();
    const chain: Offset[] = [];
    for (const k of ancestry(frames, frameKey)) {
      const f = frames.find((x) => x.key === k)!;
      if (f.ownerBackendNodeId == null || !f.parentKey) continue;
      const m = (await this.tab.pagelib(f.parentKey, "ownerMetrics", [], f.ownerBackendNodeId)).value as OwnerMetrics;
      chain.push(contentOffset(m));
    }
    return chain;
  }

  /** Auto-wait (#7) then return the top-level viewport point to act on. */
  async actionPoint(ref: string, opts: { timeout?: number; needEditable?: boolean } = {}) {
    const t = await this.resolveRef(ref);
    const local = await this.tab.guard(
      autoWait(
        ref,
        {
          now: () => this.clock.now(),
          sleep: (ms) => this.clock.sleep(ms),
          check: () => {
            this.tab.assertNoDialog();
            if (this.tab.userDetached) throw this.tab.detachedError();
          },
          observe: async (scroll) => {
            try {
              return (await this.tab.pagelib(t.frameKey, "observe", [{ scroll }], t.backendNodeId)).value as Observation;
            } catch (e) {
              if (e instanceof TabAgentError && (e.code as string) === "REF_STALE") throw staleRef(ref, "the element is no longer in the page");
              throw e;
            }
          },
        },
        { timeout: opts.timeout, needEditable: opts.needEditable },
      ),
    );
    const chain = await this.offsetChain(t.frameKey);
    return { ...translate(local, chain), target: t };
  }

  /** Run input, but return early if it opens a JS dialog (which blocks the renderer, D28). */
  private async raceDialog(p: Promise<unknown>): Promise<{ dialog?: DialogInfo }> {
    const dlg = this.tab.waitEvent((m) => m === "Page.javascriptDialogOpening", 30000);
    const r = await this.tab.guard(Promise.race([p.then(() => "done" as const), dlg.then((d) => (d ? ("dialog" as const) : ("done" as const)))]));
    if (r === "dialog") {
      p.catch(() => {});
      await this.clock.sleep(50);
      return { dialog: this.dialog() ?? undefined };
    }
    const d = this.dialog();
    return d ? { dialog: d } : {};
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
    await this.tab.guard(this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }));
  }

  async focus(ref: string, end = true) {
    await this.call("focus", [{ end }], { ref });
  }

  async prepareInput(ref: string, timeout?: number) {
    await this.actionPoint(ref, { timeout, needEditable: true });
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
      throw taErr("BAD_REQUEST", (e as Error).message, "Examples: Enter, Tab, Escape, ArrowDown, Control+a, Meta+Shift+k");
    }
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const seq = (async () => {
      await this.wakeInput();
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

  /** #7: act.type inserts text at the focused element with CDP Input.insertText; newlines press Enter. */
  async typeText(text: string) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const seq = (async () => {
      await this.wakeInput();
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) await this.tab.send("Input.insertText", { text: parts[i] });
        if (i < parts.length - 1) await this.keyEvent(keyDef("Enter"), []);
      }
    })();
    return this.raceDialog(seq);
  }

  /**
   * Background tabs in headless Chromium never produce frames, and input that
   * needs a frame ack (keys, insertText) waits forever. Focus emulation makes
   * the page behave as focused without bringing the tab to the front (D10).
   */
  private woke = false;
  private async wakeInput() {
    if (this.woke) return;
    this.woke = true;
    await this.tab.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  /** #7: act.fill clears, then sets through the native value setter and fires input + change. */
  async fill(ref: string, value: string, timeout?: number) {
    await this.actionPoint(ref, { timeout, needEditable: true });
    await this.overlay(ref);
    await this.call("setValue", [value], { ref });
  }

  async scroll(ref: string | undefined, dx: number, dy: number) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    if (ref && !dx && !dy) return this.call("scrollIntoView", [], { ref });
    if (ref) {
      await this.call("scrollBy", [dx, dy], { ref });
    } else {
      await this.tab.evalMain(`window.scrollBy({left: ${Number(dx) || 0}, top: ${Number(dy) || 0}, behavior: "instant"}); 0`);
    }
    return (await this.tab.evalMain("({scrollX, scrollY})")) as unknown;
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
      await this.clock.sleep(30);
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
    const t = await this.resolveRef(ref);
    const inf = (await this.call("info", [], { ref })) as { isFile: boolean };
    if (!inf.isFile) throw taErr("NOT_ACTIONABLE", `${ref} is not a file input`, "Use page.find by=css value='input[type=file]' to locate the file input (it may be hidden behind a button).");
    const [sid] = splitKey(t.frameKey);
    await this.tab.send("DOM.setFileInputFiles", { files: paths, backendNodeId: t.backendNodeId }, sid);
  }

  private async metrics(): Promise<Metrics> {
    const m = await this.tab.send<any>("Page.getLayoutMetrics", {});
    const vv = m.cssVisualViewport;
    const cs = m.cssContentSize ?? m.contentSize;
    return { viewport: { w: vv.clientWidth, h: vv.clientHeight, pageX: vv.pageX, pageY: vv.pageY }, content: { w: cs.width, h: cs.height } };
  }

  private async boxOf(t: RefTarget, chain?: Offset[]) {
    const r = (await this.tab.pagelib(t.frameKey, "rectOf", [], t.backendNodeId)).value as { x: number; y: number; w: number; h: number };
    return translateBox(r, chain ?? (await this.offsetChain(t.frameKey)));
  }

  /** #8: D30 result; overlay hidden during capture (D40); marks label only refs from the shared table. */
  async screenshot(o: ScreenshotOpts): Promise<Screenshot> {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    const target: Target = o.target ?? (o.ref ? "ref" : "viewport");
    const format = o.format ?? "png";
    let box: { x: number; y: number; w: number; h: number } | undefined;
    if (target === "ref") {
      if (!o.ref) throw taErr("BAD_REQUEST", "target=ref needs ref");
      const t = await this.resolveRef(o.ref);
      await this.call("scrollIntoView", [], { ref: o.ref });
      box = await this.boxOf(t);
    }
    const m = await this.metrics();
    const plan = planCapture(target, m, box);
    const { allowed } = await this.frames();
    let marked = false;
    if (o.marks) {
      const snap = await this.snapshot({ mode: "interactive", maxTokens: 1_000_000, collapse: false });
      const byFrame = new Map<string, { ref: string; backendNodeId: number }[]>();
      for (const s of snap.shown) if (s.interactive) byFrame.set(s.frameKey, [...(byFrame.get(s.frameKey) ?? []), s]);
      const entries: { ref: string; box: { x: number; y: number; w: number; h: number } | null }[] = [];
      for (const [fk, list] of byFrame) {
        try {
          const chain = await this.offsetChain(fk);
          const r = await this.tab.pagelib(fk, "rectsOf", [], undefined, list.map((l) => l.backendNodeId));
          (r.value as ({ x: number; y: number; w: number; h: number } | null)[]).forEach((b, i) => entries.push({ ref: list[i].ref, box: b ? translateBox(b, chain) : null }));
        } catch {
          /* frame went away */
        }
      }
      await this.tab.pagelib(this.tab.mainKey(), "drawMarks", [marksInView(entries, m.viewport)]);
      marked = true;
    }
    for (const f of allowed) await this.tab.pagelib(f.key, "hideOverlay", [true]).catch(() => {});
    try {
      const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: plan.captureBeyondViewport, ...(format === "jpeg" ? { quality: o.quality ?? 80 } : {}), ...(plan.clip ? { clip: plan.clip } : {}) };
      const r = await this.tab.guard(this.tab.send<{ data: string }>("Page.captureScreenshot", params));
      return { mime: `image/${format}`, dataBase64: r.data, width: plan.width, height: plan.height, ...(plan.note ? { note: plan.note } : {}) };
    } finally {
      for (const f of allowed) await this.tab.pagelib(f.key, "hideOverlay", [false]).catch(() => {});
      if (marked) await this.tab.pagelib(this.tab.mainKey(), "clearOverlay", []).catch(() => {});
    }
  }

  evaluator(): (expression: string) => Promise<unknown> {
    let ctx: number | undefined;
    const worldName = `tabagent-wait-${++waitWorldSeq}`;
    return async (expression: string) => {
      await this.tab.ensure();
      this.tab.assertNoDialog();
      if (ctx == null) {
        const w = await this.tab.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: this.tab.mainFrameId, worldName, grantUniveralAccess: false });
        ctx = w.executionContextId;
      }
      let r: any;
      try {
        r = await this.tab.send<any>("Runtime.evaluate", { expression, contextId: ctx, awaitPromise: true, returnByValue: true, replMode: true });
      } catch (e) {
        ctx = undefined; // the document went away with its world
        throw e;
      }
      if (r.exceptionDetails) throw taErr("BAD_REQUEST", `Evaluation failed: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}`, undefined, { pageText: true });
      return r.result?.value;
    };
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
    baselines.clearTab(this.tabId);
    const r = await this.tab.guard(this.tab.send<any>("Page.navigate", { url, transitionType: "typed" }));
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") throw taErr("BAD_REQUEST", `Navigation failed: ${r.errorText}`);
    let warning: string | undefined;
    if (r.loaderId && waitUntil !== "none") {
      const names = waitUntil === "domcontentloaded" ? ["DOMContentLoaded", "load"] : ["load"];
      const ok = await this.tab.guard(this.waitLifecycle(r.loaderId, names, timeout));
      if (!ok) warning = `Timed out after ${timeout}ms waiting for ${waitUntil}; the page may still be loading.`;
      else if (waitUntil === "networkidle") {
        if (!(await this.tab.networkIdle(500, timeout))) warning = "Network did not go idle before timeout.";
      }
    }
    await this.clock.sleep(50);
    return { url: await this.currentUrl(), ...(warning ? { warning } : {}) };
  }

  async history(action: "back" | "forward" | "reload", timeout: number) {
    await this.tab.ensure();
    this.tab.assertNoDialog();
    baselines.clearTab(this.tabId);
    const before = this.tab.navEpoch;
    if (action === "reload") await this.tab.send("Page.reload", {});
    else {
      const h = await this.tab.send<any>("Page.getNavigationHistory", {});
      const idx = h.currentIndex + (action === "back" ? -1 : 1);
      const entry = h.entries[idx];
      if (!entry) throw taErr("BAD_REQUEST", `No ${action} history entry`);
      await this.tab.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    await this.settle(before, timeout);
  }

  async waitLoad(timeout: number) {
    const end = this.clock.now() + timeout;
    while (this.clock.now() < end) {
      try {
        const rs = await this.tab.evalMain("document.readyState");
        if (rs === "complete") return true;
      } catch (e) {
        if (e instanceof TabAgentError && ["DIALOG_OPEN", "DEBUGGER_DETACHED"].includes(e.code as string)) throw e;
      }
      await this.clock.sleep(100);
    }
    return false;
  }

  networkIdle(quiet: number, timeout: number) {
    return this.tab.networkIdle(quiet, timeout);
  }

  async quiet() {
    await this.tab.pagelib(this.tab.mainKey(), "quietDom", [100, 1000]).catch(() => {});
  }

  /** After an action: wait for any navigation it triggered, then a short network quiet period. */
  async settle(beforeEpoch: number, timeout = 5000) {
    await this.clock.sleep(120);
    if (this.tab.dialog) return;
    if (this.tab.navEpoch !== beforeEpoch) {
      const end = this.clock.now() + timeout;
      while (this.clock.now() < end) {
        const mf = this.tab.mainFrameId;
        const lastStart = [...this.tab.lifecycle].reverse().find((e) => !e.sessionId && e.frameId === mf && e.name === "init");
        if (lastStart && this.tab.lifecycle.some((e) => !e.sessionId && e.loaderId === lastStart.loaderId && e.name === "load")) break;
        if (this.tab.dialog) return;
        await this.clock.sleep(50);
      }
    }
    await this.tab.networkIdle(300, 1500);
  }

  dialog(): DialogInfo | null {
    const d = this.tab.dialog;
    return d ? { type: d.type, message: d.message, ...(d.defaultPrompt !== undefined ? { defaultPrompt: d.defaultPrompt } : {}) } : null;
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
