// The bridge daemon: WebSocket for the extension at /ext, MCP Streamable HTTP at /mcp, REST at /v1.
// Binds 127.0.0.1 only. Trusted for *who is calling* (D1); the extension enforces site policy.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  defaultTimeout,
  getTool,
  HelloSchema,
  normalizeHello,
  PROTOCOL_VERSION,
  ResultEnvelopeSchema,
  TabAgentError,
  TIMEOUTS,
  toolsForProfiles,
  toTabAgentError,
  validateParams,
  versionMismatchHint,
  wrapResponse,
  type BridgeToExt,
  type ErrorCode,
  type OutputResponse,
  type SessionMeta,
} from "@tabagent/protocol";
import { saveConfig, type Config } from "./config";
import { buildMcpServer } from "./mcp";
import { Pairing } from "./pairing";
import { authenticate, bearerOf, type Principal } from "./tokens";
import { BRIDGE_VERSION } from "./version";

export { BRIDGE_VERSION };
export type { Principal };

export const PAIRING_HINT =
  "Open Chrome with the TabAgent extension installed, open its side panel and enter the pairing code shown by `tabagent status` (or mint one with `tabagent pair`).";

interface Pending {
  resolve: (r: OutputResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  ws: WebSocket;
  meta: SessionMeta;
  tool: string;
  params: Record<string, unknown>;
}

interface ExtConn {
  ws: WebSocket;
  id: string;
  version: string;
  features: Set<string>;
  lastSeen: number;
}

interface RestSession {
  meta: SessionMeta;
  lastSeen: number;
  /** stdio MCP proxy sessions live until the proxy ends them (D8: one per MCP connection). */
  persistent: boolean;
}

export interface DaemonOpts {
  log?: (msg: string) => void;
  /** Default MCP profile for HTTP clients that don't pass ?profile=. */
  profile?: string;
  now?: () => number;
  /** How long a call waits for the extension to (re)connect before NO_EXTENSION. */
  extWaitMs?: number;
  /** Heartbeat check interval (the 45s rule itself is TIMEOUTS.silentSocket). */
  heartbeatCheckMs?: number;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  TOO_LARGE: 413,
  NO_EXTENSION: 503,
  VERSION_MISMATCH: 503,
  TIMEOUT: 504,
  PROMPT_TIMEOUT: 504,
  INTERNAL: 500,
};

export class Daemon {
  server: Server | null = null;
  port: number;
  readonly pairing: Pairing;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private ext: ExtConn | null = null;
  private pending = new Map<string, Pending>();
  private mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; meta: SessionMeta }>();
  private restSessions = new Map<string, RestSession>();
  private extWaiters = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private log: (m: string) => void;
  private now: () => number;

  constructor(
    public cfg: Config,
    private opts: DaemonOpts = {},
  ) {
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.now = opts.now ?? Date.now;
    this.pairing = new Pairing(this.now);
    this.port = cfg.port;
  }

  get extensionConnected() {
    return !!this.ext && this.ext.ws.readyState === 1;
  }
  get extensionVersion() {
    return this.ext?.version ?? null;
  }
  get pairCode() {
    return this.pairing.current();
  }
  newPairCode() {
    return this.pairing.mint();
  }

