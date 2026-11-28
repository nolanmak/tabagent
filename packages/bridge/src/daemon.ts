// The bridge daemon: WebSocket for the extension at /ext, MCP Streamable HTTP at /mcp, REST at /v1.
// Binds 127.0.0.1 only. Trusted for *who is calling* (D1); the extension enforces site policy.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AGENTS_FEATURE,
  APPROVALS_FEATURE,
  authExtraTimeout,
  captchaExtraTimeout,
  defaultTimeout,
  FilesResolveSchema,
  getTool,
  HelloSchema,
  INBOX_ACK_PATH,
  INBOX_EVENT_PATH,
  INBOX_PATH,
  InboxAckSchema,
  InboxEventSchema,
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
import { AgentsBridge, type AgentsOpts, type Held } from "./agents";
import { ApprovalsBridge, approveStatus } from "./approvals";
import { defaultPresenceProvider, type PresenceProvider } from "./approvals/presence";
import { parseInboxHeaders, type InboxConn } from "./agents/inbox";
import { AuditWriter } from "./audit";
import { createAuth, type Auth } from "./auth";
import { createCaptcha, type CaptchaBridge, type CaptchaOpts } from "./captcha";
import { auditPath, configPath, saveConfig, type Config } from "./config";
import { readDownload, resolveUploads, SessionDownloads } from "./files";
import { HandoffBridge, type HandoffBridgeOpts } from "./handoff";
import { buildMcpServer } from "./mcp";
import { Pairing } from "./pairing";
import { authenticate, bearerOf, principalMeta, type Principal } from "./tokens";
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
  audit?: AuditWriter;
  /** M6 auth (tests inject a fake). */
  auth?: Auth;
  /** #61 CAPTCHA solving (tests inject stub settings/providers). */
  captcha?: Partial<Omit<CaptchaOpts, "inFlight" | "audit">>;
  /** #61 remote handoff: tests bind the phone listener on loopback and capture the webhook. */
  handoffListen?: HandoffBridgeOpts["listen"];
  postWebhook?: HandoffBridgeOpts["postWebhook"];
  /** Send to agent: stub `claude` binary, Codex socket path, timeouts (tests). */
  agents?: AgentsOpts;
  /**
   * #108: presence provider for `tabagent approve`. Tests only: production always uses
   * defaultPresenceProvider() (platform-chosen). No CLI flag, env var or config key reaches this.
   */
  presence?: PresenceProvider;
}

/** Optional capabilities the bridge advertises in welcome (AD16). */
export const BRIDGE_FEATURES = [AGENTS_FEATURE, APPROVALS_FEATURE];

/**
 * Commands that only read, so re-running one is harmless. When a newer socket from the same extension
 * replaces the current one (a reload, or a worker reconnecting), these are re-sent to the new socket
 * instead of failing; anything that may have changed a page or a tab fails fast instead, because the
 * old worker may already have run it.
 */
const RETRY_SAFE = new Set([
  "page.snapshot",
  "page.screenshot",
  "page.text",
  "page.markdown",
  "page.find",
  "form.describe",
  "form.blockers",
  "extract.table",
  "extract.links",
  "extract.schema",
  "console.list",
  "network.list",
  "downloads.list",
  "session.info",
  "session.permissions",
  "settings.get",
  "session.kill_all",
]);
export function retrySafe(tool: string, params: Record<string, unknown>): boolean {
  return RETRY_SAFE.has(tool) || (tool === "tabs" && params.action === "list");
}

/** SSE comment interval on inbox streams, so idle connections are not dropped by anything in between. */
const INBOX_PING_MS = 15_000;

