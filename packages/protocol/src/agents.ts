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
  /**
   * #137: the readable label. Claude: the session's last `custom-title`, else its last `ai-title` (from the
   * transcript), else `name`. Codex: the thread name. Absent when there is none (older bridges never send it).
   */
  title: z.string().optional(),
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

// ---------------------------------------------------------------------------
// Send (§6): agent.send -> agent.sent, then agent.status events
// ---------------------------------------------------------------------------

/** AD7: what the bridge can observe about one send. Never the agent's busy/idle status. */
export const AGENT_DELIVERY_STATES = ["sent", "held", "delivered", "queued", "started", "expired", "failed"] as const;
export type AgentDeliveryState = (typeof AGENT_DELIVERY_STATES)[number];

/** Why a send failed. The worker produces PAUSED, NO_EXTENSION and TIMEOUT; the bridge the rest. */
export const AGENT_SEND_CODES = [
  "AGENT_GONE",
  "NO_ROUTE",
  "TOO_LARGE",
  "PAUSED",
  "NO_CWD",
  "WORKSPACE_UNTRUSTED",
  "SPAWN_FAILED",
  "QUEUE_FAILED",
  "QUEUE_FULL",
  "CHANNEL_TIMEOUT",
  "BAD_REQUEST",
  "NO_EXTENSION",
  "TIMEOUT",
] as const;
export type AgentSendCode = (typeof AGENT_SEND_CODES)[number];

/** AD13, in string length (UTF-16 code units). The panel pre-checks; the bridge rejects with TOO_LARGE. */
export const AGENT_LIMITS = { prompt: 8_000, selection: 16_000, title: 500, url: 2_000 } as const;
export type AgentLimitField = keyof typeof AGENT_LIMITS;

/** First field over its AD13 limit, or null. Nothing is ever truncated. */
export function agentSendOverLimit(f: Partial<Record<AgentLimitField, string | undefined>>): { field: AgentLimitField; limit: number; length: number } | null {
  for (const field of Object.keys(AGENT_LIMITS) as AgentLimitField[]) {
    const v = f[field];
    if (typeof v === "string" && v.length > AGENT_LIMITS[field]) return { field, limit: AGENT_LIMITS[field], length: v.length };
  }
  return null;
}

/**
 * Worker -> bridge (AD12): the panel's raw fields. The bridge composes the message and treats title, url
 * and selection as untrusted page data. No length caps here, so an oversized send still gets a reply.
 */
export const AgentSendSchema = z.object({
  type: z.literal("agent.send"),
  requestId: z.string().min(1).max(200),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  includeTab: z.boolean(),
  /** Chrome tab id (the same id the `tabId` tool parameter takes). */
  tabId: z.number().int().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  selection: z.string().optional(),
  /**
   * The user pressed the explicit "Start a new session in <folder>" button (§7, #137): route `spawn`
   * (Claude only, AD6), and any message still held for that agent expires. Without it the bridge never
   * spawns: an unlinked Claude session gets `none` / NO_ROUTE.
   */
  forceSpawn: z.boolean().optional(),
});
export type AgentSend = z.infer<typeof AgentSendSchema>;

/** Bridge -> worker, always sent, including on failure. `route` is the route used (AD6). */
export const AgentSentSchema = z.object({
  type: z.literal("agent.sent"),
  requestId: z.string().min(1),
  route: z.enum(AGENT_ROUTES),
  state: z.enum(AGENT_DELIVERY_STATES),
  code: z.enum(AGENT_SEND_CODES).optional(),
  detail: z.string().optional(),
});
export type AgentSent = z.infer<typeof AgentSentSchema>;

/** Bridge -> worker event: a later state for the same requestId (AD7). */
export const AgentStatusSchema = z.object({
  type: z.literal("agent.status"),
  requestId: z.string().min(1),
  state: z.enum(AGENT_DELIVERY_STATES),
  detail: z.string().optional(),
});
export type AgentStatusEvent = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// Agent inbox (AD4, AD5, AD8): the bridge -> stdio proxy stream. Internal; never a user-facing concept.
// ---------------------------------------------------------------------------

/** `GET` opens the SSE stream (same bearer auth as REST); `POST {msgId}` acks one push. */
export const INBOX_PATH = "/v1/inbox";
export const INBOX_ACK_PATH = "/v1/inbox/ack";
/** `POST` one proxy-side audit event (AD9: an ignored channel permission request). */
export const INBOX_EVENT_PATH = "/v1/inbox/event";

/**
 * Registration headers the proxy sends on `GET /v1/inbox` (AD4). `x-tabagent-session` is the same value
 * its REST calls carry, so the stream and the calls share one `restKey`. `profile` lets the bridge work out
 * canDriveTab; the bridge never parses the session id.
 */
export const INBOX_HEADERS = {
  session: "x-tabagent-session",
  client: "x-tabagent-client",
  agentPid: "x-tabagent-agent-pid",
  channels: "x-tabagent-channels",
  profile: "x-tabagent-profile",
} as const;

/** AD8: held messages per linked session, and how long one waits for a successful tool result. */
export const PIGGYBACK_LIMITS = { maxHeld: 3, ttlMs: 30 * 60_000 } as const;

/** SSE events on the inbox stream. `message` data always carries `msgId` (AD5). */
export const InboxPushSchema = z.object({ msgId: z.string().min(1) }).passthrough();
export type InboxPush = z.infer<typeof InboxPushSchema>;
export const InboxAckSchema = z.object({ msgId: z.string().min(1).max(200) });
/** AD9: the proxy ignored a channel permission-relay method; the bridge audits it. Nothing else is accepted. */
export const InboxEventSchema = z.object({ event: z.literal("channel.permission_ignored"), method: z.string().min(1).max(200) });

/** AD9: how long the bridge waits for the proxy to ack a channel push before reporting CHANNEL_TIMEOUT. */
export const CHANNEL_ACK_TIMEOUT_MS = 5_000;
