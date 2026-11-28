// #108: answering a permission prompt outside the side panel (Touch ID through `tabagent approve`, or
// the phone page on the Tailscale address).
//
// The extension stays the only place that decides and applies answers. When the user has turned on
// "outside approvals" in the side panel, it mirrors its pending prompts to the bridge (`prompts.sync`,
// the full list on every change) with the exact text the panel shows. The bridge answers a prompt only
// after it has proof of the user's presence, by sending `prompt.answer` to the extension, which applies
// it through the same code path as a panel click: first answer wins, late answers never execute.
import { z } from "zod";
import { ToolErrorSchema } from "./messages";

/** Hello/welcome feature: the extension mirrors prompts and accepts `prompt.answer`; the bridge serves approvals. */
export const APPROVALS_FEATURE = "prompts.mirror";

export const PROMPT_ANSWERS = ["once", "always", "deny"] as const;
export type PromptAnswer = (typeof PROMPT_ANSWERS)[number];

/** Who answered a prompt. Recorded in the `decision` audit event. */
export const APPROVAL_CHANNELS = ["panel", "cli-presence", "phone"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];
/** Channels the bridge may name in `prompt.answer`. "panel" only ever comes from the extension's own pages. */
export const OUTSIDE_CHANNELS = ["cli-presence", "phone"] as const;
export type OutsideChannel = (typeof OUTSIDE_CHANNELS)[number];

/**
 * Result of trying to answer a prompt. `already_answered`: another channel won (first answer wins);
 * `expired`: the 120 s timeout passed, so the answer was not applied; `not_offered`: e.g. "always" on a
 * prompt that only offers once/deny; `disabled`: outside approvals are off in the side panel.
 */
export const ANSWER_OUTCOMES = ["applied", "already_answered", "expired", "not_found", "not_offered", "disabled"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

/** A pending prompt as the side panel renders it. Every channel shows exactly these strings. */
export const MirroredPromptSchema = z.object({
  promptId: z.string().min(1).max(100),
  title: z.string().max(1000),
  detail: z.string().max(1000),
  summary: z.string().max(2000),
  reasons: z.array(z.string().max(500)).max(20),
  tool: z.string().max(200),
  sessionLabel: z.string().max(100),
  origin: z.string().max(300),
  /** Epoch ms (extension clock, same machine). */
  expires: z.number(),
  /** Answers this prompt offers, in button order. "always" only where the panel shows it. */
  answers: z.array(z.enum(PROMPT_ANSWERS)).min(1).max(3),
  /** The panel's label for the "always" button, e.g. "Always allow read". */
  alwaysLabel: z.string().max(100).optional(),
});
export type MirroredPrompt = z.infer<typeof MirroredPromptSchema>;

// ---------------------------------------------------------------------------
// Extension -> bridge
// ---------------------------------------------------------------------------
/** The full list of pending prompts. `enabled: false` (outside approvals off) always carries an empty list. */
export const PromptsSyncSchema = z.object({
  type: z.literal("prompts.sync"),
  enabled: z.boolean(),
  prompts: z.array(MirroredPromptSchema).max(50),
});
export type PromptsSync = z.infer<typeof PromptsSyncSchema>;

export const PromptAnswerResultSchema = z.object({
  type: z.literal("prompt.answer.result"),
  id: z.string().min(1).max(100),
  ok: z.boolean(),
  outcome: z.enum(ANSWER_OUTCOMES),
  /** For already_answered: the channel that won, when the extension still remembers it. */
  by: z.enum(APPROVAL_CHANNELS).optional(),
});
export type PromptAnswerResult = z.infer<typeof PromptAnswerResultSchema>;

/** The side panel asks for a one-time phone approval link (a click in the panel is the presence proof). */
export const ApprovalsLinkRequestSchema = z.object({ type: z.literal("approvals.link"), id: z.string().min(1).max(100) });

// ---------------------------------------------------------------------------
// Bridge -> extension
// ---------------------------------------------------------------------------
export const PromptAnswerSchema = z.object({
  type: z.literal("prompt.answer"),
  id: z.string().min(1).max(100),
  promptId: z.string().min(1).max(100),
  answer: z.enum(PROMPT_ANSWERS),
  channel: z.enum(OUTSIDE_CHANNELS),
});
export type PromptAnswerMessage = z.infer<typeof PromptAnswerSchema>;

export const ApprovalsLinkResultSchema = z.object({
  type: z.literal("approvals.link.result"),
  id: z.string().min(1).max(100),
  ok: z.boolean(),
  url: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
  error: ToolErrorSchema.optional(),
});
export type ApprovalsLinkResult = z.infer<typeof ApprovalsLinkResultSchema>;

export const APPROVALS_EXT_MESSAGE_TYPES = ["prompts.sync", "prompt.answer.result", "approvals.link"] as const;

/** Button text for an answer, as the side panel labels it. */
export function answerLabel(answer: PromptAnswer, alwaysLabel?: string): string {
  return answer === "once" ? "Allow once" : answer === "deny" ? "Deny" : (alwaysLabel ?? "Always allow");
}
