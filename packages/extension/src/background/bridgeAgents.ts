// Send to agent, worker side (docs/specs/agent-inbox.md AD1, AD16, AD17, §6): agents.list -> agents.listed
// and agent.send -> agent.sent over the bridge socket, plus agent.status events. Chrome-free; index.ts
// wires the sender and routes bridge messages here.
import { AGENTS_FEATURE, AgentSendSchema, TabAgentError, type Agent, type AgentSend, type AgentSendCode, type AgentSent, type AgentSources, type AgentStatusEvent } from "@tabagent/protocol";

type Sender = (msg: unknown) => boolean;
let sender: Sender | null = null;

export function setAgentsSender(fn: Sender) {
  sender = fn;
}

/** AD16: the panel shows the Agents section only when both sides advertise the feature. */
export function agentsSupported(extFeatures: readonly string[], bridgeFeatures: readonly string[]): boolean {
  return extFeatures.includes(AGENTS_FEATURE) && bridgeFeatures.includes(AGENTS_FEATURE);
}

export interface AgentListResult {
  agents: Agent[];
  sources: AgentSources;
}

const lists = new Map<string, { resolve: (r: AgentListResult) => void; timer: ReturnType<typeof setTimeout> }>();

/** The bridge runs both sources with 5 s timeouts each; allow for the Codex handshake on top. */
export function listAgents(timeoutMs = 15_000): Promise<AgentListResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!sender || !sender({ type: "agents.list", id })) {
      reject(new TabAgentError("NO_EXTENSION", "The bridge is not connected, so agents cannot be listed"));
      return;
    }
    const timer = setTimeout(() => {
      lists.delete(id);
      reject(new TabAgentError("TIMEOUT", "The bridge did not list agents in time"));
    }, timeoutMs);
    lists.set(id, { resolve, timer });
  });
}

// ---------------------------------------------------------------------------
// Send (§6): ui.agent_send -> agent.send -> agent.sent; agent.status events relayed to the panel
// ---------------------------------------------------------------------------

/** The worker gives up on the bridge after this and answers failed / TIMEOUT (§6). */
export const AGENT_SEND_TIMEOUT_MS = 20_000;

const failed = (requestId: string, code: AgentSendCode, detail: string): AgentSent => ({ type: "agent.sent", requestId, route: "none", state: "failed", code, detail });

/**
 * Turn the panel's ui.agent_send into the wire agent.send, or into an immediate reply. The kill switch is
 * enforced here (AD17): the worker owns the paused state, so a paused send never reaches the bridge.
 */
export function agentSendRequest(ui: any, paused: boolean): { ok: true; msg: AgentSend } | { ok: false; reply: AgentSent } {
  const requestId = typeof ui?.requestId === "string" && ui.requestId ? ui.requestId : crypto.randomUUID();
  if (paused) return { ok: false, reply: failed(requestId, "PAUSED", "TabAgent is paused (kill switch). Resume it to send.") };
  const r = AgentSendSchema.safeParse({ ...ui, type: "agent.send", requestId });
  if (!r.success) return { ok: false, reply: failed(requestId, "BAD_REQUEST", "Malformed send request") };
  return { ok: true, msg: r.data };
}

const sends = new Map<string, { resolve: (r: AgentSent) => void; timer: ReturnType<typeof setTimeout> }>();
let statusListener: ((m: AgentStatusEvent) => void) | null = null;

/** index.ts relays agent.status to the side panel through this. */
export function setAgentStatusListener(fn: (m: AgentStatusEvent) => void) {
  statusListener = fn;
}

/** Never rejects: a missing bridge or a silent one becomes a failed agent.sent. */
export function sendToAgent(msg: AgentSend, timeoutMs = AGENT_SEND_TIMEOUT_MS): Promise<AgentSent> {
  return new Promise((resolve) => {
    if (!sender || !sender(msg)) return resolve(failed(msg.requestId, "NO_EXTENSION", "The bridge is not connected"));
    const timer = setTimeout(() => {
      sends.delete(msg.requestId);
      resolve(failed(msg.requestId, "TIMEOUT", "The bridge did not answer in time; the message may still arrive"));
    }, timeoutMs);
    sends.set(msg.requestId, { resolve, timer });
  });
}

/** Called by index.ts for bridge messages; returns true when the message was ours. */
export function onAgentsBridgeMessage(msg: any): boolean {
  switch (msg?.type) {
    case "agent.sent": {
      const w = sends.get(msg.requestId);
      if (!w) return true;
      sends.delete(msg.requestId);
      clearTimeout(w.timer);
      w.resolve(msg as AgentSent);
      return true;
    }
    case "agent.status":
      statusListener?.(msg as AgentStatusEvent);
      return true;
    case "agents.listed": {
      const w = lists.get(msg.id);
      if (!w) return true;
      lists.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve({ agents: msg.agents ?? [], sources: msg.sources });
      return true;
    }
  }
  return false;
}