  async start(): Promise<void> {
    const server = createServer((req, res) =>
      this.onHttp(req, res).catch((e) => this.sendJson(res, 500, { ok: false, error: toTabAgentError(e).toJSON() })),
    );
    server.on("upgrade", (req, socket, head) => {
      if (!this.hostOk(req) || new URL(req.url ?? "/", "http://x").pathname !== "/ext") {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const origin = String(req.headers.origin ?? "");
      const m = origin.match(/^chrome-extension:\/\/([a-p]{32}|[\w-]+)\/?$/);
      if (!m) {
        // Web pages can open WebSockets to loopback; only extensions may connect.
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtSocket(ws, m[1]));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.cfg.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.timers.push(setInterval(() => this.gcRestSessions(), 60_000));
    this.timers.push(setInterval(() => this.checkSilent(), this.opts.heartbeatCheckMs ?? 5_000));
    for (const t of this.timers) t.unref();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    for (const { transport } of this.mcpSessions.values()) await transport.close().catch(() => {});
    this.ext?.ws.terminate();
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  // -------------------------------------------------------------------------
  // Extension link (D4, D5, D11)
  // -------------------------------------------------------------------------
  private sendTo(ws: WebSocket, m: BridgeToExt) {
    if (ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  private refuse(ws: WebSocket, code: ErrorCode, message: string, hint?: string) {
    this.sendTo(ws, { type: "error", error: { code, message, ...(hint ? { hint } : {}) } });
    setTimeout(() => ws.close(4001, message.slice(0, 100)), 50);
  }

  private onExtSocket(ws: WebSocket, extId: string) {
    let authed = false;
    const helloTimer = setTimeout(() => !authed && ws.close(4000, "no hello"), 5000);
    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      if (authed) {
        if (this.ext?.ws === ws) this.ext.lastSeen = this.now();
        this.onExtMessage(ws, raw);
        return;
      }
      clearTimeout(helloTimer);
      authed = this.onHello(ws, extId, raw);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.ext?.ws === ws) {
        this.ext = null;
        this.log("Extension disconnected");
      }
      this.failPending(ws, "The TabAgent extension disconnected");
    });
    ws.on("error", () => {});
  }

  /** Returns true when the socket is now the authenticated extension link. */
  private onHello(ws: WebSocket, extId: string, raw: unknown): boolean {
    const h = HelloSchema.safeParse(normalizeHello(raw));
    if (!h.success) {
      this.refuse(ws, "UNAUTHORIZED", "Expected hello as the first message");
      return false;
    }
    const hello = h.data;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      const hint = versionMismatchHint(hello.protocolVersion);
      this.refuse(ws, "VERSION_MISMATCH", `Protocol version mismatch: extension ${hello.protocolVersion}, bridge ${PROTOCOL_VERSION}`, hint);
      this.log(`Refused extension ${extId}: ${hint}`);
      return false;
    }
    if (this.extensionConnected && this.ext!.id !== extId) {
      this.refuse(
        ws,
        "UNAUTHORIZED",
        `Another TabAgent extension (${this.ext!.id}) is already connected to this bridge; v1 allows one connection.`,
        "Disable the other TabAgent extension or close that Chrome profile, then reconnect.",
      );
      return false;
    }
    const known = this.cfg.extensionIds.includes(extId);
    if (hello.secret && hello.secret === this.cfg.secret && known) {
      this.attachExt(ws, extId, hello.extensionVersion, hello.features);
      this.sendTo(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION });
      return true;
    }
    if (hello.pairCode) {
      const r = this.pairing.check(hello.pairCode);
      if (r !== "ok") {
        const msg =
          r === "wrong"
            ? "Wrong pairing code."
            : r === "expired"
              ? "The pairing code expired."
              : "No valid pairing code (it was used, or invalidated after 5 wrong attempts).";
        this.refuse(ws, "UNAUTHORIZED", msg, "Run `tabagent pair` for a new code.");
        return false;
      }
      if (!known) this.cfg.extensionIds.push(extId);
      saveConfig(this.cfg);
      this.attachExt(ws, extId, hello.extensionVersion, hello.features);
      this.sendTo(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION, secret: this.cfg.secret });
      this.log(`Paired with extension ${extId}`);
      return true;
    }
    if (hello.secret && hello.secret === this.cfg.secret) {
      this.refuse(ws, "UNAUTHORIZED", `Extension ${extId} is not paired with this bridge.`, "Pair it with a code from `tabagent pair`.");
    } else if (hello.secret) {
      this.refuse(ws, "UNAUTHORIZED", "Unknown secret; pair again with a code from `tabagent pair`.");
    } else {
      this.refuse(ws, "UNAUTHORIZED", "Not paired. Enter the pairing code from `tabagent status` or `tabagent pair`.");
    }
    return false;
  }

