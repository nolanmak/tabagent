// Thin adapter: JSON-RPC 2.0 over WebSocket to the Codex app-server control socket (spec AD10, spike §4).
// It only connects to a socket that already exists; it never starts the daemon.
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { BRIDGE_VERSION } from "../version";

export function defaultCodexSocket(): string {
  return process.env.TABAGENT_CODEX_SOCKET || join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

type Notification = (method: string, params: unknown) => void;

export class CodexRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Notification>();
  private closedErr: Error | null = null;

  private constructor(
    private ws: WebSocket,
    private timeoutMs: number,
  ) {
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.failAll(new CodexRpcError("Codex app-server connection closed")));
    ws.on("error", () => {});
  }

  /** Connect, then `initialize {clientInfo}` and the `initialized` notification. */
  static async connect(socketPath: string, timeoutMs = 3_000): Promise<CodexRpc> {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: timeoutMs });
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(new CodexRpcError(`Codex app-server unavailable: ${(e as Error).message}`)));
    });
    const rpc = new CodexRpc(ws, timeoutMs);
    try {
      await rpc.request("initialize", { clientInfo: { name: "tabagent", version: BRIDGE_VERSION } });
      rpc.notify("initialized");
    } catch (e) {
      rpc.close();
      throw e;
    }
    return rpc;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closedErr || !this.open) return Promise.reject(this.closedErr ?? new CodexRpcError("Codex app-server connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex app-server did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  notify(method: string, params?: unknown) {
    if (this.open) this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  onNotification(fn: Notification): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.failAll(new CodexRpcError("Codex app-server connection closed"));
    this.listeners.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(raw: string) {
    let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CodexRpcError(String(m.error.message ?? "Codex app-server error"), typeof m.error.code === "number" ? m.error.code : undefined));
      else p.resolve(m.result);
      return;
    }
    if (m.id === undefined && typeof m.method === "string") for (const fn of this.listeners) fn(m.method, m.params);
  }

  private failAll(e: Error) {
    this.closedErr ??= e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }
}

/** All thread ids loaded in the daemon (follows nextCursor, bounded). */
export async function loadedThreadIds(rpc: CodexRpc, maxPages = 20): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const r: { data?: unknown; nextCursor?: unknown } = await rpc.request("thread/loaded/list", cursor ? { cursor } : {});
    if (!Array.isArray(r?.data)) throw new CodexRpcError("thread/loaded/list returned no data array");
    for (const x of r.data) if (typeof x === "string") ids.push(x);
    cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return ids;
}

/** thread/read; resolves the Thread object or throws. */
export async function readThread(rpc: CodexRpc, threadId: string): Promise<unknown> {
  const r: { thread?: unknown } = await rpc.request("thread/read", { threadId });
  if (!r?.thread) throw new CodexRpcError("thread/read returned no thread");
  return r.thread;
}
