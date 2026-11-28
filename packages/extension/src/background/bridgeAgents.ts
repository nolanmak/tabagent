// Send to agent, worker side (docs/specs/agent-inbox.md AD1, AD16): agents.list -> agents.listed over
// the bridge socket. Chrome-free; index.ts wires the sender and routes bridge messages here.
import { AGENTS_FEATURE, TabAgentError, type Agent, type AgentSources } from "@tabagent/protocol";

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

/** Called by index.ts for bridge messages; returns true when the message was ours. */
export function onAgentsBridgeMessage(msg: any): boolean {
  switch (msg?.type) {
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