  private attachExt(ws: WebSocket, id: string, version: string, features: string[] = []) {
    const old = this.ext;
    if (old && old.ws !== ws) {
      // Same ID reconnecting: the new socket replaces the old one; its in-flight commands fail.
      this.failPending(old.ws, "The TabAgent extension reconnected; the command was lost");
      old.ws.close(4002, "replaced by a newer connection");
    }
    this.ext = { ws, id, version, features: new Set(features), lastSeen: this.now() };
    this.log(`Extension connected (v${version})`);
    for (const w of this.extWaiters) w();
    this.extWaiters.clear();
  }

  private failPending(ws: WebSocket, message: string) {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ ok: false, error: { code: "NO_EXTENSION", message, hint: PAIRING_HINT } });
    }
  }

  /** D11: close a socket silent for 45s and fail its in-flight commands with NO_EXTENSION. */
  checkSilent(now = this.now()) {
    const e = this.ext;
    if (!e || now - e.lastSeen <= TIMEOUTS.silentSocket) return;
    this.log("Extension silent for 45s; closing the socket");
    this.ext = null;
    this.failPending(e.ws, "The TabAgent extension stopped responding (no ping for 45s)");
    e.ws.terminate();
  }

  private onExtMessage(ws: WebSocket, msg: any) {
    switch (msg?.type) {
      case "ping":
        this.sendTo(ws, { type: "pong" });
        return;
      case "result":
        return this.onResult(msg);
      case "event":
        this.log(`extension event: ${msg.event}`);
        return;
    }
  }

  private onResult(raw: any) {
    const p = this.pending.get(String(raw?.id));
    if (!p) return;
    this.pending.delete(raw.id);
    clearTimeout(p.timer);
    // The audit log is #15; until then the extension's audit record is checked for shape only.
    ResultEnvelopeSchema.safeParse(raw);
    const out: OutputResponse = { ok: !!raw.ok };
    if (raw.ok) out.result = raw.result;
    else out.error = TabAgentError.from(raw.error ?? {}).toJSON();
    if (typeof raw.snapshotDiff === "string") out.snapshotDiff = raw.snapshotDiff;
    if (raw.navigation && typeof raw.navigation === "object") out.navigation = raw.navigation;
    if (Array.isArray(raw.dialogs)) out.dialogs = raw.dialogs;
    if (Array.isArray(raw.downloads)) out.downloads = raw.downloads;
    // Pre-D14 extensions put the diff inside the result; lift it so it is wrapped the same way.
    const res = out.result as Record<string, unknown> | undefined;
    if (res && typeof res === "object" && typeof res.snapshotDiff === "string" && out.snapshotDiff === undefined) {
      const { snapshotDiff, ...rest } = res;
      out.snapshotDiff = snapshotDiff as string;
      out.result = rest;
    }
    p.resolve(out);
  }

  waitForExtension(ms: number): Promise<boolean> {
    if (this.extensionConnected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        this.extWaiters.delete(done);
        resolve(false);
      }, ms);
      this.extWaiters.add(done);
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------
  /** Run one tool call; never throws. The response is NOT yet wrapped. */
  async dispatchRaw(meta: SessionMeta, toolName: string, rawParams: unknown): Promise<OutputResponse> {
    const tool = getTool(toolName);
    try {
      if (!tool) throw new TabAgentError("BAD_REQUEST", `Unknown tool "${toolName}"`, "GET /v1/tools lists tools.");
      const params = validateParams(tool, rawParams);
      if (!this.extensionConnected && !(await this.waitForExtension(this.opts.extWaitMs ?? 3000))) {
        throw new TabAgentError("NO_EXTENSION", "The TabAgent Chrome extension is not connected", PAIRING_HINT);
      }
      return await this.send(meta, tool.name, params);
    } catch (e) {
      return { ok: false, error: toTabAgentError(e).toJSON() };
    }
  }

  /** Wrapped response for the output edge (D21). MCP, REST and CLI all go through here. */
  async call(meta: SessionMeta, toolName: string, params: unknown): Promise<OutputResponse> {
    return wrapResponse(await this.dispatchRaw(meta, toolName, params), getTool(toolName)).response;
  }

  private send(meta: SessionMeta, tool: string, params: Record<string, unknown>): Promise<OutputResponse> {
    const id = randomUUID();
    const t = Number(params.timeout ?? 0) || defaultTimeout(tool);
    // Generous: a permission prompt (120s) plus the tool's own timeout plus slack.
    const ms = TIMEOUTS.prompt + Math.min(t, TIMEOUTS.max) + 15_000;
    const ws = this.ext!.ws;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "TIMEOUT", message: `${tool} did not finish in ${Math.round(ms / 1000)}s` } });
      }, ms);
      this.pending.set(id, { resolve, timer, ws, meta, tool, params });
      this.sendTo(ws, { type: "command", id, session: meta, tool, params });
    });
  }

  endSession(sessionId: string) {
    if (this.extensionConnected) this.sendTo(this.ext!.ws, { type: "session.closed", sessionId });
  }

  gcRestSessions(now = this.now()) {
    for (const [k, s] of this.restSessions) {
      if (!s.persistent && now - s.lastSeen > TIMEOUTS.restSessionIdle) {
        this.restSessions.delete(k);
        this.endSession(s.meta.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP (D2)
  // -------------------------------------------------------------------------
  private hostOk(req: IncomingMessage) {
    const host = String(req.headers.host ?? "");
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  /** Browser Origin allowed only if it is the paired extension. No Origin (CLI, agents) is fine. */
  private originOk(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return this.cfg.extensionIds.some((id) => origin === `chrome-extension://${id}`);
  }

  principal(req: IncomingMessage): Principal | null {
    return authenticate(this.cfg, bearerOf(req.headers.authorization));
  }

  private sendJson(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private err(res: ServerResponse, code: ErrorCode, message: string, status = STATUS[code] ?? 200) {
    this.sendJson(res, status, { ok: false, error: { code, message } });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 10 * 1024 * 1024) throw new TabAgentError("TOO_LARGE", "Body too large");
      chunks.push(c as Buffer);
    }
    const s = Buffer.concat(chunks).toString("utf8");
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      throw new TabAgentError("BAD_REQUEST", "Body is not valid JSON");
    }
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse) {
    if (!this.hostOk(req)) return this.err(res, "UNAUTHORIZED", "Bad Host header", 403);
    if (!this.originOk(req)) return this.err(res, "UNAUTHORIZED", "Browser origins are not allowed", 403);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    if (path === "/v1/health" && req.method === "GET") {
      return this.sendJson(res, 200, { ok: true, bridgeVersion: BRIDGE_VERSION, protocolVersion: PROTOCOL_VERSION });
    }

    const who = this.principal(req);
    if (!who) return this.err(res, "UNAUTHORIZED", "Missing or invalid bearer token", 401);

    if (path === "/mcp") return this.onMcp(req, res, who, url);

    if (path === "/v1/tools" && req.method === "GET") {
      let list;
      try {
        list = toolsForProfiles(url.searchParams.get("profile") ?? "full");
      } catch (e) {
        return this.err(res, "BAD_REQUEST", (e as Error).message);
      }
      const tools = list.map((t) => ({ name: t.name, group: t.group, description: t.description, level: t.level, sensitive: t.sensitive ?? null, profiles: t.profiles }));
      return this.sendJson(res, 200, { ok: true, tools });
    }
    if (path === "/v1/status" && req.method === "GET") {
      return this.sendJson(res, 200, {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        extension: this.extensionConnected,
        extensionVersion: this.extensionVersion,
        paired: this.cfg.extensionIds.length > 0,
        pairCode: this.pairCode,
        mcpSessions: this.mcpSessions.size,
        restSessions: this.restSessions.size,
      });
    }
    if (path === "/v1/pair" && req.method === "POST") {
      return this.sendJson(res, 200, { ok: true, pairCode: this.newPairCode(), expiresInSec: TIMEOUTS.pairCode / 1000 });
    }
    let body: any;
    if (req.method === "POST") {
      try {
        body = (await this.readBody(req)) ?? {};
      } catch (e) {
        const er = toTabAgentError(e);
        return this.err(res, er.code, er.message);
      }
    }
    if (path === "/v1/session/end" && req.method === "POST") {
      const meta = this.restMeta(req, who, url, body?.session ?? body?.sessionId);
      this.restSessions.delete(this.restKey(req, who, url, body?.session ?? body?.sessionId));
      this.endSession(meta.id);
      return this.sendJson(res, 200, { ok: true });
    }
    // POST /v1/<tool> (canonical: body = params), /v1/call/<tool> and /v1/call {tool, params} (legacy).
    const m = path.match(/^\/v1\/call(?:\/([\w.]+))?$/) ?? path.match(/^\/v1\/([\w.]+)$/);
    if (m && req.method === "POST") {
      const legacy = path.startsWith("/v1/call");
      const toolName = m[1] ?? body.tool;
      if (!getTool(String(toolName ?? ""))) return this.err(res, "NOT_FOUND", `No tool "${toolName}"`);
      const params = legacy ? (body.params ?? (m[1] ? body : {})) : body;
      const meta = this.restMeta(req, who, url, legacy ? body.session : undefined);
      const out = await this.call(meta, String(toolName), params);
      return this.sendJson(res, out.ok ? 200 : (STATUS[out.error!.code] ?? 200), out);
    }
    return this.err(res, "NOT_FOUND", `No route ${req.method} ${path}`);
  }

  private restKey(req: IncomingMessage, who: Principal, url: URL, bodySession?: string) {
    const sess = String(req.headers["x-tabagent-session"] ?? url.searchParams.get("session") ?? bodySession ?? "default").slice(0, 100);
    return `${who.name}:${sess}`;
  }

  /**
   * D8 sessions for REST/CLI: one per credential name plus an optional session name, 30 min idle expiry.
   * The stdio MCP proxy marks its session persistent (x-tabagent-mcp: 1) and ends it on exit.
   */
  restMeta(req: IncomingMessage, who: Principal, url: URL, bodySession?: string): SessionMeta {
    const key = this.restKey(req, who, url, bodySession);
    const proxy = req.headers["x-tabagent-mcp"] === "1";
    const client = String(req.headers["x-tabagent-client"] ?? "").replace(/[^\w .-]/g, "").slice(0, 40);
    let s = this.restSessions.get(key);
    if (!s) {
      const label = (proxy && client) || "local";
      s = { meta: { id: `${proxy ? "mcp" : "rest"}:${key}`, label, cap: who.cap, sites: who.sites }, lastSeen: this.now(), persistent: proxy };
      this.restSessions.set(key, s);
    } else if (proxy && client && s.meta.label === "local") s.meta.label = client;
    s.lastSeen = this.now();
    return s.meta;
  }

  private async onMcp(req: IncomingMessage, res: ServerResponse, who: Principal, url: URL) {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let entry = sid ? this.mcpSessions.get(sid) : undefined;
    let body: unknown;
    if (req.method === "POST") body = await this.readBody(req);
    if (!entry) {
      if (sid) return this.sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      const isInit = Array.isArray(body) ? body.some((m: any) => m?.method === "initialize") : (body as any)?.method === "initialize";
      if (req.method !== "POST" || !isInit) return this.sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No session; send initialize first" }, id: null });
      const profile = url.searchParams.get("profile") ?? this.opts.profile ?? "core";
      try {
        toolsForProfiles(profile);
      } catch (e) {
        return this.sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32602, message: (e as Error).message }, id: null });
      }
      const meta: SessionMeta = { id: `mcp-${randomUUID().slice(0, 8)}`, label: "local", cap: who.cap, sites: who.sites };
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.mcpSessions.set(id, { transport, meta });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.mcpSessions.delete(transport.sessionId);
        this.endSession(meta.id);
      };
      const server = buildMcpServer({
        call: (tool, args) => this.call(meta, tool, args),
        profile,
        onClientInfo: (name) => {
          const n = String(name ?? "").replace(/[^\w .-]/g, "").slice(0, 40);
          if (n) meta.label = n;
        },
      });
      await server.connect(transport);
      entry = { transport, meta };
    }
    await entry.transport.handleRequest(req, res, body);
  }
}
