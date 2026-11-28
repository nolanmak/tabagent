// Wire messages between bridge and extension (D4, D5, D11, D14, D20), as zod schemas.
import { z } from "zod";
import { TasksChangedSchema, TasksLabeledSchema, TasksLabelSchema, TasksListedSchema, TasksListSchema, type TasksChanged, type TasksLabel, type TasksLabeled, type TasksList, type TasksListed } from "./tasks";
import {
  AgentEntriesSchema,
  AgentHistoryResultSchema,
  AgentHistorySchema,
  AgentUnwatchSchema,
  AgentWatchSchema,
  AgentSendSchema,
  AgentSentSchema,
  AgentsListedSchema,
  AgentsListSchema,
  AgentStatusSchema,
  type AgentSend,
  type AgentSent,
  type AgentsList,
  type AgentsListed,
  type AgentStatusEvent,
  type AgentEntries,
  type AgentHistory,
  type AgentHistoryResult,
  type AgentUnwatch,
  type AgentWatch,
} from "./agents";
import { ERROR_CODES } from "./errors";

/** Bumped on any incompatible wire change. Extension and npm package must carry the same value (#23). */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47615;

/** Timeout defaults and caps in ms (D15, D11, D4). */
export const TIMEOUTS = {
  /** Actions and page.find. */
  action: 5_000,
  /** nav.goto and nav.wait. */
  navigation: 30_000,
  /** Largest `timeout` any tool accepts; also the per-call cap for compound tools. */
  max: 120_000,
  /** A permission prompt waits this long, then PROMPT_TIMEOUT. */
  prompt: 120_000,
  /** Extension ping interval. */
  ping: 20_000,
  /** Bridge closes a socket silent for this long. */
  silentSocket: 45_000,
  /** Pairing code lifetime. */
  pairCode: 30 * 60_000,
  /** REST/CLI session idle expiry (D8). */
  restSessionIdle: 30 * 60_000,
} as const;

/** Wrong pairing attempts after which the current code is invalidated (D4). */
export const PAIR_MAX_ATTEMPTS = 5;

export const CapSchema = z.enum(["read", "act", "full"]);
export type Cap = z.infer<typeof CapSchema>;

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  /** Human label shown on the tab group: token name, else clientInfo.name, else "local" (D8). */
  label: z.string().min(1),
  /** Max level this client may use (D3). */
  cap: CapSchema,
  /** Hostname globs this client is limited to (empty = no extra limit). */
  sites: z.array(z.string()),
  /** #61: act.click / form.submit solve a blocking CAPTCHA on their own (per token, default off). */
  autoCaptcha: z.boolean().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const ToolErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional(),
  untrusted: z.literal(true).optional(),
});

// ---------------------------------------------------------------------------
// Extension -> bridge
// ---------------------------------------------------------------------------
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  extensionVersion: z.string().min(1),
  secret: z.string().optional(),
  pairCode: z.string().optional(),
  /** Optional capabilities, e.g. "files.resolve" (#11). */
  features: z.array(z.string()).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

export const PingSchema = z.object({ type: z.literal("ping") });

export const EVENT_NAMES = ["prompt", "decision", "killed", "resumed", "session.ended", "settings.changed"] as const;
export const EventSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type EventMessage = z.infer<typeof EventSchema>;

export const SensitiveCategorySchema = z.enum(["a", "b", "c", "d", "e", "f"]);

