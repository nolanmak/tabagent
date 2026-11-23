// chrome.debugger wrapper: one CdpTab per attached tab. Tracks child (OOPIF)
// sessions, network, console, dialogs, navigation lifecycle and isolated worlds.
import { TabAgentError } from "@tabagent/protocol";
import { taErr } from "./errors";
import { getSettings } from "./settings";

declare const PAGELIB_SRC: string;

export interface NetEntry {
  requestId: string;
  sessionId?: string;
  frameId?: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  failed?: string;
  finished?: boolean;
  ts: number;
  encodedDataLength?: number;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  ts: number;
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
  sessionId?: string;
}

export interface FrameInfo {
  key: string; // `${sessionId}|${frameId}`
  sessionId?: string;
  frameId: string;
  parentKey?: string;
  url: string;
  ownerBackendNodeId?: number;
  /** Current document's loaderId (D22 ref staleness). */
  loaderId?: string;
}

type Waiter = { pred: (method: string, params: any, sessionId?: string) => boolean; resolve: (v: any) => void };

const tabs = new Map<number, CdpTab>();

export function getCdpTab(tabId: number): CdpTab {
  let t = tabs.get(tabId);
  if (!t) {
    t = new CdpTab(tabId);
    tabs.set(tabId, t);
  }
  return t;
}

export function peekCdpTab(tabId: number): CdpTab | undefined {
  return tabs.get(tabId);
}

export function allCdpTabs(): CdpTab[] {
  return [...tabs.values()];
}

