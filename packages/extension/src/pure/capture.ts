// Network + console capture (D35, #17). Fed raw CDP events; holds per-tab ring
// buffers. Pure: no chrome.*; the body fetcher is injected.
import { TabAgentError } from "@tabagent/protocol";
import { RingBuffer } from "./ringbuffer";

export const NET_CAPACITY = 500;
export const CONSOLE_CAPACITY = 200;
export const BODY_MAX_CHARS = 100_000;
/** network.list never returns header values or bodies: exactly these keys. */
export const LIST_KEYS = ["id", "url", "method", "status", "type", "ms", "size"] as const;

export interface NetListItem {
  id: string;
  url: string;
  method: string;
  status: number | null;
  type: string;
  ms: number | null;
  size: number | null;
}

interface NetEntry {
  id: string;
  key: string;
  requestId: string;
  sessionId?: string;
  url: string;
  method: string;
  type: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  start: number;
  end?: number;
  size?: number;
  failed?: string;
  marker?: boolean;
}

export interface ConsoleItem {
  level: string;
  text: string;
  ts: number;
}

export interface NetFilter {
  url?: string;
  method?: string;
  status?: number;
  type?: string;
  limit?: number;
}

type Waiter = { f: NetFilter; resolve: (e: NetListItem & { failed?: string }) => void };

export type BodyFetcher = (requestId: string, sessionId?: string) => Promise<{ body: string; base64Encoded?: boolean }>;

/** "/re/flags" is a regex when it has flags or metacharacters; otherwise substring. */
export function matchUrl(url: string, pattern: string): boolean {
  const m = pattern.match(/^\/(.+)\/([dimsuy]*)$/);
  if (m && (m[2] || /[\\^$.*+?()[\]{}|]/.test(m[1]))) {
    try {
      return new RegExp(m[1], m[2]).test(url);
    } catch {
      /* fall through to substring */
    }
  }
  return url.includes(pattern);
}

function argText(a: any): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return String(a.description ?? a.unserializableValue ?? a.type);
}

export class Capture {
  private net: RingBuffer<NetEntry>;
  private byKey = new Map<string, NetEntry>();
  private byId = new Map<string, NetEntry>();
  private cons: RingBuffer<ConsoleItem>;
  private seq = 0;
  private navSeq = 0;
  private waiters = new Set<Waiter>();

  constructor(
    netCapacity = NET_CAPACITY,
    consoleCapacity = CONSOLE_CAPACITY,
    private now: () => number = Date.now,
  ) {
    this.net = new RingBuffer(netCapacity, (e) => {
      this.byId.delete(e.id);
      if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
    });
    this.cons = new RingBuffer(consoleCapacity);
  }

  clear() {
    this.net.clear();
    this.cons.clear();
    this.byKey.clear();
    this.byId.clear();
  }

  private pushConsole(level: string, text: string) {
    this.cons.push({ level, text: text.length > 2000 ? text.slice(0, 2000) + "…" : text, ts: this.now() });
  }

