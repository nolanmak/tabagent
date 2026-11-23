// #21 Lite driver: no chrome.debugger. pagelib runs as a content script; its
// DOM walker emits AX-shaped nodes that the same pure renderer turns into the
// same text format, and refs come from the same table (`e<N>`), keyed by the
// content script's element ids and document id. Input is synthetic
// (isTrusted=false), so hover/drag/dblclick are "degraded".
import { autoWait, type Observation } from "./autowait";
import { staleRef, taErr } from "./errors";
import type { ClickOpts, DialogInfo, Driver, FrameCall, Screenshot, ScreenshotOpts, SnapshotOpts } from "./driver";
import type { RefTable, RefTarget } from "./refs";
import { render, type AXNode, type RenderResult } from "./snapshot";
import { capMatches, type FindSpec } from "./wait";

export const LITE_FRAME = "lite|0";

type LiteResult = { value?: unknown; ids?: number[]; stale?: string; docId?: string };

/** Everything the lite driver needs from Chrome; faked in unit tests. */
export interface LiteEnv {
  /** Run `func(...args)` in the tab's top frame content-script world. */
  exec<T>(func: (...a: any[]) => T, args: unknown[]): Promise<Awaited<T>>;
  /** Install pagelib if missing. */
  ensureLib(): Promise<void>;
  tab(): Promise<{ url: string; title: string; active: boolean; windowId: number; status?: string }>;
  navigate(url: string, timeout: number): Promise<boolean>;
  history(action: "back" | "forward" | "reload", timeout: number): Promise<boolean>;
  captureVisible(windowId: number, format: "png" | "jpeg", quality?: number): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function unsupported(what: string) {
  return taErr("UNSUPPORTED", `${what} is not available in lite mode`, "Lite mode avoids chrome.debugger. Turn lite mode off for this site in the TabAgent side panel to use full mode.");
}

export function chromeLiteEnv(tabId: number): LiteEnv {
  const waitComplete = (timeout: number) =>
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(l);
        resolve(false);
      }, timeout);
      const l = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === "complete") {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(l);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(l);
    });
  const env: LiteEnv = {
    async exec(func, args) {
      const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: func as any, args: args as any[] });
      return r?.result as any;
    },
    async ensureLib() {
      const has = await env.exec(() => !!(globalThis as any).__ta, []);
      if (!has) await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["pagelib.js"] });
    },
    async tab() {
      const t = await chrome.tabs.get(tabId);
      return { url: t.url ?? "", title: t.title ?? "", active: !!t.active, windowId: t.windowId, status: t.status };
    },
    async navigate(url, timeout) {
      const p = waitComplete(timeout);
      await chrome.tabs.update(tabId, { url });
      return p;
    },
    async history(action, timeout) {
      const p = waitComplete(timeout);
      if (action === "reload") await chrome.tabs.reload(tabId);
      else if (action === "back") await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);
      return p;
    },
    async captureVisible(windowId, format, quality) {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format, ...(format === "jpeg" ? { quality: quality ?? 80 } : {}) });
      return url.split(",")[1];
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return env;
}

export class LiteDriver implements Driver {
  kind = "lite" as const;
  private epoch = 0;
  private docId = "";

  constructor(
    public tabId: number,
    private refs: RefTable,
    private env: LiteEnv = chromeLiteEnv(tabId),
  ) {}

  dispose() {}

  private async run(fn: string, args: unknown[], id: number | null = null, docId: string | null = null): Promise<LiteResult> {
    await this.env.ensureLib();
    const r = (await this.env.exec((n: string, i: number | null, d: string | null, a: unknown[]) => (globalThis as any).__ta.callLite(null, n, i, d, a), [fn, id, docId, args])) as LiteResult;
    if (r?.docId && r.docId !== this.docId) {
      // a new document: refs from the old one are stale (D22)
      if (this.docId) {
        this.refs.drop((t) => t.tabId === this.tabId && t.frameKey === LITE_FRAME && t.loaderId !== r.docId);
        this.epoch++;
      }
      this.docId = r.docId;
    }
    return r ?? {};
  }

