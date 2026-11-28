// #61 Part B: bridge side of remote handoff. The daemon holds one HandoffBridge and calls:
//   onExtMessage:   if (this.handoff.onExtMessage(msg, ws)) return;
//   ws close:       this.handoff.onSocketClosed(ws)
//   command ended:  this.handoff.commandEnded(id)       (result, timeout, failed)
//   send() timeout: tool === "auth.handoff" → this.handoff.timeoutMs()
//   gc tick:        this.handoff.sweep()
//   stop:           await this.handoff.stop()
//
// The remote listener runs only while at least one remote handoff is live: it is bound on the first
// one and closed when the last one ends, so the tailnet port is closed the rest of the time.
import { randomUUID } from "node:crypto";
import type { RequestListener } from "node:http";
import {
  HandoffClosedSchema,
  HandoffFrameResultSchema,
  HandoffInputResultSchema,
  HandoffOpenSchema,
  TabAgentError,
  type ErrorCode,
  type HandoffBridgeToExt,
  type HandoffInput,
} from "@tabagent/protocol";
import { handoffTimeoutMs, readHandoffConfig, type HandoffConfig } from "./config";
import { HandoffRegistry, type HandoffEntry } from "./registry";
import { createRemoteHandler, startRemoteListener, type ApprovalsRemote, type RemoteBackend, type RemoteListener } from "./remote";
import { detectTailnetIp } from "./tailnet";
import { postWebhook as realPostWebhook, webhookPayload } from "./webhook";

export interface HandoffAuditSink {
  event(event: string, data: Record<string, unknown> | undefined): void;
}

export interface HandoffBridgeOpts {
  inFlight: (commandId: string) => { tool: string; ws?: unknown } | undefined;
  sendTo: (ws: unknown, m: HandoffBridgeToExt) => void;
  audit: HandoffAuditSink;
  /** Bridge port; the remote listener uses the same number on the tailnet address. */
  port: () => number;
  config?: () => HandoffConfig;
  log?: (m: string) => void;
  now?: () => number;
  /** Tests: bind somewhere else. Production: the tailnet address only. */
  listen?: (handler: RequestListener) => Promise<RemoteListener>;
  postWebhook?: (url: string, body: unknown) => Promise<void>;
  /** How long a frame or an input waits for the extension. */
  requestTimeoutMs?: number;
}

