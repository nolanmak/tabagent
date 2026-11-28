// Send to agent, bridge side (docs/specs/agent-inbox.md). Handles the extension's agents.* / agent.*
// messages. Only the paired /ext socket reaches this (the daemon checks); there is no REST route (AD2).
import { agentSendOverLimit, AgentSendSchema, CHANNEL_ACK_TIMEOUT_MS, AgentsListSchema, type Agent, type AgentRoute, type AgentSend, type AgentSent, type BridgeToExt } from "@tabagent/protocol";
import { agentSendAudit } from "./audit";
import { composeAgentMessage } from "./compose";
import { parseAgentId, type AgentBase, type AgentLink } from "./discovery";
import { AgentDiscovery, type DiscoveryOpts } from "./discovery-service";
import { HoldQueue, type HeldMessage } from "./hold";
import { InboxRegistry, profileCanDriveTab, type InboxStream } from "./inbox";
import { QUEUE_ADD_TIMEOUT_MS, queueAdd, QueueWatcher } from "./queue";
import { chooseRoute } from "./route";
import { runSpawn, SPAWN_TIMEOUT_MS } from "./spawn";

export interface AgentsOpts extends DiscoveryOpts {
  /** AD15 audit sink (the daemon's AuditWriter). */
  audit?: { event(event: string, data: Record<string, unknown>, who?: { caller: string }): void };
  /** Delivers later agent.status events to whichever extension socket is current. */
  sendToExt?: (m: BridgeToExt) => void;
  spawnTimeoutMs?: number;
  queueTimeoutMs?: number;
  queuePollMs?: number;
  queueWatchMs?: number;
  /** AD8 piggyback TTL; default $TABAGENT_HOLD_TTL_MS, else 30 min (e2e shortens it). */
  holdTtlMs?: number;
  holdMax?: number;
  /** AD9: how long to wait for the proxy to ack a channel push (default 5 s). */
  channelAckTimeoutMs?: number;
}

/** One piggybacked message waiting for its session's next successful tool result (AD8). */
export interface Held extends HeldMessage {
  req: AgentSend;
  agent: Agent;
  /** The inbox key (restKey) and bridge session it is held for. P2b releases the granted tab on expiry. */
  key: string;
  sessionId: string;
}

type Send = (m: BridgeToExt) => void;
type Reply = Omit<AgentSent, "type" | "requestId">;

const WHO = { caller: "side panel" };

/** Why a send has no route (NO_ROUTE). The panel shows the same words before Send. */
function noRouteDetail(a: Agent): string {
  if (a.vendor === "claude" && !a.linked) return "This session is not connected to TabAgent, so it cannot be messaged. Start a new session instead, or connect this one (update TabAgent and restart the session).";
  return a.status === "error" ? `This agent cannot take messages (${a.statusLabel ?? "error"})` : "No way to deliver to this agent";
}