  async resolveRef(ref: string): Promise<RefTarget> {
    return this.refs.resolve(ref, this.tabId);
  }

  private mapIds(value: unknown, ids: number[] = []) {
    const refs = ids.map((id) => (id > 0 ? this.refs.mint({ tabId: this.tabId, frameKey: LITE_FRAME, backendNodeId: id, loaderId: this.docId }) : null));
    return mapEls(value, refs);
  }

  async call(fn: string, args: unknown[], o: { ref?: string } = {}) {
    let id: number | null = null;
    let doc: string | null = null;
    if (o.ref) {
      const t = await this.resolveRef(o.ref);
      id = t.backendNodeId;
      doc = t.loaderId;
    }
    const r = await this.run(fn, args, id, doc);
    if (r.stale) {
      if (o.ref) this.refs.drop((_t, ref) => ref === o.ref);
      throw staleRef(o.ref ?? "", r.stale === "navigated" ? "the page navigated" : "the element is no longer in the page");
    }
    return this.mapIds(r.value, r.ids);
  }

  async callAllFrames(fn: string, args: unknown[]): Promise<FrameCall[]> {
    const t = await this.env.tab();
    return [{ frameKey: LITE_FRAME, url: t.url, isMain: true, value: await this.call(fn, args) }];
  }

  async snapshot(o: SnapshotOpts): Promise<RenderResult> {
    let rootId: number | null = null;
    let doc: string | null = null;
    if (o.root) {
      const t = await this.resolveRef(o.root);
      rootId = t.backendNodeId;
      doc = t.loaderId;
    }
    const r = await this.run("domAxTree", [], rootId, doc);
    if (r.stale) throw staleRef(o.root ?? "", "the page changed");
    const v = r.value as { nodes: AXNode[]; sensitive: number[]; docId: string };
    await this.refs.reserve(v.nodes.length + 1);
    const loaderId = this.docId;
    return render([{ key: LITE_FRAME, nodes: v.nodes, sensitive: v.sensitive }], {
      mode: o.mode,
      maxTokens: o.maxTokens,
      collapse: o.collapse,
      refs: {
        peek: (fk, b) => this.refs.peek({ tabId: this.tabId, frameKey: fk, backendNodeId: b, loaderId }),
        mint: (fk, b) => this.refs.mint({ tabId: this.tabId, frameKey: fk, backendNodeId: b, loaderId }),
        nextNumber: () => this.refs.peekNext(),
      },
    });
  }

  async find(spec: FindSpec) {
    const v = (await this.call("findNodes", [{ by: spec.by, value: spec.value, name: spec.name, limit: 20 }], spec.root ? { ref: spec.root } : {})) as { matches: { ref: string | null; role: string; name: string }[] };
    return capMatches([v.matches.filter((m) => m.ref).map((m) => ({ ref: m.ref!, role: m.role, name: m.name }))]);
  }

  private async wait(ref: string, timeout?: number, needEditable = false) {
    const t = await this.resolveRef(ref);
    return autoWait(
      ref,
      {
        now: () => this.env.now(),
        sleep: (ms) => this.env.sleep(ms),
        observe: async (scroll) => {
          const r = await this.run("observe", [{ scroll }], t.backendNodeId, t.loaderId);
          if (r.stale) return { attached: false, visible: false, enabled: false, box: null, inView: false } as Observation;
          return r.value as Observation;
        },
      },
      { timeout, needEditable },
    );
  }

