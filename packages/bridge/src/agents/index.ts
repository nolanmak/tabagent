// Send to agent, bridge side (docs/specs/agent-inbox.md). Handles the extension's agents.* / agent.*
// messages. Only the paired /ext socket reaches this (the daemon checks); there is no REST route (AD2).
import { agentSendOverLimit, AgentSendSchema, AgentsListSchema, type Agent, type AgentSend, type AgentSent, type BridgeToExt } from "@tabagent/protocol";
import { agentSendAudit } from "./audit";
import { composeAgentMessage } from "./compose";
import { parseAgentId } from "./discovery";
import { AgentDiscovery, type DiscoveryOpts } from "./discovery-service";
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
}

type Send = (m: BridgeToExt) => void;
type Reply = Omit<AgentSent, "type" | "requestId">;

const WHO = { caller: "side panel" };

export class AgentsBridge {
  readonly discovery: AgentDiscovery;
  private watchers = new Set<QueueWatcher>();

  constructor(private o: AgentsOpts = {}) {
    this.discovery = new AgentDiscovery(o);
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
    // 2. Route (AD6). P1 ships queue and spawn; nothing is linked yet, so channel/piggyback cannot come up.
    const route = chooseRoute({ vendor: agent.vendor, status: agent.status, linked: agent.linked });
    if (route !== "queue" && route !== "spawn") return { route: "none", state: "failed", code: "NO_ROUTE", detail: agent.status === "error" ? `This agent cannot take messages (${agent.statusLabel ?? "error"})` : "No way to deliver to this agent" };
    // 3. Limits (AD13). The kill switch (AD17) is enforced by the worker, which knows the paused state.
    const over = agentSendOverLimit(req);
    if (over) return { route, state: "failed", code: "TOO_LARGE", detail: `The ${over.field} is ${over.length} characters; the limit is ${over.limit}` };
    // 4. Tab grant: P2a. 5. Compose: in P1 always the no-tab template.
    const text = composeAgentMessage(req, { grant: null });
    // 6. Deliver.
    if (route === "spawn") {
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

  private finish(send: Send, req: { requestId: string; agentId: string }, agent: Agent | null, out: Reply) {
    send({ type: "agent.sent", requestId: req.requestId, ...out });
    this.o.audit?.event("agent.send", agentSendAudit(req, agent, out), WHO);
  }
}