const envTtl = () => {
  const n = Number(process.env.TABAGENT_HOLD_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export class AgentsBridge {
  readonly discovery: AgentDiscovery;
  /** AD4/AD5: the `GET /v1/inbox` streams, keyed by restKey. */
  readonly inbox: InboxRegistry;
  /** AD8: messages held per linked session. */
  readonly held: HoldQueue<Held>;
  private watchers = new Set<QueueWatcher>();

  constructor(private o: AgentsOpts = {}) {
    this.inbox = new InboxRegistry({ now: o.now, onClosed: (key) => this.held.drop(key, "The agent's TabAgent connection closed") });
    this.held = new HoldQueue<Held>({ max: o.holdMax, ttlMs: o.holdTtlMs ?? envTtl(), now: o.now, onExpire: (m, reason) => this.report(m, "expired", reason) });
    this.discovery = new AgentDiscovery({ ...o, linkOf: (a) => this.linkOf(a) });
  }

  /** AD4: a Claude agent is linked when a live stream registered its pid. Codex is never linked in v1. */
  private streamFor(a: Pick<AgentBase, "vendor" | "pid">): InboxStream | undefined {
    return a.vendor === "claude" && a.pid ? this.inbox.byAgentPid(a.pid) : undefined;
  }

  private linkOf(a: AgentBase): AgentLink | null {
    const s = this.streamFor(a);
    return s ? { canDriveTab: profileCanDriveTab(s.profile), channels: s.channels } : null;
  }

  /** AD8: everything held for this session, to attach to a successful tool result. */
  takeHeld(key: string): Held[] {
    return this.held.take(key);
  }

  /** The response carrying these was written (AD7 `delivered`). */
  delivered(items: Held[]) {
    for (const m of items) this.report(m, "delivered");
  }

  /** The response carrying these was never written: hold them again, keeping their TTL. */
  restoreHeld(key: string, items: Held[]) {
    if (this.inbox.get(key)) this.held.restore(key, items);
    else for (const m of items) this.report(m, "expired", "The agent's TabAgent connection closed");
  }

  /** The proxy ended its session (AD7: session end expires held messages). */
  onSessionEnd(key: string) {
    this.held.drop(key, "The agent's TabAgent session ended");
  }

  /** A later state for a held message: agent.status to the current extension socket, plus audit (AD7, AD15). */
  private report(m: Held, state: "delivered" | "expired", detail?: string) {
    this.o.sendToExt?.({ type: "agent.status", requestId: m.requestId, state, ...(detail ? { detail } : {}) });
    this.o.audit?.event("agent.send", agentSendAudit(m.req, m.agent, { route: "piggyback", state }), WHO);
  }

  /** Returns true when the message was an agents.* / agent.* message (handled or dropped). */
  onExtMessage(msg: unknown, send: Send): boolean {
    const type = (msg as { type?: unknown } | null)?.type;
    if (type === "agents.list") {
      this.onList(msg, send);
      return true;
    }
    if (type === "agent.send") {
      void this.onSend(msg, send);
      return true;
    }
    return false;
  }

  /** Stop every queue watcher (daemon shutdown). */
  stop() {
    for (const w of [...this.watchers]) w.stop();
    this.held.stop();
    this.inbox.closeAll();
  }

  private onList(msg: unknown, send: Send) {
    const r = AgentsListSchema.safeParse(msg);
    if (!r.success) return;
    const { id } = r.data;
    void this.discovery.list().then(
      (l) => send({ type: "agents.listed", id, ...l }),
      () => send({ type: "agents.listed", id, agents: [], sources: { claude: "unavailable", codex: "unavailable" } }),
    );
  }

  /** §6. Always replies agent.sent once the request carries a requestId, then audits (AD15). */
  private async onSend(msg: unknown, send: Send) {
    const parsed = AgentSendSchema.safeParse(msg);
    if (!parsed.success) {
      const raw = msg as { requestId?: unknown; agentId?: unknown };
      if (typeof raw.requestId !== "string" || !raw.requestId) return;
      const req = { ...(msg as object), requestId: raw.requestId, agentId: typeof raw.agentId === "string" ? raw.agentId : "" };
      return this.finish(send, req, null, { route: "none", state: "failed", code: "BAD_REQUEST", detail: "Malformed agent.send" });
    }
    const req = parsed.data;
    let agent: Agent | null = null;
    let out: Reply;
    try {
      agent = await this.discovery.resolve(req.agentId);
      out = await this.deliver(req, agent);
    } catch (e) {
      out = { route: "none", state: "failed", code: "AGENT_GONE", detail: (e as Error).message };
    }
    this.finish(send, req, agent, out);
  }

  private async deliver(req: AgentSend, agent: Agent | null): Promise<Reply> {
    // 1. Fresh re-resolution (AD3).
    if (!agent) return { route: "none", state: "failed", code: "AGENT_GONE", detail: "That agent is no longer running" };
    // 2. Route (AD6), from the fresh link.
    const stream = this.streamFor(agent);
    const route: AgentRoute = chooseRoute({ vendor: agent.vendor, status: agent.status, linked: agent.linked && !!stream, channels: stream?.channels }, { forceSpawn: req.forceSpawn });
    // #137: without forceSpawn this never spawns, so an unlinked Claude session fails here rather than
    // silently getting a new background session in its place.
    if (route === "none") return { route: "none", state: "failed", code: "NO_ROUTE", detail: noRouteDetail(agent) };
    // 3. Limits (AD13). The kill switch (AD17) is enforced by the worker, which knows the paused state.
    const over = agentSendOverLimit(req);
    if (over) return { route, state: "failed", code: "TOO_LARGE", detail: `The ${over.field} is ${over.length} characters; the limit is ${over.limit}` };
    // 4. Tab grant (AD11) is P2b (#97): it fills this in for canDriveTab targets; until then no grant.
    const grant = await this.tabGrant(req, agent, route);
    // 5. Compose (AD12).
    const text = composeAgentMessage(req, { grant });
    // 6. Deliver.
    if (route === "channel") return this.pushChannel(stream!, text);
    if (route === "piggyback") {
      const s = stream!;
      const held: Held = { requestId: req.requestId, text, req, agent, key: s.key, sessionId: s.sessionId };
      if (this.held.hold(s.key, held) === "full") return { route, state: "failed", code: "QUEUE_FULL", detail: `This agent already has ${this.held.max} messages waiting for its next browser action` };
      return { route, state: "held" };
    }
    if (route === "spawn") {
      // §6: choosing a new session drops anything still held for this agent.
      if (stream) this.held.drop(stream.key, "Replaced by a new session");
      const r = await runSpawn(this.discovery.claudeBin, text, agent.cwd, this.o.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
      return r.state === "started" ? { route, state: "started", detail: r.detail } : { route, state: "failed", code: r.code, detail: r.detail };
    }
    const threadId = (parseAgentId(agent.id) as { threadId: string }).threadId;
    const add = await queueAdd(this.discovery.codexSocket, threadId, req.requestId, text, this.o.queueTimeoutMs ?? QUEUE_ADD_TIMEOUT_MS);
    if (!add.ok) return { route, state: "failed", code: "QUEUE_FAILED", detail: add.detail };
    const w = new QueueWatcher(
      add.rpc,
      {
        socket: this.discovery.codexSocket,
        threadId,
        submissionId: add.submissionId,
        pollMs: this.o.queuePollMs,
        watchMs: this.o.queueWatchMs,
        connectTimeoutMs: this.discovery.codexTimeoutMs,
        onDelivered: () => {
          this.o.sendToExt?.({ type: "agent.status", requestId: req.requestId, state: "delivered" });
          this.o.audit?.event("agent.send", agentSendAudit(req, agent, { route, state: "delivered" }), WHO);
        },
      },
      () => this.watchers.delete(w),
    );
    this.watchers.add(w);
    return { route, state: "queued" };
  }

  /**
   * AD7/AD9: push `{kind: "channel", content}` on the agent's inbox stream; `sent` once the proxy acks that it
   * wrote notifications/claude/channel. Unconfirmed: Claude may still drop it, so never `delivered`.
   */
  private async pushChannel(s: InboxStream, text: string): Promise<Reply> {
    const timeoutMs = this.o.channelAckTimeoutMs ?? CHANNEL_ACK_TIMEOUT_MS;
    const r = await this.inbox.pushAndWait(s.key, { kind: "channel", content: text }, timeoutMs);
    if (r === "acked") return { route: "channel", state: "sent" };
    if (r === "timeout") return { route: "channel", state: "failed", code: "CHANNEL_TIMEOUT", detail: `The agent's TabAgent connection did not confirm the message within ${Math.round(timeoutMs / 100) / 10} s` };
    return { route: "channel", state: "failed", code: "AGENT_GONE", detail: "The agent's TabAgent connection closed" };
  }

  /**
   * AD11 hook for P2b (#97): for a canDriveTab target with includeTab, send agent.grant and wait for
   * agent.granted, returning `{tabId}` on success. P2a never grants, so linked agents get the no-tab template.
   */
  private async tabGrant(_req: AgentSend, _agent: Agent, _route: AgentRoute): Promise<{ tabId: number } | null> {
    return null;
  }

  private finish(send: Send, req: { requestId: string; agentId: string }, agent: Agent | null, out: Reply) {
    send({ type: "agent.sent", requestId: req.requestId, ...out });
    this.o.audit?.event("agent.send", agentSendAudit(req, agent, out), WHO);
  }
}
