// #158 Timed tasks: a task groups one session's tool calls under a goal, with start/end times and an outcome.
// The bridge writes task.* audit events and stamps each record with taskId; the side panel and
// `tabagent tasks` read task summaries built from the audit log. Shapes only, plus the goal redaction.
import { z } from "zod";

/** Advertised in hello `features` by the extension and in welcome `features` by the bridge. */
export const TASKS_FEATURE = "tasks";

export const TASK_OUTCOMES = ["success", "failed", "abandoned", "unknown"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
/** What an agent (task.end) or the user (panel label) may set. */
export const TASK_END_OUTCOMES = ["success", "failed", "abandoned"] as const;
export const TASK_LABEL_OUTCOMES = ["success", "failed"] as const;

export const TASK_LIMITS = {
  goal: 500,
  note: 500,
  /** Calls kept per task summary; callCount and browserMs still count every call. */
  calls: 200,
  /** Tasks the bridge keeps in memory for the panel. */
  tasks: 200,
  /** Default idle gap (ms) that ends an implicit task. */
  idleMs: 5 * 60_000,
  /** An explicit task the agent never ended is closed as abandoned after this much silence. */
  explicitIdleMs: 30 * 60_000,
} as const;

export const TaskCallSchema = z.object({
  ts: z.number(),
  tool: z.string(),
  action: z.string().optional(),
  origin: z.string().nullable(),
  outcome: z.enum(["ok", "error", "denied"]),
  errorCode: z.string().optional(),
  durationMs: z.number().optional(),
});
export type TaskCall = z.infer<typeof TaskCallSchema>;

export const TaskSummarySchema = z.object({
  taskId: z.string(),
  session: z.string().optional(),
  caller: z.string().optional(),
  goal: z.string().nullable(),
  explicit: z.boolean(),
  startedAt: z.number(),
  /** Absent while the task is open. */
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  /** null while open. */
  outcome: z.enum(TASK_OUTCOMES).nullable(),
  /** The outcome came from the user's label in the side panel. */
  labeled: z.boolean().optional(),
  note: z.string().optional(),
  callCount: z.number(),
  /** Sum of the calls' durationMs: time spent in the browser rather than between calls. */
  browserMs: z.number(),
  origins: z.array(z.string()),
  /** Last call's end time; the idle timer runs from here. */
  lastAt: z.number(),
  calls: z.array(TaskCallSchema),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

// ---------------------------------------------------------------------------
// Wire: worker <-> bridge (only on the paired socket, only when both advertise TASKS_FEATURE)
// ---------------------------------------------------------------------------
export const TasksListSchema = z.object({ type: z.literal("tasks.list"), id: z.string().min(1).max(200), limit: z.number().int().positive().max(TASK_LIMITS.tasks).optional() });
export type TasksList = z.infer<typeof TasksListSchema>;

export const TasksListedSchema = z.object({ type: z.literal("tasks.listed"), id: z.string().min(1).max(200), tasks: z.array(TaskSummarySchema) });
export type TasksListed = z.infer<typeof TasksListedSchema>;

export const TasksLabelSchema = z.object({ type: z.literal("tasks.label"), id: z.string().min(1).max(200), taskId: z.string().min(1).max(200), outcome: z.enum(TASK_LABEL_OUTCOMES) });
export type TasksLabel = z.infer<typeof TasksLabelSchema>;

export const TasksLabeledSchema = z.object({ type: z.literal("tasks.labeled"), id: z.string().min(1).max(200), ok: z.boolean(), code: z.enum(["NOT_FOUND", "BAD_REQUEST"]).optional() });
export type TasksLabeled = z.infer<typeof TasksLabeledSchema>;

/** Bridge -> worker: some task started, gained a call, ended or was labeled. No payload: the panel re-lists. */
export const TasksChangedSchema = z.object({ type: z.literal("tasks.changed") });
export type TasksChanged = z.infer<typeof TasksChangedSchema>;

// ---------------------------------------------------------------------------
// Goal / note redaction. Agents write goals from the user's words, which can carry a card number,
// an SSN or "password: hunter2". Mask those before anything reaches the log.
// ---------------------------------------------------------------------------
export const TEXT_MASK = "••••";
const SECRET_PAIR = /\b(pass(?:word|wd|code)?|pwd|secret|token|api[-_ ]?key|pin|otp|cvv|cvc|ssn)(\s*(?:[:=]|\bis\b)\s*)("[^"]*"|'[^']*'|\S+)/gi;
const CARD_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN_RUN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Mask secrets in free text and cap its length. Never returns a matched secret. */
export function redactText(s: string, max: number = TASK_LIMITS.goal): string {
  const out = s
    .replace(SECRET_PAIR, (_m, k: string, sep: string) => `${k}${sep}${TEXT_MASK}`)
    .replace(CARD_RUN, TEXT_MASK)
    .replace(SSN_RUN, TEXT_MASK)
    .trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