  onEvent(method: string, p: any, sessionId?: string) {
    switch (method) {
      case "Page.frameNavigated": {
        if (sessionId || p.frame?.parentId) return;
        const url = String(p.frame.url ?? "") + (p.frame.urlFragment ?? "");
        const id = `nav${++this.navSeq}`;
        const e: NetEntry = { id, key: id, requestId: id, url, method: "NAVIGATE", type: "navigation", start: this.now(), marker: true };
        this.net.push(e);
        this.byId.set(id, e);
        this.pushConsole("marker", `navigated to ${url}`);
        return;
      }
      case "Network.requestWillBeSent": {
        const key = `${sessionId ?? ""}:${p.requestId}`;
        const prev = this.byKey.get(key);
        if (prev && p.redirectResponse) {
          prev.status = p.redirectResponse.status;
          prev.statusText = p.redirectResponse.statusText;
          prev.responseHeaders = p.redirectResponse.headers;
          prev.end = this.now();
          this.complete(prev);
        }
        const e: NetEntry = {
          id: `n${++this.seq}`,
          key,
          requestId: p.requestId,
          sessionId,
          url: p.request?.url ?? "",
          method: p.request?.method ?? "GET",
          type: p.type ?? "Other",
          requestHeaders: p.request?.headers,
          postData: typeof p.request?.postData === "string" ? p.request.postData.slice(0, 10_000) : undefined,
          start: this.now(),
        };
        this.net.push(e);
        this.byKey.set(key, e);
        this.byId.set(e.id, e);
        return;
      }
      case "Network.responseReceived": {
        const e = this.byKey.get(`${sessionId ?? ""}:${p.requestId}`);
        if (!e) return;
        e.status = p.response?.status;
        e.statusText = p.response?.statusText;
        e.mimeType = p.response?.mimeType;
        e.responseHeaders = p.response?.headers;
        if (p.type) e.type = p.type;
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const e = this.byKey.get(`${sessionId ?? ""}:${p.requestId}`);
        if (!e) return;
        e.end = this.now();
        if (typeof p.encodedDataLength === "number") e.size = p.encodedDataLength;
        if (method === "Network.loadingFailed") e.failed = p.errorText ?? "failed";
        this.complete(e);
        return;
      }
      case "Runtime.consoleAPICalled":
        this.pushConsole(p.type ?? "log", (p.args ?? []).map(argText).join(" "));
        return;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        this.pushConsole("error", String(d.exception?.description ?? d.text ?? "exception").split("\n")[0]);
        return;
      }
      case "Log.entryAdded":
        this.pushConsole(p.entry?.level ?? "info", String(p.entry?.text ?? ""));
        return;
    }
  }

  private item(e: NetEntry): NetListItem {
    return { id: e.id, url: e.url, method: e.method, status: e.status ?? null, type: e.type, ms: e.end != null ? e.end - e.start : null, size: e.size ?? null };
  }

  private matches(e: NetEntry, f: NetFilter): boolean {
    if (f.url && !matchUrl(e.url, f.url)) return false;
    if (f.method && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
    if (f.status != null && e.status !== f.status) return false;
    if (f.type && e.type.toLowerCase() !== f.type.toLowerCase()) return false;
    return true;
  }

  private complete(e: NetEntry) {
    for (const w of [...this.waiters]) {
      if (this.matches(e, w.f)) {
        this.waiters.delete(w);
        w.resolve({ ...this.item(e), ...(e.failed ? { failed: e.failed } : {}) });
      }
    }
  }

  list(f: NetFilter): { requests: NetListItem[]; total: number } {
    const all = this.net.toArray().filter((e) => (e.marker ? !f.method && f.status == null && (!f.type || f.type === "navigation") && (!f.url || matchUrl(e.url, f.url)) : this.matches(e, f)));
    const limit = f.limit ?? 50;
    return { requests: all.slice(-limit).map((e) => this.item(e)), total: all.length };
  }

  consoleList(f: { level?: string; limit?: number }): { messages: ConsoleItem[]; total: number } {
    let all = this.cons.toArray();
    if (f.level) all = all.filter((m) => m.level === f.level || (f.level === "error" && /^(error|assert)$/.test(m.level)) || (f.level === "warning" && m.level === "warn"));
    const limit = f.limit ?? 50;
    return { messages: all.slice(-limit).map((m) => ({ ...m })), total: all.length };
  }

  /** Full request/response; body fetched on demand (may have been evicted by Chrome). */
  async get(id: string, fetchBody: BodyFetcher) {
    const e = this.byId.get(id);
    if (!e || e.marker) throw new TabAgentError("NOT_FOUND", `No request "${id}" in the capture buffer`, "Ids come from network.list; old requests drop out after 500.");
    let body: string;
    let base64Encoded = false;
    try {
      const r = await fetchBody(e.requestId, e.sessionId);
      body = r.body;
      base64Encoded = !!r.base64Encoded;
    } catch {
      throw new TabAgentError("NOT_FOUND", `Response body no longer available for ${id}`, "Chrome keeps bodies for a limited time; repeat the request and call network.get sooner.");
    }
    const truncated = body.length > BODY_MAX_CHARS;
    return {
      ...this.item(e),
      request: { url: e.url, method: e.method, headers: e.requestHeaders ?? {}, ...(e.postData ? { postData: e.postData } : {}) },
      response: e.status != null ? { status: e.status, statusText: e.statusText ?? "", mimeType: e.mimeType ?? "", headers: e.responseHeaders ?? {} } : null,
      ...(e.failed ? { failed: e.failed } : {}),
      body: truncated ? body.slice(0, BODY_MAX_CHARS) : body,
      ...(base64Encoded ? { base64Encoded: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** Resolve on the first matching request that completes after this call. */
  waitFor(f: NetFilter & { timeout: number }): Promise<NetListItem & { failed?: string }> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { f, resolve: (x) => (clearTimeout(t), resolve(x)) };
      const t = setTimeout(() => {
        if (this.waiters.delete(w)) reject(new TabAgentError("TIMEOUT", `No matching request completed within ${f.timeout}ms`, "Check the filter with network.list."));
      }, f.timeout);
      this.waiters.add(w);
    });
  }
}