/** How long a replaced socket gets to finish its close handshake before it is terminated. */
const REPLACED_CLOSE_GRACE_MS = 1_000;

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
  readonly audit: AuditWriter;
  readonly auth: Auth;
  readonly captcha: CaptchaBridge;
  readonly handoff: HandoffBridge;
  readonly agents: AgentsBridge;
  readonly approvals: ApprovalsBridge;
  readonly downloads = new SessionDownloads();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private ext: ExtConn | null = null;
  private pending = new Map<string, Pending>();
  private mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; meta: SessionMeta }>();
  private restSessions = new Map<string, RestSession>();
  private extWaiters = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private log: (m: string) => void;
  private now: () => number;
  private cfgMtime = 0;

  constructor(
    public cfg: Config,
    private opts: DaemonOpts = {},
  ) {
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.now = opts.now ?? Date.now;
    this.pairing = new Pairing(this.now);
    this.audit = opts.audit ?? new AuditWriter(auditPath());
    this.auth = opts.auth ?? createAuth({ inFlight: (id) => this.pending.get(id), audit: this.audit, log: this.log, now: this.now });
    this.captcha = createCaptcha({ log: this.log, now: this.now, ...opts.captcha, inFlight: (id) => this.pending.get(id), audit: this.audit });
    this.port = cfg.port;
    this.agents = new AgentsBridge({
      now: this.now,
      audit: this.audit,
      sendToExt: (m) => this.ext && this.sendTo(this.ext.ws, m),
      ...opts.agents,
    });
    this.handoff = new HandoffBridge({
      inFlight: (id) => this.pending.get(id),
      sendTo: (ws, m) => this.sendTo(ws as WebSocket, m as unknown as BridgeToExt),
      audit: { event: (e, d) => this.audit.event(e, d, { caller: "bridge" }) },
      port: () => this.port,
      log: this.log,
      now: this.now,
      listen: opts.handoffListen,
      postWebhook: opts.postWebhook,
    });
    this.approvals = new ApprovalsBridge({
      presence: opts.presence ?? defaultPresenceProvider(),
      sendToExt: (m) => {
        if (!this.ext || !this.extensionConnected) return false;
        this.sendTo(this.ext.ws, m as BridgeToExt);
        return true;
      },
      audit: { event: (e, d) => this.audit.event(e, d, { caller: "bridge" }) },
      remote: { ensure: () => this.handoff.ensureRemote(), release: () => this.handoff.releaseRemote() },
      log: this.log,
      now: this.now,
    });
    this.handoff.attachApprovals(this.approvals);
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
    try {
      this.cfgMtime = statSync(configPath()).mtimeMs;
    } catch {
      /* no file yet */
    }
    this.timers.push(setInterval(() => this.gcRestSessions(), 60_000));
    this.timers.push(setInterval(() => this.handoff.sweep(), 15_000));
    this.timers.push(setInterval(() => this.checkSilent(), this.opts.heartbeatCheckMs ?? 5_000));
    for (const t of this.timers) t.unref();
    await this.auth.start();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    await this.auth.stop();
    this.agents.stop();
    this.captcha.abortAll();
    this.approvals.stop();
    await this.handoff.stop();
    for (const { transport } of this.mcpSessions.values()) await transport.close().catch(() => {});
    this.ext?.ws.terminate();
    for (const c of this.wss.clients) c.terminate();
    const closed = new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    // Drop lingering sockets (a dropped inbox stream can leave one half-open) so close() does not wait on them.
    this.server?.closeAllConnections?.();
    await closed;
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
        this.approvals.onExtGone();
      }
      this.failPending(ws, "The TabAgent extension disconnected");
      this.handoff.onSocketClosed(ws);
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
    this.auth.bridge.onHello(raw);
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
      this.sendTo(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION, features: BRIDGE_FEATURES });
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
      this.sendTo(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION, secret: this.cfg.secret, features: BRIDGE_FEATURES });
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
    this.ext = { ws, id, version, features: new Set(features), lastSeen: this.now() };
    this.log(`Extension connected (v${version})`);
    if (old && old.ws !== ws) {
      // Same ID reconnecting (D4): the newest socket wins and the old one is closed at once. Its
      // read-only in-flight commands move to the new socket; the rest fail fast rather than wait 45s.
      this.handOver(old.ws, ws);
      old.ws.close(4002, "replaced by a newer connection");
      const t = setTimeout(() => old.ws.readyState !== 3 && old.ws.terminate(), REPLACED_CLOSE_GRACE_MS);
      t.unref?.();
    }
    for (const w of this.extWaiters) w();
    this.extWaiters.clear();
  }

  /** Move retry-safe in-flight commands from a replaced socket to its successor; fail the others now. */
  private handOver(from: WebSocket, to: WebSocket) {
    for (const [id, p] of this.pending) {
      if (p.ws !== from) continue;
      if (!retrySafe(p.tool, p.params)) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        this.handoff.commandEnded(id);
        p.resolve({
          ok: false,
          error: { code: "NO_EXTENSION", message: "The TabAgent extension reconnected while the command was running; it was not re-sent because it may have already run", hint: "Check the page state, then retry." },
        });
        continue;
      }
      p.ws = to;
      this.sendTo(to, { type: "command", id, session: p.meta, tool: p.tool, params: p.params });
    }
  }

  private failPending(ws: WebSocket, message: string) {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.handoff.commandEnded(id);
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
    this.handoff.onSocketClosed(e.ws);
    this.approvals.onExtGone();
    e.ws.terminate();
  }

  private onExtMessage(ws: WebSocket, msg: any) {
    if (this.auth.bridge.onExtMessage(msg, ws, (m) => this.sendTo(ws, m as unknown as BridgeToExt))) return;
    if (this.captcha.onExtMessage(msg, ws, (m) => this.sendTo(ws, m as unknown as BridgeToExt))) return;
    if (this.handoff.onExtMessage(msg, ws)) return;
    // #108: prompt mirror and answers only from the current paired extension socket.
    if (this.approvals.onExtMessage(msg, this.ext?.ws === ws, (m) => this.sendTo(ws, m as BridgeToExt))) return;
    // AD2/AD14: agents.* only on the current paired extension socket.
    if (this.ext?.ws === ws && this.agents.onExtMessage(msg, (m) => this.sendTo(ws, m))) return;
    switch (msg?.type) {
      case "ping":
        this.sendTo(ws, { type: "pong" });
        return;
      case "result":
        return this.onResult(msg);
      case "event":
        this.audit.event(String(msg.event), msg.data && typeof msg.data === "object" ? msg.data : undefined, { caller: "extension" });
        this.log(`extension event: ${msg.event}`);
        return;
      case "files.resolve":
        return this.onFilesResolve(ws, msg);
    }
  }

  /** #11: validate upload paths only once the extension (after its gates) asks for them. */
  private onFilesResolve(ws: WebSocket, raw: unknown) {
    const r = FilesResolveSchema.safeParse(raw);
    if (!r.success) return;
    const { id, commandId, paths } = r.data;
    const reply = (m: Omit<Extract<BridgeToExt, { type: "files.resolved" }>, "type" | "id">) => this.sendTo(ws, { type: "files.resolved", id, ...m });
    const p = this.pending.get(commandId);
    if (!p || p.ws !== ws || p.tool !== "act.upload") return reply({ ok: false, error: { code: "BAD_REQUEST", message: "No in-flight act.upload with that id" } });
    const asked = new Set((p.params.paths as string[]) ?? []);
    if (!paths.every((x) => asked.has(x))) return reply({ ok: false, error: { code: "BAD_REQUEST", message: "Paths differ from the act.upload command" } });
    try {
      reply({ ok: true, paths: resolveUploads(paths, this.cfg.uploadDirs) });
    } catch (e) {
      reply({ ok: false, error: toTabAgentError(e).toJSON() });
    }
  }

  private onResult(raw: any) {
    const p = this.pending.get(String(raw?.id));
    if (!p) return;
    this.pending.delete(raw.id);
    clearTimeout(p.timer);
    this.handoff.commandEnded(raw.id);
    const who = { caller: p.meta.label, session: p.meta.id };
    const env = ResultEnvelopeSchema.safeParse(raw);
    if (env.success) this.audit.record(env.data.audit, who);
    else {
      // Legacy extension (no audit record): log a minimal record without params (D20).
      const code = raw?.error?.code;
      this.audit.minimal(p.tool, raw?.ok ? "ok" : code === "PERMISSION_DENIED" ? "denied" : "error", who, raw?.ok ? undefined : TabAgentError.from(raw?.error ?? {}).code, "extension sent no audit record");
    }
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
    const who = { caller: meta.label, session: meta.id };
    const tool = getTool(toolName);
    try {
      if (!tool) throw new TabAgentError("BAD_REQUEST", `Unknown tool "${toolName}"`, "GET /v1/tools lists tools.");
      const params = validateParams(tool, rawParams);
      // Never route to a socket already past the silence limit: drop it now and wait for the reconnect.
      this.checkSilent();
      if (!this.extensionConnected && !(await this.waitForExtension(this.opts.extWaitMs ?? 3000))) {
        throw new TabAgentError("NO_EXTENSION", "The TabAgent Chrome extension is not connected", PAIRING_HINT);
      }
      // Legacy extensions can't ask for path validation after approval; validate up front for them only.
      if (tool.name === "act.upload" && !this.ext!.features.has("files.resolve")) params.paths = resolveUploads(params.paths as string[], this.cfg.uploadDirs);
      const resp = await this.send(meta, tool.name, params);
      if (resp.ok) return this.afterResult(meta, tool.name, resp);
      return resp;
    } catch (e) {
      const err = toTabAgentError(e);
      this.audit.minimal(tool?.name ?? String(toolName).slice(0, 64), err.code === "PERMISSION_DENIED" ? "denied" : "error", who, err.code);
      return { ok: false, error: err.toJSON() };
    }
  }

  /** Wrapped response for the output edge (D21). MCP, REST and CLI all go through here. */
  async call(meta: SessionMeta, toolName: string, params: unknown): Promise<OutputResponse> {
    return wrapResponse(await this.dispatchRaw(meta, toolName, params), getTool(toolName)).response;
  }

  private afterResult(meta: SessionMeta, tool: string, resp: OutputResponse): OutputResponse {
    this.downloads.note(meta.id, resp.downloads);
    const r = resp.result as Record<string, any> | undefined;
    if (tool === "downloads.wait" && r) this.downloads.noteOne(meta.id, r);
    if (tool === "downloads.list" && r) this.downloads.note(meta.id, r.downloads);
    if (r && typeof r === "object" && Array.isArray(r.downloads) && tool !== "downloads.list") this.downloads.note(meta.id, r.downloads);
    if (r && typeof r === "object" && r.__bridgeRead) {
      const { __bridgeRead: br, ...rest } = r;
      try {
        const id = Number(br.id ?? rest.id);
        const path = this.downloads.check(meta.id, id, String(br.path));
        const content = readDownload(path, this.cfg.maxReadBytes);
        return { ...resp, result: { id, mime: br.mime ?? rest.mime, ...content } };
      } catch (e) {
        const err = toTabAgentError(e);
        this.audit.minimal(tool, "error", { caller: meta.label, session: meta.id }, err.code, "bridge file read");
        return { ok: false, error: err.toJSON() };
      }
    }
    return resp;
  }

  /** How long the bridge waits for a command. auth.handoff waits as long as the configured handoff timeout (#61). */
  commandTimeoutMs(tool: string, params: Record<string, unknown>, meta?: SessionMeta): number {
    const t = Number(params.timeout ?? 0) || defaultTimeout(tool);
    const extra = tool === "auth.handoff" ? Math.max(authExtraTimeout(tool), this.handoff.timeoutMs()) : authExtraTimeout(tool);
    // Generous: a permission prompt (120s) plus the tool's own timeout plus slack.
    return TIMEOUTS.prompt + Math.min(t, TIMEOUTS.max) + 15_000 + extra + (meta ? captchaExtraTimeout(tool, meta) : 0);
  }

  private send(meta: SessionMeta, tool: string, params: Record<string, unknown>): Promise<OutputResponse> {
    const id = randomUUID();
    const ms = this.commandTimeoutMs(tool, params, meta);
    const ws = this.ext!.ws;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.handoff.commandEnded(id);
        resolve({ ok: false, error: { code: "TIMEOUT", message: `${tool} did not finish in ${Math.round(ms / 1000)}s` } });
      }, ms);
      this.pending.set(id, { resolve, timer, ws, meta, tool, params });
      this.sendTo(ws, { type: "command", id, session: meta, tool, params });
    });
  }

  endSession(sessionId: string) {
    this.downloads.drop(sessionId);
    if (this.extensionConnected) this.sendTo(this.ext!.ws, { type: "session.closed", sessionId });
  }

  gcRestSessions(now = this.now()) {
    for (const [k, s] of this.restSessions) {
      // A session with a live inbox stream is in use even when it makes no calls (AD4).
      if (!s.persistent && !this.agents.inbox.get(k) && now - s.lastSeen > TIMEOUTS.restSessionIdle) {
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

  /** Live reload of tokens (and newly paired IDs) when the CLI edits config.json. */
  private refreshConfig() {
    try {
      const m = statSync(configPath()).mtimeMs;
      if (m === this.cfgMtime) return;
      this.cfgMtime = m;
      const raw = JSON.parse(readFileSync(configPath(), "utf8"));
      this.cfg.tokens = raw.tokens ?? [];
      if (Array.isArray(raw.uploadDirs)) this.cfg.uploadDirs = raw.uploadDirs;
    } catch {
      /* keep current */
    }
  }

  principal(req: IncomingMessage): Principal | null {
    this.refreshConfig();
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

    if (path.startsWith("/v1/admin/")) return this.auth.onAdmin(req, res, who.kind === "secret", path, () => this.readBody(req));
    if (path === "/mcp") return this.onMcp(req, res, who, url);
    if (path === INBOX_PATH && req.method === "GET") return this.onInbox(req, res, who, url);

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
        pairCode: who.kind === "secret" ? this.pairCode : undefined,
        mcpSessions: this.mcpSessions.size,
        restSessions: this.restSessions.size,
      });
    }
    if (path === "/v1/pair" && req.method === "POST") {
      if (who.kind !== "secret") return this.err(res, "UNAUTHORIZED", "Only the local owner can create pairing codes", 403);
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
    // #108: approvals outside the side panel. Local owner only; every answer needs presence (approvals/index.ts).
    if (path === "/v1/approvals" || path.startsWith("/v1/approvals/")) {
      if (who.kind !== "secret") return this.err(res, "UNAUTHORIZED", "Only the local owner can see or answer prompts", 403);
      if (path === "/v1/approvals" && req.method === "GET") return this.sendJson(res, 200, { ok: true, ...this.approvals.view() });
      if (path === "/v1/approvals/answer" && req.method === "POST") {
        // Only promptId and answer are read: nothing in the request can stand in for presence.
        const r = await this.approvals.answerWithPresence(body?.promptId, body?.answer);
        return this.sendJson(res, approveStatus(r), r);
      }
      if (path === "/v1/approvals/phone" && req.method === "POST") {
        const r = await this.approvals.phoneLinkWithPresence(body?.ttlMin);
        return this.sendJson(res, r.ok ? 200 : approveStatus({ ok: false, outcome: r.outcome ?? "bad_request" }), r);
      }
      return this.err(res, "NOT_FOUND", `No route ${req.method} ${path}`);
    }
    if (path === INBOX_ACK_PATH && req.method === "POST") {
      const a = InboxAckSchema.safeParse(body);
      if (!a.success) return this.err(res, "BAD_REQUEST", "Expected {msgId}");
      if (!this.agents.inbox.ack(this.restKey(req, who, url), a.data.msgId)) return this.err(res, "NOT_FOUND", "No unacked push with that msgId for this session");
      return this.sendJson(res, 200, { ok: true });
    }
    if (path === INBOX_EVENT_PATH && req.method === "POST") {
      // AD9: the proxy ignored a channel permission-relay method. Audit only; nothing is relayed.
      const e = InboxEventSchema.safeParse(body);
      if (!e.success) return this.err(res, "BAD_REQUEST", 'Expected {event: "channel.permission_ignored", method}');
      const meta = this.restMeta(req, who, url);
      this.audit.event("agent.channel_permission_ignored", { method: e.data.method, session: meta.id }, { caller: meta.label, session: meta.id });
      return this.sendJson(res, 200, { ok: true });
    }
    if (path === "/v1/session/end" && req.method === "POST") {
      const meta = this.restMeta(req, who, url, body?.session ?? body?.sessionId);
      const key = this.restKey(req, who, url, body?.session ?? body?.sessionId);
      this.restSessions.delete(key);
      this.agents.onSessionEnd(key);
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
      // AD8: held panel messages ride on the session's next successful result, outside the PAGE_DATA wrapping.
      if (out.ok) this.attachHeld(res, this.restKey(req, who, url, legacy ? body.session : undefined), out);
      return this.sendJson(res, out.ok ? 200 : (STATUS[out.error!.code] ?? 200), out);
    }
    return this.err(res, "NOT_FOUND", `No route ${req.method} ${path}`);
  }

  /** AD8: attach held messages; `delivered` once the response is written, held again if it never is. */
  private attachHeld(res: ServerResponse, key: string, out: OutputResponse) {
    const held: Held[] = this.agents.takeHeld(key);
    if (!held.length) return;
    out.userMessages = held.map((h) => h.text);
    let written = false;
    res.once("finish", () => {
      written = true;
      this.agents.delivered(held);
    });
    res.once("close", () => {
      if (!written) this.agents.restoreHeld(key, held);
    });
  }

  /**
   * AD4/AD5: `GET /v1/inbox`, the stdio proxy's registration stream. Opening it creates the bridge session
   * eagerly (same restKey as the proxy's calls) and links the agent; closing it unlinks the agent at once.
   */
  private onInbox(req: IncomingMessage, res: ServerResponse, who: Principal, url: URL) {
    const key = this.restKey(req, who, url);
    const meta = this.restMeta(req, who, url);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    let open = true;
    const conn: InboxConn = {
      write: (event, data) => {
        if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close: () => {
        if (!open) return;
        open = false;
        res.end();
      },
    };
    const ping = setInterval(() => open && res.write(": ping\n\n"), INBOX_PING_MS);
    ping.unref();
    res.on("close", () => {
      open = false;
      clearInterval(ping);
      this.agents.inbox.close(key, conn);
    });
    const info = { sessionId: meta.id, meta, ...parseInboxHeaders(req.headers) };
    this.agents.inbox.open(key, info, conn);
    conn.write("ready", { sessionId: meta.id });
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
      const label = who.kind === "token" ? who.name : (proxy && client) || "local";
      s = { meta: { id: `${proxy ? "mcp" : "rest"}:${key}`, label, ...principalMeta(who) }, lastSeen: this.now(), persistent: proxy };
      this.restSessions.set(key, s);
    } else if (proxy && who.kind === "secret" && client && s.meta.label === "local") s.meta.label = client;
    // `tabagent token auto-captcha` takes effect on the session's next call.
    if (who.autoCaptcha) s.meta.autoCaptcha = true;
    else delete s.meta.autoCaptcha;
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
      const meta: SessionMeta = { id: `mcp-${randomUUID().slice(0, 8)}`, label: who.kind === "token" ? who.name : "local", ...principalMeta(who) };
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
          if (who.kind === "secret" && n) meta.label = n;
        },
      });
      await server.connect(transport);
      entry = { transport, meta };
    }
    await entry.transport.handleRequest(req, res, body);
  }
}
