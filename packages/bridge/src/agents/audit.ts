// AD15: the audit record for one send. Origin only, a hash of the typed prompt, never any content. Pure.
import { createHash } from "node:crypto";
import { originOf, type AgentDeliveryState, type AgentRoute, type AgentSendCode, type AgentVendor } from "@tabagent/protocol";
import { parseAgentId } from "./discovery";

export interface AuditInput {
  requestId: string;
  agentId: string;
  prompt?: unknown;
  includeTab?: unknown;
  url?: unknown;
}

export function agentSendAudit(
  req: AuditInput,
  agent: { vendor: AgentVendor } | null,
  out: { route: AgentRoute; state: AgentDeliveryState; code?: AgentSendCode },
): Record<string, unknown> {
  return {
    requestId: req.requestId,
    agentId: req.agentId,
    vendor: agent?.vendor ?? parseAgentId(req.agentId)?.vendor ?? null,
    route: out.route,
    state: out.state,
    ...(out.code ? { code: out.code } : {}),
    promptSha256: typeof req.prompt === "string" ? createHash("sha256").update(req.prompt).digest("hex") : null,
    tabOrigin: req.includeTab === true && typeof req.url === "string" ? originOf(req.url) : null,
  };
}
