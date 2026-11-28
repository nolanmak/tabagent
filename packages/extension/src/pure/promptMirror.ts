// #108: what the extension tells the bridge about pending prompts, and how it handles an answer the
// bridge relays from Touch ID (`tabagent approve`) or the phone page. The bridge has checked presence;
// the extension still decides: it applies the answer through the same queue as a panel click.
import {
  MirroredPromptSchema,
  PromptAnswerSchema,
  type AnswerOutcome,
  type ApprovalChannel,
  type OutsideChannel,
  type PromptAnswer,
  type PromptAnswerResult,
  type PromptsSync,
} from "@tabagent/protocol";
import { promptView, type PromptLike } from "./promptView";

export interface AnswerAsResult {
  ok: boolean;
  outcome: AnswerOutcome;
  by?: ApprovalChannel;
}

/** Off in the side panel: the bridge learns nothing about prompts. Prompts too large for the wire are not mirrored. */
export function mirrorMessage(enabled: boolean, prompts: PromptLike[]): PromptsSync {
  if (!enabled) return { type: "prompts.sync", enabled: false, prompts: [] };
  const views = prompts.map(promptView).filter((v) => MirroredPromptSchema.safeParse(v).success);
  return { type: "prompts.sync", enabled: true, prompts: views.slice(0, 50) };
}

/** Handle `prompt.answer` from the bridge. Null when the message has no usable id (nothing to reply to). */
export function onBridgeAnswer(raw: unknown, enabled: boolean, answerAs: (promptId: string, answer: PromptAnswer, channel: OutsideChannel) => AnswerAsResult): PromptAnswerResult | null {
  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id || id.length > 100) return null;
  const reply = (r: AnswerAsResult): PromptAnswerResult => ({ type: "prompt.answer.result", id, ok: r.ok, outcome: r.outcome, ...(r.by ? { by: r.by } : {}) });
  const m = PromptAnswerSchema.safeParse(raw);
  if (!m.success) return reply({ ok: false, outcome: "not_found" });
  if (!enabled) return reply({ ok: false, outcome: "disabled" });
  return reply(answerAs(m.data.promptId, m.data.answer, m.data.channel));
}