export async function detachTab(tabId: number) {
  const t = tabs.get(tabId);
  tabs.delete(tabId);
  if (t?.attached) {
    t.attached = false;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

/** The user cancelled the debugging bar earlier; they resumed the tab in the side panel (D27). */
export function resumeDebugger(tabId: number) {
  const t = tabs.get(tabId);
  if (t) t.userDetached = false;
}

/** Tabs the user stopped by cancelling the debugging bar. */
export function stoppedTabs(): number[] {
  return [...tabs.values()].filter((t) => t.userDetached).map((t) => t.tabId);
}

export async function detachAll() {
  for (const id of [...tabs.keys()]) await detachTab(id);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const t = tabs.get(source.tabId);
  t?.onEvent(method, params as any, (source as { sessionId?: string }).sessionId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  const t = tabs.get(source.tabId);
  if (t) {
    t.attached = false;
    t.contexts.clear();
    t.children.clear();
    t.loaders.clear();
    if (reason === "canceled_by_user") t.userDetached = true;
    t.fireDetached(String(reason));
  }
});

export class CdpTab {
  attached = false;
  userDetached = false;
  attaching: Promise<void> | null = null;
  children = new Map<string, { targetId: string; url: string }>(); // sessionId -> target
  contexts = new Map<string, number>(); // frameKey -> isolated contextId
  network = new Map<string, NetEntry>();
  consoleLog: ConsoleEntry[] = [];
  dialog: DialogInfo | null = null;
  inflight = new Map<string, number>(); // key -> start ts
  lastNetActivity = Date.now();
  navEpoch = 0;
  lifecycle: { frameId: string; loaderId: string; name: string; sessionId?: string }[] = [];
  mainFrameId: string | null = null;
  url = "";
  waiters = new Set<Waiter>();
  dragData: unknown = null;
  /** frameKey -> current loaderId */
  loaders = new Map<string, string>();
  private detachHandlers = new Set<(reason: string) => void>();
  private navHandlers = new Set<(url: string) => void>();

  constructor(public tabId: number) {}

  /** Called when the debugger detaches (user cancelled the bar, tab closed, ...). */
  onDetached(fn: (reason: string) => void): () => void {
    this.detachHandlers.add(fn);
    return () => this.detachHandlers.delete(fn);
  }
  fireDetached(reason: string) {
    for (const f of [...this.detachHandlers]) f(reason);
  }
  /** Main-frame cross-document navigation. */
  onNavigated(fn: (url: string) => void): () => void {
    this.navHandlers.add(fn);
    return () => this.navHandlers.delete(fn);
  }

  detachedError() {
    return taErr("DEBUGGER_DETACHED", "The user cancelled debugging on this tab (Chrome's debugging bar).", "Ask the user to resume the tab in the TabAgent side panel, or open a new tab with tabs action=new.");
  }

  /** Reject when the user cancels the debugging bar while `p` runs (D27). */
  guard<T>(p: Promise<T>): Promise<T> {
    if (this.userDetached) return Promise.reject(this.detachedError());
    let off: () => void = () => {};
    const det = new Promise<never>((_r, reject) => {
      off = this.onDetached((reason) => {
        if (reason === "canceled_by_user") reject(this.detachedError());
      });
    });
    return Promise.race([p, det]).finally(off);
  }

  async ensure(): Promise<void> {
    if (this.userDetached) throw this.detachedError();
    if (this.attached) return;
    if (this.attaching) return this.attaching;
    this.attaching = this.doAttach().finally(() => (this.attaching = null));
    return this.attaching;
  }

  private async doAttach() {
    const target = { tabId: this.tabId };
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/already attached/i.test(msg)) {
        // Possibly a stale attachment from a previous service-worker life.
        await chrome.debugger.detach(target).catch(() => {});
        await chrome.debugger.attach(target, "1.3");
      } else if (/Cannot access|Cannot attach/i.test(msg)) {
        throw new TabAgentError("PERMISSION_DENIED", `Cannot debug this tab: ${msg}`, "Restricted pages (chrome://, Web Store) are off-limits.");
      } else throw e;
    }
    this.attached = true;
    this.contexts.clear();
    this.children.clear();
    await this.enableDomains(undefined);
    const tree = await this.send<any>("Page.getFrameTree", {});
    this.mainFrameId = tree.frameTree.frame.id;
    this.url = tree.frameTree.frame.url;
    this.loaders.set(`|${this.mainFrameId}`, tree.frameTree.frame.loaderId);
  }

  private async enableDomains(sessionId?: string) {
    await Promise.all([
      this.send("Page.enable", {}, sessionId),
      this.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
      this.send("Runtime.enable", {}, sessionId),
      this.send("Network.enable", {}, sessionId),
      this.send("DOM.enable", {}, sessionId),
      this.send("Log.enable", {}, sessionId).catch(() => {}),
    ]);
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
    await this.send("DOM.getDocument", { depth: 0 }, sessionId).catch(() => {});
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const target: chrome.debugger.DebuggerSession = sessionId ? ({ tabId: this.tabId, sessionId } as chrome.debugger.DebuggerSession) : { tabId: this.tabId };
    try {
      return (await chrome.debugger.sendCommand(target, method, params)) as T;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/not attached|Detached while handling/i.test(msg)) this.attached = false;
      if (this.userDetached) throw this.detachedError();
      throw new Error(`${method}: ${msg}`);
    }
  }

  onEvent(method: string, p: any, sessionId?: string) {
    for (const w of [...this.waiters]) {
      try {
        if (w.pred(method, p, sessionId)) {
          this.waiters.delete(w);
          w.resolve({ method, params: p, sessionId });
        }
      } catch {
        /* ignore */
      }
    }
    switch (method) {
      case "Target.attachedToTarget": {
        const sid = p.sessionId as string;
        this.children.set(sid, { targetId: p.targetInfo.targetId, url: p.targetInfo.url });
        // The frame's document request was handed to the new process; stop waiting on it here.
        for (const [k] of this.inflight) if (this.network.get(k)?.frameId === p.targetInfo.targetId) this.inflight.delete(k);
        if (p.targetInfo.type === "iframe" || p.targetInfo.type === "page") this.enableDomains(sid).catch(() => {});
        else this.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
        break;
      }
      case "Target.detachedFromTarget":
        this.children.delete(p.sessionId);
        for (const k of [...this.loaders.keys()]) if (k.startsWith(p.sessionId + "|")) this.loaders.delete(k);
        for (const k of [...this.contexts.keys()]) if (k.startsWith(p.sessionId + "|")) this.contexts.delete(k);
        break;
      case "Page.frameNavigated":
        this.loaders.set(`${sessionId ?? ""}|${p.frame.id}`, p.frame.loaderId);
        if (!p.frame.parentId && !sessionId) {
          this.mainFrameId = p.frame.id;
          this.url = p.frame.url + (p.frame.urlFragment ?? "");
          for (const f of [...this.navHandlers]) f(this.url);
        }
        this.contexts.delete(`${sessionId ?? ""}|${p.frame.id}`);
        break;
      case "Page.frameDetached":
        this.loaders.delete(`${sessionId ?? ""}|${p.frameId}`);
        break;
      case "Page.navigatedWithinDocument":
        if (!sessionId && p.frameId === this.mainFrameId) this.url = p.url;
        break;
      case "Page.frameStartedLoading":
        if (!sessionId && p.frameId === this.mainFrameId) this.navEpoch++;
        break;
      case "Page.lifecycleEvent":
        this.lifecycle.push({ frameId: p.frameId, loaderId: p.loaderId, name: p.name, sessionId });
        if (this.lifecycle.length > 100) this.lifecycle.splice(0, 50);
        break;
      case "Runtime.executionContextsCleared":
        for (const k of [...this.contexts.keys()]) if (k.startsWith(`${sessionId ?? ""}|`)) this.contexts.delete(k);
        break;
      case "Runtime.executionContextDestroyed":
        for (const [k, v] of this.contexts) if (v === p.executionContextId && k.startsWith(`${sessionId ?? ""}|`)) this.contexts.delete(k);
        break;
      case "Runtime.consoleAPICalled":
        this.pushConsole({
          level: p.type,
          text: (p.args ?? []).map((a: any) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description ?? a.unserializableValue ?? a.type))).join(" "),
          url: p.stackTrace?.callFrames?.[0]?.url,
          ts: Date.now(),
        });
        break;
      case "Runtime.exceptionThrown":
        this.pushConsole({ level: "error", text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception", url: p.exceptionDetails?.url, ts: Date.now() });
        break;
      case "Log.entryAdded":
        this.pushConsole({ level: p.entry.level, text: p.entry.text, url: p.entry.url, ts: Date.now() });
        break;
      case "Network.requestWillBeSent": {
        const key = `${sessionId ?? ""}:${p.requestId}`;
        const prev = this.network.get(key);
        this.network.set(key, {
          requestId: p.requestId,
          sessionId,
          frameId: p.frameId,
          url: p.request.url,
          method: p.request.method,
          resourceType: p.type,
          requestHeaders: p.request.headers,
          postData: p.request.postData?.slice(0, 10000),
          ts: Date.now(),
          ...(prev && p.redirectResponse ? {} : {}),
        });
        if (this.network.size > 400) {
          const first = this.network.keys().next().value!;
          this.network.delete(first);
        }
        if (!["EventSource", "WebSocket", "Ping"].includes(p.type)) this.inflight.set(key, Date.now());
        this.lastNetActivity = Date.now();
        break;
      }
      case "Network.responseReceived": {
        if (p.type === "Document") {
          // An OOPIF's document request is announced in the parent session but answered in the child.
          for (const [k] of this.inflight) {
            const ne = this.network.get(k);
            if (ne && ne.resourceType === "Document" && ne.url === p.response.url && k !== `${sessionId ?? ""}:${p.requestId}`) this.inflight.delete(k);
          }
        }
        const e = this.network.get(`${sessionId ?? ""}:${p.requestId}`);
        if (e) {
          e.status = p.response.status;
          e.statusText = p.response.statusText;
          e.mimeType = p.response.mimeType;
          e.responseHeaders = p.response.headers;
          e.resourceType = p.type ?? e.resourceType;
        }
        this.lastNetActivity = Date.now();
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const key = `${sessionId ?? ""}:${p.requestId}`;
        const e = this.network.get(key);
        if (e) {
          e.finished = true;
          if (method === "Network.loadingFailed") e.failed = p.errorText;
          e.encodedDataLength = p.encodedDataLength;
        }
        this.inflight.delete(key);
        // OOPIF document requests start in the parent session and finish in the child.
        for (const k of [...this.inflight.keys()]) if (k.endsWith(`:${p.requestId}`)) this.inflight.delete(k);
        this.lastNetActivity = Date.now();
        break;
      }
      case "Page.javascriptDialogOpening":
        this.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url, sessionId };
        if (p.type === "beforeunload") {
          getSettings().then((s) => {
            if (s.autoAcceptBeforeUnload) this.handleDialog(true).catch(() => {});
          });
        }
        break;
      case "Page.javascriptDialogClosed":
        this.dialog = null;
        break;
      case "Input.dragIntercepted":
        this.dragData = p.data;
        break;
    }
  }

  private pushConsole(e: ConsoleEntry) {
    this.consoleLog.push(e);
    if (this.consoleLog.length > 300) this.consoleLog.splice(0, 100);
  }

  waitEvent(pred: Waiter["pred"], timeoutMs: number): Promise<{ method: string; params: any; sessionId?: string } | null> {
    return new Promise((resolve) => {
      const w: Waiter = { pred, resolve };
      this.waiters.add(w);
      setTimeout(() => {
        if (this.waiters.delete(w)) resolve(null);
      }, timeoutMs);
    });
  }

  async handleDialog(accept: boolean, promptText?: string) {
    if (!this.dialog) throw new TabAgentError("NOT_FOUND", "No dialog is open");
    const sid = this.dialog.sessionId;
    await this.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }, sid);
    const d = this.dialog;
    this.dialog = null;
    return d;
  }

  assertNoDialog() {
    if (this.dialog) {
      throw taErr("DIALOG_OPEN", `A ${this.dialog.type} dialog is open: "${this.dialog.message.slice(0, 200)}"`, "Call dialog.handle with accept=true|false first.", { pageText: true });
    }
  }

  /** Wait until no tracked requests are in flight for `quietMs`. */
  async networkIdle(quietMs = 500, timeoutMs = 5000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      // ignore requests stuck for > 10s (long-poll, streaming)
      const now = Date.now();
      for (const [k, t] of this.inflight) if (now - t > 10_000) this.inflight.delete(k);
      if (this.inflight.size === 0 && now - this.lastNetActivity >= quietMs) return true;
      await sleep(50);
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Frames + isolated worlds
  // ---------------------------------------------------------------------
  async frames(): Promise<FrameInfo[]> {
    await this.ensure();
    const out: FrameInfo[] = [];
    const childByTarget = new Map<string, string>();
    for (const [sid, c] of this.children) childByTarget.set(c.targetId, sid);
    const visit = async (sessionId: string | undefined, node: any, parentKey?: string, isRootOfSession = false) => {
      const fid = node.frame.id as string;
      let sid = sessionId;
      let key: string;
      if (!isRootOfSession && childByTarget.has(fid)) {
        // Out-of-process iframe: owned by a child session.
        const childSid = childByTarget.get(fid)!;
        let owner: number | undefined;
        try {
          owner = (await this.send<any>("DOM.getFrameOwner", { frameId: fid }, sessionId)).backendNodeId;
        } catch {
          /* ignore */
        }
        let childTree: any;
        try {
          childTree = (await this.send<any>("Page.getFrameTree", {}, childSid)).frameTree;
        } catch {
          return;
        }
        key = `${childSid}|${fid}`;
        out.push({ key, sessionId: childSid, frameId: fid, parentKey, url: childTree.frame.url, ownerBackendNodeId: owner, loaderId: childTree.frame.loaderId });
        for (const ch of childTree.childFrames ?? []) await visit(childSid, ch, key);
        return;
      }
      key = `${sid ?? ""}|${fid}`;
      let owner: number | undefined;
      if (parentKey) {
        try {
          owner = (await this.send<any>("DOM.getFrameOwner", { frameId: fid }, sid)).backendNodeId;
        } catch {
          /* ignore */
        }
      }
      out.push({ key, sessionId: sid, frameId: fid, parentKey, url: node.frame.url, ownerBackendNodeId: owner, loaderId: node.frame.loaderId });
      for (const ch of node.childFrames ?? []) await visit(sid, ch, key);
    };
    const tree = (await this.send<any>("Page.getFrameTree", {})).frameTree;
    this.mainFrameId = tree.frame.id;
    await visit(undefined, tree, undefined, true);
    // Out-of-process iframes are not listed in the parent's frame tree: add each
    // child session, locating its owner <iframe> and the frame that contains it.
    const seen = new Set(out.map((f) => f.frameId));
    let progress = true;
    while (progress) {
      progress = false;
      for (const [childSid, c] of this.children) {
        if (seen.has(c.targetId)) continue;
        let childTree: any;
        try {
          childTree = (await this.send<any>("Page.getFrameTree", {}, childSid)).frameTree;
        } catch {
          continue;
        }
        // owner lives in some already-known session
        const sessions = [undefined, ...new Set(out.map((f) => f.sessionId).filter(Boolean))] as (string | undefined)[];
        let owner: number | undefined;
        let ownerSid: string | undefined;
        for (const sid of sessions) {
          try {
            owner = (await this.send<any>("DOM.getFrameOwner", { frameId: c.targetId }, sid)).backendNodeId;
            ownerSid = sid;
            break;
          } catch {
            /* not in this session */
          }
        }
        if (owner == null) continue;
        let parentKey: string | undefined;
        for (const f of out.filter((x) => x.sessionId === ownerSid)) {
          try {
            const ctx = await this.isolatedContext(f.key);
            await this.send("DOM.resolveNode", { backendNodeId: owner, executionContextId: ctx }, ownerSid);
            parentKey = f.key;
            break;
          } catch {
            /* owner not in this frame */
          }
        }
        const key = `${childSid}|${c.targetId}`;
        out.push({ key, sessionId: childSid, frameId: c.targetId, parentKey: parentKey ?? out[0].key, url: childTree.frame.url, ownerBackendNodeId: owner, loaderId: childTree.frame.loaderId });
        seen.add(c.targetId);
        for (const ch of childTree.childFrames ?? []) await visit(childSid, ch, key);
        progress = true;
      }
    }
    for (const f of out) if (f.loaderId) this.loaders.set(f.key, f.loaderId);
    return out;
  }

  mainKey(): string {
    return `|${this.mainFrameId}`;
  }

  async isolatedContext(frameKey: string): Promise<number> {
    const cached = this.contexts.get(frameKey);
    if (cached) return cached;
    const [sid, frameId] = splitKey(frameKey);
    const r = await this.send<any>("Page.createIsolatedWorld", { frameId, worldName: "__tabagent__", grantUniveralAccess: false }, sid);
    const ctx = r.executionContextId as number;
    await this.send("Runtime.evaluate", { expression: PAGELIB_SRC, contextId: ctx, returnByValue: true, silent: true }, sid);
    this.contexts.set(frameKey, ctx);
    return ctx;
  }

  /**
   * Call a pagelib function in a frame (optionally with `self` = backendNodeId element).
   * Returns { value, nodes } where nodes are backendNodeIds of returned elements.
   */
  async pagelib(frameKey: string, name: string, args: unknown[], selfNode?: number, extraNodes: number[] = [], attempt = 0): Promise<{ value: any; nodes: number[] }> {
    this.assertNoDialog();
    const [sid] = splitKey(frameKey);
    try {
      const ctx = await this.isolatedContext(frameKey);
      let objectId: string | undefined;
      const argObjs: { objectId: string }[] = [];
      if (selfNode != null) {
        try {
          objectId = (await this.send<any>("DOM.resolveNode", { backendNodeId: selfNode, executionContextId: ctx, objectGroup: "ta" }, sid)).object.objectId;
        } catch {
          throw new TabAgentError("REF_STALE", "Element is no longer in the page", "Take a new page.snapshot and use fresh refs.");
        }
      }
      for (const n of extraNodes) {
        const o = (await this.send<any>("DOM.resolveNode", { backendNodeId: n, executionContextId: ctx, objectGroup: "ta" }, sid)).object.objectId;
        argObjs.push({ objectId: o });
      }
      const fn = `async function(__n, __a, ...__els){ const s = (typeof Element !== 'undefined' && this instanceof Element) ? this : null; return await globalThis.__ta.invoke(s, __n, [...__a, ...__els]); }`;
      const callArgs = [{ value: name }, { value: args }, ...argObjs];
      const r = await this.send<any>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: fn,
          ...(objectId ? { objectId } : { executionContextId: ctx }),
          arguments: callArgs,
          returnByValue: false,
          awaitPromise: true,
          objectGroup: "ta",
          userGesture: true,
        },
        sid,
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
        throw new Error(String(d).split("\n")[0]);
      }
      const resId = r.result.objectId as string;
      const val = await this.send<any>(
        "Runtime.callFunctionOn",
        { functionDeclaration: "function(){ return { v: this.value, n: this.elements.length }; }", objectId: resId, returnByValue: true, objectGroup: "ta" },
        sid,
      );
      const { v, n } = val.result.value as { v: unknown; n: number };
      const nodes: number[] = [];
      if (n > 0) {
        const arr = await this.send<any>("Runtime.callFunctionOn", { functionDeclaration: "function(){ return this.elements; }", objectId: resId, returnByValue: false, objectGroup: "ta" }, sid);
        const props = await this.send<any>("Runtime.getProperties", { objectId: arr.result.objectId, ownProperties: true }, sid);
        const byIdx: Record<number, string> = {};
        for (const p of props.result) if (/^\d+$/.test(p.name) && p.value?.objectId) byIdx[+p.name] = p.value.objectId;
        for (let i = 0; i < n; i++) {
          const oid = byIdx[i];
          if (!oid) {
            nodes.push(-1);
            continue;
          }
          const d = await this.send<any>("DOM.describeNode", { objectId: oid }, sid);
          nodes.push(d.node.backendNodeId);
        }
      }
      this.send("Runtime.releaseObjectGroup", { objectGroup: "ta" }, sid).catch(() => {});
      return { value: v, nodes };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (attempt < 2 && /Cannot find context|context with specified id|Execution context was destroyed|Inspected target navigated|No frame with given id|Cannot find execution context/i.test(msg)) {
        this.contexts.delete(frameKey);
        await sleep(100);
        return this.pagelib(frameKey, name, args, selfNode, extraNodes, attempt + 1);
      }
      throw e;
    }
  }

  /** Evaluate in the main world of the top frame. */
  async evalMain(expression: string, awaitPromise = true): Promise<any> {
    this.assertNoDialog();
    const r = await this.send<any>("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true, replMode: true });
    if (r.exceptionDetails) {
      throw new TabAgentError("BAD_REQUEST", `Evaluation failed: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}`);
    }
    return r.result.value ?? (r.result.unserializableValue ? r.result.unserializableValue : r.result.type === "undefined" ? undefined : r.result.description);
  }
}

export function splitKey(key: string): [string | undefined, string] {
  const i = key.indexOf("|");
  const sid = key.slice(0, i);
  return [sid || undefined, key.slice(i + 1)];
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
