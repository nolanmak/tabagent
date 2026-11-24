// #61 Part B: remote handoff wire between bridge and extension.
//
// The bridge serves a phone page for one handed-off tab over the tailnet. The bridge never learns a
// tab id: it knows a handoff by an opaque handoffId, and the extension maps that id to the one tab it
// handed off. The page can only ask for a frame (screenshot), send one of four input kinds, or end the
// handoff. There is no navigation, no script evaluation and no way to name another tab.
import { z } from "zod";
import { ToolErrorSchema } from "./messages";

/** Default handoff timeouts in minutes: local (DA9) and remote (#61). `handoff.timeoutMin` overrides. */
export const HANDOFF_LOCAL_TIMEOUT_MIN = 5;
export const HANDOFF_REMOTE_TIMEOUT_MIN = 30;
export const HANDOFF_TIMEOUT_MIN_MAX = 120;

/** Keys the phone page can press. No modifiers, so no shortcuts (no Ctrl+L, no DevTools). */
export const HANDOFF_KEYS = ["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"] as const;

const unit = z.number().min(0).max(1);
export const HandoffInputSchema = z.discriminatedUnion("kind", [
  /** x/y are 0..1 of the screenshot; the extension scales them to the tab's CSS viewport. */
  z.strictObject({ kind: z.literal("tap"), x: unit, y: unit }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal("key"), key: z.enum(HANDOFF_KEYS) }),
  z.strictObject({ kind: z.literal("scroll"), x: unit, y: unit, dy: z.number().min(-4000).max(4000) }),
]);
export type HandoffInput = z.infer<typeof HandoffInputSchema>;

export const HandoffResultSchema = z.enum(["done", "cancel"]);

// ---------------------------------------------------------------------------
// Extension -> bridge
// ---------------------------------------------------------------------------
/** Sent during an in-flight auth.handoff command, after the debugger is detached. */
export const HandoffOpenSchema = z.object({
  type: z.literal("handoff.open"),
  id: z.string().min(1).max(100),
  commandId: z.string().min(1).max(100),
  origin: z.string().max(300),
  reason: z.string().max(500),
  sessionLabel: z.string().max(100),
});
export const HandoffClosedSchema = z.object({ type: z.literal("handoff.closed"), handoffId: z.string().min(1).max(100), outcome: z.string().max(40) });
export const HandoffFrameResultSchema = z.object({
  type: z.literal("handoff.frame.result"),
  id: z.string().min(1),
  ok: z.boolean(),
  mime: z.enum(["image/jpeg", "image/png"]).optional(),
  dataBase64: z.string().optional(),
  error: ToolErrorSchema.optional(),
});
export const HandoffInputResultSchema = z.object({ type: z.literal("handoff.input.result"), id: z.string().min(1), ok: z.boolean(), error: ToolErrorSchema.optional() });

export const HANDOFF_EXT_MESSAGE_TYPES = ["handoff.open", "handoff.closed", "handoff.frame.result", "handoff.input.result"] as const;
export function isHandoffExtMessage(m: unknown): boolean {
  return !!m && typeof m === "object" && (HANDOFF_EXT_MESSAGE_TYPES as readonly string[]).includes(String((m as { type?: unknown }).type));
}

// ---------------------------------------------------------------------------
// Bridge -> extension
// ---------------------------------------------------------------------------
export type HandoffBridgeToExt =
  | { type: "handoff.opened"; id: string; ok: boolean; handoffId: string | null; url: string | null; expiresAt?: number; timeoutMs: number; error?: { code: string; message: string } }
  | { type: "handoff.end"; handoffId: string; result: "done" | "cancel" }
  | { type: "handoff.frame"; id: string; handoffId: string }
  | { type: "handoff.input"; id: string; handoffId: string; input: HandoffInput };

export const HANDOFF_BRIDGE_MESSAGE_TYPES = ["handoff.opened", "handoff.end", "handoff.frame", "handoff.input"] as const;