interface Wait {
  kind: "frame" | "input";
  ws: unknown;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HandoffBridge implements RemoteBackend {
  readonly registry: HandoffRegistry;
  private listener: RemoteListener | null = null;
  private starting: Promise<RemoteListener> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private waits = new Map<string, Wait>();
  private handler: RequestListener;
  private approvals: ApprovalsRemote | undefined;
  private config: () => HandoffConfig;
  private log: (m: string) => void;
  private now: () => number;

  constructor(private o: HandoffBridgeOpts) {
    this.config = o.config ?? (() => readHandoffConfig());
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.registry = new HandoffRegistry({
      now: this.now,
      alive: (e) => {
        const f = o.inFlight(e.commandId);
        return !!f && f.tool === "auth.handoff" && (f.ws === undefined || f.ws === e.ws);
      },
      onRevoke: (e) => {
        this.audit("handoff.remote.revoke", e);
        for (const [id, w] of this.waits) {
          if (w.ws !== e.ws) continue;
          clearTimeout(w.timer);
          this.waits.delete(id);
          w.reject(new TabAgentError("NOT_FOUND", "The handoff ended"));
        }
      },
      onChange: (n) => {
        if (n === 0) this.closeListener();
      },
    });
    this.handler = createRemoteHandler({ expectedHost: () => (this.listener ? `${this.listener.ip}:${this.listener.port}` : "\0"), backend: this, approvals: () => this.approvals, log: this.log });
  }

  /** #108: serve phone approval links on the same tailnet listener. */
  attachApprovals(a: ApprovalsRemote) {
    this.approvals = a;
  }

  /** #108: bind (or reuse) the tailnet listener for an approval link. */
  async ensureRemote(): Promise<{ ip: string; port: number }> {
    let l = await this.ensureListener();
    if (this.listener !== l) l = await this.ensureListener();
    return { ip: l.ip, port: l.port };
  }

  /** #108: close the listener when neither a handoff nor an approval link is live. */
  releaseRemote() {
    this.closeListener();
  }

  timeoutMs(): number {
    return handoffTimeoutMs(this.config());
  }

  /** Returns true when the message was a handoff message (fully handled here). */
  onExtMessage(msg: unknown, ws: unknown): boolean {
    const m = msg as { type?: string; event?: unknown; data?: { kind?: unknown } } | null;
    if (m?.type === "event" && (m.event === "killed" || m.event === "kill" || m.data?.kind === "kill")) {
      this.registry.revokeAll();
      return false;
    }
    switch (m?.type) {
      case "handoff.open":
        void this.onOpen(msg, ws).catch((e) => this.log(`handoff: open failed (${(e as Error).message})`));
        return true;
      case "handoff.closed": {
        const p = HandoffClosedSchema.safeParse(msg);
        const e = p.success ? this.registry.get(p.data.handoffId) : undefined;
        if (e && e.ws === ws) this.registry.revoke(e.id);
        return true;
      }
      case "handoff.frame.result":
      case "handoff.input.result":
        this.onReply(msg, ws);
        return true;
    }
    return false;
  }

  commandEnded(commandId: string) {
    const e = this.registry.byCommand(commandId);
    if (e) this.registry.revoke(e.id);
  }

  onSocketClosed(ws: unknown) {
    this.registry.revokeWhere((e) => e.ws === ws);
  }

  sweep() {
    this.registry.sweep();
  }

  async stop() {
    this.registry.revokeAll();
    this.closeListener();
    await this.closing;
  }

  // -------------------------------------------------------------------------
  // Extension -> bridge
  // -------------------------------------------------------------------------
  private async onOpen(raw: unknown, ws: unknown) {
    const p = HandoffOpenSchema.safeParse(raw);
    if (!p.success) return;
    const { id, commandId, origin, reason, sessionLabel } = p.data;
    const cfg = this.config();
    const timeoutMs = handoffTimeoutMs(cfg);
    const reply = (m: { ok: boolean; handoffId?: string | null; url?: string | null; expiresAt?: number; error?: { code: ErrorCode; message: string } }) =>
      this.o.sendTo(ws, { type: "handoff.opened", id, timeoutMs, handoffId: null, url: null, ...m });
    const f = this.o.inFlight(commandId);
    if (!f || f.tool !== "auth.handoff" || (f.ws !== undefined && f.ws !== ws)) return reply({ ok: false, error: { code: "PERMISSION_DENIED", message: "No auth.handoff in flight with that id" } });
    if (this.registry.byCommand(commandId)) return reply({ ok: false, error: { code: "BAD_REQUEST", message: "This handoff already has a remote link" } });

    const expiresAt = this.now() + timeoutMs;
    let entry: HandoffEntry | null = null;
    let url: string | null = null;
    if (cfg.remote) {
      try {
        let l = await this.ensureListener();
        // The last handoff may have ended (closing the listener) while we waited: bind again.
        if (this.listener !== l) l = await this.ensureListener();
        if (!this.o.inFlight(commandId)) {
          this.closeListener();
          return reply({ ok: false, error: { code: "NOT_FOUND", message: "The handoff ended" } });
        }
        const c = this.registry.create({ commandId, ws, origin, reason, sessionLabel, ttlMs: timeoutMs });
        entry = c.entry;
        url = `http://${l.ip}:${l.port}/handoff/${c.entry.id}?t=${c.token}`;
      } catch (e) {
        this.closeListener();
        this.log(`handoff: remote page unavailable (${(e as Error).message}); the handoff stays local`);
      }
    }
    this.o.audit.event("handoff.open", { kind: "handoff", origin, remote: !!url, ...(entry ? { handoff: entry.id.slice(0, 8) } : {}) });
    reply({ ok: true, handoffId: entry?.id ?? null, url, expiresAt });
    if (cfg.webhook) {
      const post = this.o.postWebhook ?? realPostWebhook;
      // Never log the URL or the body: the body carries the one-time link.
      post(cfg.webhook, webhookPayload({ origin, reason, sessionLabel, url, expiresAt })).then(
        () => this.o.audit.event("handoff.webhook", { kind: "handoff", origin, outcome: "ok" }),
        (e) => {
          this.log(`handoff: webhook failed (${(e as Error).name})`);
          this.o.audit.event("handoff.webhook", { kind: "handoff", origin, outcome: "error" });
        },
      );
    }
  }

  private onReply(raw: unknown, ws: unknown) {
    const t = (raw as { type?: string }).type;
    const p = t === "handoff.frame.result" ? HandoffFrameResultSchema.safeParse(raw) : HandoffInputResultSchema.safeParse(raw);
    if (!p.success) return;
    const w = this.waits.get(p.data.id);
    if (!w || w.ws !== ws || (t === "handoff.frame.result") !== (w.kind === "frame")) return;
    this.waits.delete(p.data.id);
    clearTimeout(w.timer);
    if (p.data.ok) w.resolve(p.data);
    else w.reject(new TabAgentError((p.data.error?.code as ErrorCode) ?? "INTERNAL", "The extension could not complete the request"));
  }

  // -------------------------------------------------------------------------
  // RemoteBackend (phone -> extension, always for the entry's own handoff)
  // -------------------------------------------------------------------------
  private request(e: HandoffEntry, kind: Wait["kind"], msg: { type: "handoff.frame"; handoffId: string } | { type: "handoff.input"; handoffId: string; input: HandoffInput }): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        reject(new TabAgentError("TIMEOUT", "The extension did not answer in time"));
      }, this.o.requestTimeoutMs ?? 10_000);
      this.waits.set(id, { kind, ws: e.ws, resolve, reject, timer });
      this.o.sendTo(e.ws, { ...msg, id } as HandoffBridgeToExt);
    });
  }

  async frame(e: HandoffEntry): Promise<{ mime: string; data: Buffer }> {
    const r = await this.request(e, "frame", { type: "handoff.frame", handoffId: e.id });
    if (typeof r.dataBase64 !== "string" || !r.mime) throw new TabAgentError("INTERNAL", "No image");
    return { mime: r.mime, data: Buffer.from(r.dataBase64, "base64") };
  }

  async input(e: HandoffEntry, input: HandoffInput): Promise<void> {
    await this.request(e, "input", { type: "handoff.input", handoffId: e.id, input });
  }

  end(e: HandoffEntry, result: "done" | "cancel"): void {
    this.o.sendTo(e.ws, { type: "handoff.end", handoffId: e.id, result });
    this.audit("handoff.remote.end", e, { result });
    this.registry.revoke(e.id);
  }

  audit(event: string, e: HandoffEntry, data: Record<string, unknown> = {}) {
    // Never the token, the cookie or the link.
    this.o.audit.event(event, { kind: "handoff", origin: e.origin, handoff: e.id.slice(0, 8), ...data });
  }

  // -------------------------------------------------------------------------
  // Listener lifecycle
  // -------------------------------------------------------------------------
  private ensureListener(): Promise<RemoteListener> {
    if (this.listener) return Promise.resolve(this.listener);
    if (!this.starting) {
      const listen =
        this.o.listen ??
        (async (h: RequestListener) => {
          const ip = await detectTailnetIp();
          if (!ip) throw new Error("no Tailscale address found (is Tailscale up? `tailscale ip -4`)");
          return startRemoteListener(h, ip, this.o.port());
        });
      this.starting = (async () => {
        await this.closing;
        const l = await listen(this.handler);
        this.listener = l;
        this.log(`handoff: remote page listening on http://${l.ip}:${l.port} (tailnet only)`);
        return l;
      })().finally(() => (this.starting = null));
    }
    return this.starting;
  }

  private closeListener() {
    if (this.registry.size > 0 || (this.approvals?.links.size ?? 0) > 0 || !this.listener) return;
    const l = this.listener;
    this.listener = null;
    this.closing = this.closing.then(() => l.close()).catch(() => {});
    this.log("handoff: remote page closed (no live handoffs)");
  }
}