  async click(ref: string, o: ClickOpts = {}) {
    await this.wait(ref, o.timeout);
    await this.call("syntheticClick", [{ button: o.button === "right" ? 2 : o.button === "middle" ? 1 : 0, clickCount: o.clickCount }], { ref });
    return {};
  }
  async hover(ref: string, timeout?: number) {
    await this.wait(ref, timeout);
    await this.call("syntheticHover", [], { ref });
  }
  async focus(ref: string, end = true) {
    await this.call("focus", [{ end }], { ref });
  }
  async prepareInput(ref: string, timeout?: number) {
    await this.wait(ref, timeout, true);
  }
  async typeText(text: string) {
    await this.call("syntheticType", [text]);
    return {};
  }
  async press(chord: string) {
    await this.call("syntheticKey", [chord]);
    return {};
  }
  async fill(ref: string, value: string, timeout?: number) {
    await this.wait(ref, timeout, true);
    await this.call("setValue", [value], { ref });
  }
  async scroll(ref: string | undefined, dx: number, dy: number) {
    if (ref && !dx && !dy) return this.call("scrollIntoView", [], { ref });
    return this.call("scrollBy", [dx, dy], ref ? { ref } : {});
  }
  async drag(from: string, to: string, timeout?: number) {
    await this.wait(from, timeout);
    await this.wait(to, timeout);
    const dst = await this.resolveRef(to);
    await this.call("syntheticDragTo", [dst.backendNodeId], { ref: from });
  }
  async upload(): Promise<void> {
    throw unsupported("act.upload");
  }
  async screenshot(o: ScreenshotOpts): Promise<Screenshot> {
    const target = o.target ?? (o.ref ? "ref" : "viewport");
    if (target !== "viewport" || o.marks) throw unsupported(target === "viewport" ? "Set-of-marks screenshots" : `${target === "full" ? "Full-page" : "Element"} screenshots`);
    const t = await this.env.tab();
    // D10: never bring a tab to the front; captureVisibleTab only sees the visible tab.
    if (!t.active) throw taErr("UNSUPPORTED", "Lite mode can only screenshot the tab while it is the visible tab in its window", "TabAgent never focuses tabs. Use full mode for background screenshots.");
    const fmt = o.format ?? "png";
    const data = await this.env.captureVisible(t.windowId, fmt, o.quality);
    const dims = (await this.env.exec(() => ({ w: innerWidth, h: innerHeight }), [])) as { w: number; h: number } | undefined;
    return { mime: `image/${fmt}`, dataBase64: data, width: dims?.w ?? 0, height: dims?.h ?? 0 };
  }
  async evaluate(): Promise<unknown> {
    throw unsupported("js.eval");
  }
  navEpoch() {
    return this.epoch;
  }
  async currentUrl() {
    return (await this.env.tab()).url;
  }
  async navigate(url: string, _w: string, timeout: number) {
    const ok = await this.env.navigate(url, timeout);
    return { url: await this.currentUrl(), ...(ok ? {} : { warning: "Timed out waiting for load" }) };
  }
  async history(action: "back" | "forward" | "reload", timeout: number) {
    await this.env.history(action, timeout);
  }
  async waitLoad(timeout: number) {
    const end = this.env.now() + timeout;
    while (this.env.now() < end) {
      if ((await this.env.tab()).status === "complete") return true;
      await this.env.sleep(100);
    }
    return false;
  }
  async networkIdle(): Promise<boolean> {
    // degraded: no network visibility without the debugger
    await this.env.sleep(500);
    return true;
  }
  async quiet() {
    await this.run("quietDom", [100, 1000]).catch(() => {});
  }
  async settle(_before: number, timeout = 5000) {
    await this.env.sleep(200);
    const end = this.env.now() + timeout;
    while (this.env.now() < end && (await this.env.tab()).status !== "complete") await this.env.sleep(100);
    // refresh the document id: a new one means the action navigated
    await this.run("docId", []).catch(() => {});
  }
  dialog(): DialogInfo | null {
    return null;
  }
  async handleDialog(): Promise<unknown> {
    throw unsupported("dialog.handle");
  }
}

function mapEls(v: unknown, refs: (string | null)[]): unknown {
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
