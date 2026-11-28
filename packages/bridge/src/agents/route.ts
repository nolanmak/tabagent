// AD6: the route one send would use, chosen fresh at send time. Pure.
import type { AgentRoute, AgentStatus, AgentVendor } from "@tabagent/protocol";

export interface RouteTarget {
  vendor: AgentVendor;
  status: AgentStatus;
  /** AD4: the agent's own `tabagent mcp` proxy registered with the bridge. Always false until P2. */
  linked: boolean;
  /** AD9: the linked proxy reported `x-tabagent-channels: 1`. */
  channels?: boolean;
}

export interface RouteOpts {
  /** AD9: the channel route (P3, shipped after the P0 spike confirmed it). Default true; false forces the fallback. */
  channelEnabled?: boolean;
  /** The user pressed the explicit "Start a new session" button (Claude only). The only way to spawn (#137). */
  forceSpawn?: boolean;
}

export function chooseRoute(t: RouteTarget, o: RouteOpts = {}): AgentRoute {
  if (o.forceSpawn) return t.vendor === "claude" ? "spawn" : "none";
  if (t.linked && t.vendor === "claude" && t.channels && o.channelEnabled !== false) return "channel";
  if (t.linked) return "piggyback";
  // AD10: a Codex thread in systemError is listed but not sendable.
  if (t.vendor === "codex") return t.status === "error" ? "none" : "queue";
  // #137: an unlinked Claude session cannot be messaged. Never spawn a new session in its place unless
  // the user explicitly asked for one (forceSpawn, above).
  return "none";
}
