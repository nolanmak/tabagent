// The bridge daemon: WebSocket for the extension, MCP Streamable HTTP at /mcp,
// REST at /v1. Binds 127.0.0.1 only.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getTool, redact, TabAgentError, toolsForProfiles, validateParams, type BridgeToExt, type Cap, type ExtToBridge, type SessionMeta, type ToolError } from "@tabagent/protocol";
import { auditPath, configPath, hashToken, newPairCode, saveConfig, type Config } from "./config";
import { readDownload, validateUploads } from "./files";
import { buildMcpServer } from "./mcp";

import { BRIDGE_VERSION } from "./version";
export { BRIDGE_VERSION };

export interface Principal {
  name: string;
  cap: Cap;
  sites: string[];
}

export type Dispatch = (meta: SessionMeta, tool: string, params: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: TabAgentError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DaemonOpts {
  log?: (msg: string) => void;
  profile?: string;
}

export class Daemon {
  server: Server | null = null;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private ext: WebSocket | null = null;
  extVersion: string | null = null;
  private pending = new Map<string, Pending>();
  pairCode: string;
  pairExpires: number;
  private mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; meta: SessionMeta }>();
  private restSessions = new Map<string, { meta: SessionMeta; lastSeen: number }>();
  private log: (m: string) => void;
  private extWaiters = new Set<() => void>();

  constructor(
    public cfg: Config,
    private opts: DaemonOpts = {},
  ) {
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.pairCode = newPairCode();
    this.pairExpires = Date.now() + 10 * 60_000;
  }

  get extensionConnected() {
    return !!this.ext && this.ext.readyState === 1;
  }

  newPairCode() {
    this.pairCode = newPairCode();
    this.pairExpires = Date.now() + 10 * 60_000;
    return this.pairCode;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.onHttp(req, res).catch((e) => this.sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: String(e?.message ?? e) } })));
    server.on("upgrade", (req, socket, head) => {
      if (!this.hostOk(req) || new URL(req.url ?? "/", "http://x").pathname !== "/ext") {
        socket.destroy();
        return;
      }
      const origin = String(req.headers.origin ?? "");
      if (!origin.startsWith("chrome-extension://")) {
        // Web pages can open WebSockets to localhost; only extensions may connect.
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtSocket(ws, origin.slice("chrome-extension://".length).replace(/\/$/, "")));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.cfg.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    setInterval(() => this.gcRestSessions(), 60_000).unref();
  }

  async stop() {
    for (const { transport } of this.mcpSessions.values()) await transport.close().catch(() => {});
    this.ext?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // -------------------------------------------------------------------------
  // Extension link
  // -------------------------------------------------------------------------
  private onExtSocket(ws: WebSocket, extId: string) {
    let authed = false;
    const fail = (message: string) => {
      const m: BridgeToExt = { type: "error", error: { code: "UNAUTHORIZED", message } };
      ws.send(JSON.stringify(m));
      setTimeout(() => ws.close(4001, message.slice(0, 100)), 50);
    };
    const helloTimer = setTimeout(() => !authed && ws.close(4000, "no hello"), 5000);
    ws.on("message", (data) => {
      let msg: ExtToBridge;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type !== "hello") return fail("Expected hello");
        clearTimeout(helloTimer);
        if (msg.secret && msg.secret === this.cfg.secret && this.cfg.extensionIds.includes(extId)) {
          authed = true;
          this.attachExt(ws, msg.version);
          ws.send(JSON.stringify({ type: "welcome", bridgeVersion: BRIDGE_VERSION } satisfies BridgeToExt));
          return;
        }
        if (msg.pairCode) {
          const ok = msg.pairCode.replace(/[^A-Z0-9]/gi, "").toUpperCase() === this.pairCode.replace(/-/g, "") && Date.now() < this.pairExpires;
          if (!ok) return fail("Wrong or expired pairing code. Run `tabagent pair` for a new one.");
          authed = true;
          if (!this.cfg.extensionIds.includes(extId)) this.cfg.extensionIds.push(extId);
          saveConfig(this.cfg);
          this.newPairCode(); // single use
          this.attachExt(ws, msg.version);
          ws.send(JSON.stringify({ type: "welcome", secret: this.cfg.secret, bridgeVersion: BRIDGE_VERSION } satisfies BridgeToExt));
          this.log(`Paired with extension ${extId}`);
          return;
        }
        return fail(msg.secret ? "Unknown secret or extension id; pair again with a code from `tabagent pair`." : "Not paired. Enter the pairing code from `tabagent serve`.");
      }
      this.onExtMessage(msg);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.ext === ws) {
        this.ext = null;
        this.log("Extension disconnected");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new TabAgentError("NO_EXTENSION", "The TabAgent extension disconnected"));
          this.pending.delete(id);
        }
      }
    });
  }

  private attachExt(ws: WebSocket, version: string) {
    if (this.ext && this.ext !== ws) this.ext.close(4002, "replaced by a newer connection");
    this.ext = ws;
    this.extVersion = version;
    this.log(`Extension connected (v${version})`);
    for (const w of this.extWaiters) w();
    this.extWaiters.clear();
  }

  private onExtMessage(msg: ExtToBridge) {
    if (msg.type === "ping") {
      this.ext?.send(JSON.stringify({ type: "pong" } satisfies BridgeToExt));
      return;
    }
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new TabAgentError(msg.error?.code ?? "INTERNAL", msg.error?.message ?? "Unknown error", msg.error?.hint));
      return;
    }
    if (msg.type === "event") this.log(`extension event: ${msg.event}`);
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
  dispatch: Dispatch = async (meta, toolName, rawParams) => {
    const started = Date.now();
    const tool = getTool(toolName);
    let params: Record<string, unknown> = (rawParams ?? {}) as Record<string, unknown>;
    try {
      if (!tool) throw new TabAgentError("NOT_FOUND", `Unknown tool "${toolName}"`, "GET /v1/tools lists tools.");
      params = validateParams(tool, rawParams);
      if (tool.name === "act.upload") params.paths = validateUploads(params.paths as string[], this.cfg.uploadDirs);
      if (!this.extensionConnected && !(await this.waitForExtension(3000))) {
        throw new TabAgentError("NO_EXTENSION", "The TabAgent Chrome extension is not connected", "Open Chrome with the TabAgent extension installed and paired (side panel → Pair). `tabagent status` shows the pairing state.");
      }
      let result = await this.send(meta, tool.name, params, Number(params.timeout ?? 0));
      if (result && typeof result === "object" && "__bridgeRead" in result) {
        const { __bridgeRead, ...rest } = result as { __bridgeRead: { path: string; mime: string; maxBytes: number } };
        result = { ...rest, ...readDownload(__bridgeRead.path, __bridgeRead.mime, Math.min(__bridgeRead.maxBytes, this.cfg.maxReadBytes)) };
      }
      this.audit(meta, tool.name, params, true, Date.now() - started);
      return result;
    } catch (e) {
      const err = e instanceof TabAgentError ? e : new TabAgentError("INTERNAL", String((e as Error)?.message ?? e));
      this.audit(meta, toolName, params, false, Date.now() - started, err.toJSON());
      throw err;
    }
  };

  private send(meta: SessionMeta, tool: string, params: unknown, timeoutHint: number): Promise<unknown> {
    const id = randomUUID();
    // Generous: covers user permission prompts (120s) plus the tool's own timeout.
    const ms = 135_000 + timeoutHint;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TabAgentError("TIMEOUT", `${tool} did not finish in ${Math.round(ms / 1000)}s`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.ext!.send(JSON.stringify({ type: "command", id, session: meta, tool, params } satisfies BridgeToExt));
    });
  }

  endSession(sessionId: string) {
    if (this.extensionConnected) this.ext!.send(JSON.stringify({ type: "session.closed", sessionId } satisfies BridgeToExt));
  }

  private audit(meta: SessionMeta, tool: string, params: unknown, ok: boolean, ms: number, error?: ToolError) {
    try {
      appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), session: meta.id, client: meta.label, tool, params: redact(params), ok, ms, ...(error ? { error } : {}) }) + "\n", { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  private gcRestSessions() {
    const now = Date.now();
    for (const [k, s] of this.restSessions) {
      if (now - s.lastSeen > 30 * 60_000) {
        this.restSessions.delete(k);
        this.endSession(s.meta.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------
  private hostOk(req: IncomingMessage) {
    const host = String(req.headers.host ?? "");
    return host === `127.0.0.1:${this.cfg.port}` || host === `localhost:${this.cfg.port}`;
  }

  private tokensMtime = 0;
  /** Pick up tokens created/revoked by the CLI while the daemon runs. */
  private refreshTokens() {
    try {
      const m = statSync(configPath()).mtimeMs;
      if (m === this.tokensMtime) return;
      this.tokensMtime = m;
      this.cfg.tokens = JSON.parse(readFileSync(configPath(), "utf8")).tokens ?? [];
    } catch {
      /* keep current */
    }
  }

  principal(req: IncomingMessage): Principal | null {
    this.refreshTokens();
    const auth = String(req.headers.authorization ?? "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const tok = m[1].trim();
    if (tok === this.cfg.secret) return { name: "local", cap: "full", sites: [] };
    const h = hashToken(tok);
    const rec = this.cfg.tokens.find((t) => t.hash === h);
    return rec ? { name: rec.name, cap: rec.cap, sites: rec.sites } : null;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 10 * 1024 * 1024) throw new TabAgentError("BAD_REQUEST", "Body too large");
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
    if (!this.hostOk(req)) return this.sendJson(res, 403, { ok: false, error: { code: "UNAUTHORIZED", message: "Bad Host header" } });
    const origin = req.headers.origin;
    if (origin && !String(origin).startsWith("chrome-extension://")) return this.sendJson(res, 403, { ok: false, error: { code: "UNAUTHORIZED", message: "Browser origins are not allowed" } });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.cfg.port}`);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return this.sendJson(res, 200, { ok: true, name: "tabagent", version: BRIDGE_VERSION, extension: this.extensionConnected, extensionVersion: this.extVersion });
    }

    const who = this.principal(req);
    if (!who) return this.sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" } });

    if (path === "/mcp") return this.onMcp(req, res, who, url);

    if (path === "/v1/tools" && req.method === "GET") {
      const tools = toolsForProfiles(url.searchParams.get("profile") ?? "full").map((t) => ({ name: t.name, group: t.group, description: t.description, level: t.level, sensitive: !!t.sensitive, profiles: t.profiles }));
      return this.sendJson(res, 200, { ok: true, tools });
    }
    if (path === "/v1/status" && req.method === "GET") {
      return this.sendJson(res, 200, {
        ok: true,
        version: BRIDGE_VERSION,
        extension: this.extensionConnected,
        extensionVersion: this.extVersion,
        paired: this.cfg.extensionIds.length > 0,
        pairCode: who.name === "local" ? this.pairCode : undefined,
        mcpSessions: this.mcpSessions.size,
        restSessions: this.restSessions.size,
      });
    }
    if (path === "/v1/pair" && req.method === "POST") {
      if (who.name !== "local") return this.sendJson(res, 403, { ok: false, error: { code: "UNAUTHORIZED", message: "Only the local owner can create pairing codes" } });
      return this.sendJson(res, 200, { ok: true, pairCode: this.newPairCode(), expiresInSec: 600 });
    }
    if (path === "/v1/session/end" && req.method === "POST") {
      const body = (await this.readBody(req)) as { sessionId?: string } | undefined;
      const meta = this.restMeta(req, who, body?.sessionId);
      this.restSessions.delete(meta.id);
      this.endSession(meta.id);
      return this.sendJson(res, 200, { ok: true });
    }
    const callMatch = path.match(/^\/v1\/call\/?([\w.]*)$/) ?? path.match(/^\/v1\/([a-z]+\.[A-Za-z]+|tabs)$/);
    if (callMatch && req.method === "POST") {
      let body: any;
      try {
        body = (await this.readBody(req)) ?? {};
      } catch (e) {
        return this.sendJson(res, 400, { ok: false, error: (e as TabAgentError).toJSON?.() ?? { code: "BAD_REQUEST", message: String(e) } });
      }
      const toolName = callMatch[1] || body.tool;
      const params = callMatch[1] ? (body.params ?? body) : body.params;
      const meta = this.restMeta(req, who, body.session);
      try {
        const result = await this.dispatch(meta, toolName, params);
        return this.sendJson(res, 200, { ok: true, result });
      } catch (e) {
        const err = e as TabAgentError;
        const status = err.code === "BAD_REQUEST" ? 400 : err.code === "NOT_FOUND" ? 404 : err.code === "PERMISSION_DENIED" || err.code === "UNAUTHORIZED" ? 403 : err.code === "NO_EXTENSION" ? 503 : 200;
        return this.sendJson(res, status, { ok: false, error: err.toJSON ? err.toJSON() : { code: "INTERNAL", message: String(e) } });
      }
    }
    return this.sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `No route ${req.method} ${path}` } });
  }

  private restMeta(req: IncomingMessage, who: Principal, bodySession?: string): SessionMeta {
    const sid = String(req.headers["x-tabagent-session"] ?? bodySession ?? `rest-${who.name}`).slice(0, 100);
    const label = String(req.headers["x-tabagent-label"] ?? (who.name === "local" ? sid.replace(/^stdio-/, "").replace(/-[a-z0-9]{6}$/, "") : who.name)).slice(0, 40);
    const key = `${who.name}:${sid}`;
    const meta: SessionMeta = { id: who.name === "local" ? sid : `${who.name}:${sid}`, label: label || "agent", cap: who.cap, sites: who.sites };
    this.restSessions.set(key, { meta, lastSeen: Date.now() });
    return meta;
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
      const meta: SessionMeta = { id: `mcp-${randomUUID().slice(0, 8)}`, label: who.name === "local" ? "agent" : who.name, cap: who.cap, sites: who.sites };
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
        dispatch: this.dispatch,
        meta: () => meta,
        profile: url.searchParams.get("profile") ?? this.opts.profile ?? "core",
        onClientInfo: (name) => {
          if (who.name === "local" && name) meta.label = name;
        },
      });
      await server.connect(transport);
      entry = { transport, meta };
    }
    await entry.transport.handleRequest(req, res, body);
  }
}
