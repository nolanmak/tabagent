// Send to agent, bridge side (docs/specs/agent-inbox.md). Handles the extension's agents.* messages.
// Only the paired /ext socket reaches this (the daemon checks); there is no REST route (AD2).
import { AgentsListSchema, type BridgeToExt } from "@tabagent/protocol";
import { AgentDiscovery, type DiscoveryOpts } from "./discovery-service";

export type AgentsOpts = DiscoveryOpts;

type Send = (m: BridgeToExt) => void;

export class AgentsBridge {
  readonly discovery: AgentDiscovery;

  constructor(o: AgentsOpts = {}) {
    this.discovery = new AgentDiscovery(o);
  }

  /** Returns true when the message was an agents.* message (handled or dropped). */
  onExtMessage(msg: unknown, send: Send): boolean {
    const type = (msg as { type?: unknown } | null)?.type;
    if (type !== "agents.list") return false;
    const r = AgentsListSchema.safeParse(msg);
    if (!r.success) return true;
    const { id } = r.data;
    void this.discovery.list().then(
      (l) => send({ type: "agents.listed", id, ...l }),
      () => send({ type: "agents.listed", id, agents: [], sources: { claude: "unavailable", codex: "unavailable" } }),
    );
    return true;
  }
}
