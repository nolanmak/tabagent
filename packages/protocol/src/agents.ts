// Send to agent (docs/specs/agent-inbox.md): wire shapes for discovery between extension and bridge.
// AD1 names, AD3 ids, AD6 routes, AD16 feature flag, §5 response.
import { z } from "zod";

/** AD16: advertised in hello `features` by the extension and in welcome `features` by the bridge. */
export const AGENTS_FEATURE = "agents";

export const AGENT_VENDORS = ["claude", "codex"] as const;
export type AgentVendor = (typeof AGENT_VENDORS)[number];

/** AD6: one enum for the route the bridge would pick (`delivery`) and the route it used (`agent.sent.route`). */
export const AGENT_ROUTES = ["channel", "piggyback", "queue", "spawn", "none"] as const;
export type AgentRoute = (typeof AGENT_ROUTES)[number];

export const AGENT_STATUSES = ["busy", "idle", "error"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AgentSchema = z.object({
  /** AD3: `claude:<pid>:<startedAt>` or `codex:<threadId>`. Never a sessionId or a display name. */
  id: z.string().min(1),
  vendor: z.enum(AGENT_VENDORS),
  /** From the vendor record; null when it has none (the panel then shows cwd basename and age). */
  name: z.string().nullable(),
  cwd: z.string(),
  /** Epoch ms. */
  startedAt: z.number(),
  pid: z.number().int().optional(),
  status: z.enum(AGENT_STATUSES),
  statusLabel: z.string().optional(),
  linked: z.boolean(),
  canDriveTab: z.boolean(),
  delivery: z.enum(AGENT_ROUTES),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AGENT_SOURCE_STATES = ["ok", "unavailable"] as const;
export const AgentSourcesSchema = z.object({
  claude: z.enum(AGENT_SOURCE_STATES),
  codex: z.enum(AGENT_SOURCE_STATES),
});
export type AgentSources = z.infer<typeof AgentSourcesSchema>;

/** Worker -> bridge (paired /ext socket only, AD2/AD14). `id` correlates the reply. */
export const AgentsListSchema = z.object({
  type: z.literal("agents.list"),
  id: z.string().min(1),
});
export type AgentsList = z.infer<typeof AgentsListSchema>;

/** Bridge -> worker. A failed source is reported in `sources`; it never fails the call (§5). */
export const AgentsListedSchema = z.object({
  type: z.literal("agents.listed"),
  id: z.string().min(1),
  agents: z.array(AgentSchema),
  sources: AgentSourcesSchema,
});
export type AgentsListed = z.infer<typeof AgentsListedSchema>;