/** D20: built by the extension (params already redacted); the bridge adds caller + ts. */
export const AuditRecordSchema = z.object({
  tool: z.string().min(1),
  action: z.string().optional(),
  origin: z.string().nullable(),
  params: z.unknown(),
  outcome: z.enum(["ok", "error", "denied"]),
  errorCode: z.enum(ERROR_CODES).optional(),
  resultSummary: z.object({ bytes: z.number().int().nonnegative(), sha256: z.string() }),
  /** #131: a sign-in step was allowed without a prompt because the site signs in without asking. */
  authAuto: z.literal(true).optional(),
  /** #158: how long the command took in the extension (validate to envelope). Old extensions omit it. */
  durationMs: z.number().int().nonnegative().optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const NavigationSchema = z.object({ url: z.string(), title: z.string(), kind: z.string() });
export const DialogInfoSchema = z.object({ type: z.string(), message: z.string(), defaultPrompt: z.string().optional() });
export const DownloadInfoSchema = z.object({ id: z.number().int(), filename: z.string(), state: z.string() });
export type Navigation = z.infer<typeof NavigationSchema>;
export type DialogInfo = z.infer<typeof DialogInfoSchema>;
export type DownloadInfo = z.infer<typeof DownloadInfoSchema>;

/** D14 Result envelope. */
export const ResultEnvelopeSchema = z.object({
  type: z.literal("result"),
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: ToolErrorSchema.optional(),
  snapshotDiff: z.string().optional(),
  navigation: NavigationSchema.optional(),
  dialogs: z.array(DialogInfoSchema).optional(),
  downloads: z.array(DownloadInfoSchema).optional(),
  audit: AuditRecordSchema,
});
export type ResultEnvelope<R = unknown> = Omit<z.infer<typeof ResultEnvelopeSchema>, "result"> & { result?: R };

/**
 * #11: during act.upload, after the extension's site + sensitive(e) gate passed, the extension asks the
 * bridge to validate the paths (D31). The bridge answers with canonical real paths or an error.
 */
export const FilesResolveSchema = z.object({
  type: z.literal("files.resolve"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  paths: z.array(z.string()).min(1),
});
export type FilesResolve = z.infer<typeof FilesResolveSchema>;

// ---------------------------------------------------------------------------
// Bridge -> extension
// ---------------------------------------------------------------------------
export const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.number().int(),
  bridgeVersion: z.string().min(1),
  /** Only present right after pairing with a code. */
  secret: z.string().optional(),
  /** Optional bridge capabilities, e.g. "agents" (AD16). */
  features: z.array(z.string()).optional(),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

export const PongSchema = z.object({ type: z.literal("pong") });

export const CommandSchema = z.object({
  type: z.literal("command"),
  id: z.string().min(1),
  session: SessionMetaSchema,
  tool: z.string().min(1),
  params: z.unknown(),
});
export type Command<P = unknown> = Omit<z.infer<typeof CommandSchema>, "params"> & { params: P };

export const SessionClosedSchema = z.object({ type: z.literal("session.closed"), sessionId: z.string() });
export const BridgeErrorSchema = z.object({ type: z.literal("error"), error: ToolErrorSchema });

export const FilesResolvedSchema = z.object({
  type: z.literal("files.resolved"),
  id: z.string().min(1),
  ok: z.boolean(),
  paths: z.array(z.string()).optional(),
  error: ToolErrorSchema.optional(),
});
export type FilesResolved = z.infer<typeof FilesResolvedSchema>;

// ---------------------------------------------------------------------------
// Send to agent tab grant (docs/specs/agent-inbox.md AD11). Here rather than in agents.ts because it
// carries a SessionMeta.
// ---------------------------------------------------------------------------

/** Why the worker refused a grant; TIMEOUT is the bridge's own (no agent.granted in time). */
export const AGENT_GRANT_CODES = ["TAB_BUSY", "PERMISSION_DENIED", "NOT_FOUND", "PAUSED", "TIMEOUT", "FAILED"] as const;
export type AgentGrantCode = (typeof AGENT_GRANT_CODES)[number];

/** Bridge -> worker: attach `tabId` to the linked agent's session. A user-initiated Send is the attach consent. */
export const AgentGrantSchema = z.object({
  type: z.literal("agent.grant"),
  requestId: z.string().min(1).max(200),
  meta: SessionMetaSchema,
  tabId: z.number().int(),
});
export type AgentGrant = z.infer<typeof AgentGrantSchema>;

/** Worker -> bridge. `added`: this grant put the tab in the session (false when it was already there). */
export const AgentGrantedSchema = z.object({
  type: z.literal("agent.granted"),
  requestId: z.string().min(1).max(200),
  ok: z.boolean(),
  added: z.boolean().optional(),
  code: z.enum(AGENT_GRANT_CODES).optional(),
});
export type AgentGranted = z.infer<typeof AgentGrantedSchema>;

/** Bridge -> worker: a granted send expired, so ungroup the attached tab (never close it). */
export const AgentReleaseSchema = z.object({
  type: z.literal("agent.release"),
  sessionId: z.string().min(1),
  tabId: z.number().int(),
});
export type AgentRelease = z.infer<typeof AgentReleaseSchema>;

export const ExtToBridgeSchema = z.discriminatedUnion("type", [HelloSchema, PingSchema, EventSchema, ResultEnvelopeSchema, FilesResolveSchema, AgentsListSchema, AgentSendSchema, AgentGrantedSchema, AgentHistorySchema, AgentWatchSchema, AgentUnwatchSchema, TasksListSchema, TasksLabelSchema]);
export const BridgeToExtSchema = z.discriminatedUnion("type", [WelcomeSchema, PongSchema, CommandSchema, SessionClosedSchema, BridgeErrorSchema, FilesResolvedSchema, AgentsListedSchema, AgentSentSchema, AgentStatusSchema, AgentGrantSchema, AgentReleaseSchema, AgentHistoryResultSchema, AgentEntriesSchema, TasksListedSchema, TasksLabeledSchema, TasksChangedSchema]);

export type ToolErrorWire = z.infer<typeof ToolErrorSchema>;

/** Legacy shapes still accepted by the bridge so older extension builds keep working. */
export interface LegacyHello {
  type: "hello";
  secret?: string;
  pairCode?: string;
  version: string;
  extensionId?: string;
}
export interface LegacyResult<R = unknown> {
  type: "result";
  id: string;
  ok: boolean;
  result?: R;
  error?: ToolErrorWire;
}

export type ExtToBridge = Hello | LegacyHello | z.infer<typeof PingSchema> | EventMessage | ResultEnvelope | LegacyResult | FilesResolve | AgentsList | AgentSend | AgentGranted | AgentHistory | AgentWatch | AgentUnwatch | TasksList | TasksLabel;
export type BridgeToExt =
  | AgentGrant
  | AgentRelease
  | Welcome
  | z.infer<typeof PongSchema>
  | Command
  | z.infer<typeof SessionClosedSchema>
  | z.infer<typeof BridgeErrorSchema>
  | FilesResolved
  | AgentsListed
  | AgentSent
  | AgentStatusEvent
  | AgentHistoryResult
  | AgentEntries
  | TasksListed
  | TasksLabeled
  | TasksChanged;

/** Result type kept for existing extension code: the envelope with an optional audit record. */
export type Result<R = unknown> = Omit<ResultEnvelope<R>, "audit"> & { audit?: AuditRecord };

/** Map a legacy hello (`version`, no protocolVersion) onto the current schema. Pre-D5 builds are protocol 1. */
export function normalizeHello(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const h = raw as Record<string, unknown>;
  if (h.type !== "hello") return raw;
  const out: Record<string, unknown> = { ...h };
  if (out.extensionVersion === undefined && typeof h.version === "string") out.extensionVersion = h.version;
  if (out.protocolVersion === undefined && typeof h.version === "string") out.protocolVersion = 1;
  delete out.version;
  delete out.extensionId;
  return out;
}

/** Which side to update when protocol versions differ (D5). */
export function versionMismatchHint(extProtocol: number, bridgeProtocol: number = PROTOCOL_VERSION): string {
  return extProtocol < bridgeProtocol
    ? `Update the TabAgent extension (it speaks protocol ${extProtocol}; the bridge speaks ${bridgeProtocol}).`
    : `Update the @nolmak/tabagent npm package: npm i -g @nolmak/tabagent@latest (bridge speaks protocol ${bridgeProtocol}; the extension speaks ${extProtocol}).`;
}
