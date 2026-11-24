// #61 Part A: CAPTCHA solving. Registry entry for captcha.solve, the extension<->bridge solve wire, and
// the CAPTCHA_UNSOLVED reasons. Shared by bridge and extension.
//
// The one rule: the solver API key never leaves the bridge. The extension sends the widget facts
// (vendor, site key, page URL, flags) and gets back only a response token, which it writes into the page.
// The token is never put in a tool result or the audit log.
//
// Only type imports from ./registry: registry.ts imports this file, so runtime imports back would cycle.
import { z } from "zod";
import { ERROR_CODES, TabAgentError } from "./errors";
import type { ToolDef } from "./registry";

/** Widgets humanCheck() recognises. Arkose is detected (so the agent knows) but never solved. */
export const CAPTCHA_VENDORS = ["hcaptcha", "recaptcha", "turnstile", "arkose"] as const;
export type CaptchaVendor = (typeof CAPTCHA_VENDORS)[number];
/** Vendors the solver path accepts. */
export const SOLVABLE_VENDORS = ["hcaptcha", "recaptcha", "turnstile"] as const satisfies readonly CaptchaVendor[];

/**
 * Bridge-side solvers. capsolver (default) and 2captcha return a response token; vision answers image
 * challenge rounds with an OpenAI-compatible vision model and the extension taps the answer.
 */
export const CAPTCHA_PROVIDERS = ["capsolver", "2captcha", "vision"] as const;
export type CaptchaProviderName = (typeof CAPTCHA_PROVIDERS)[number];
export const TOKEN_PROVIDERS = ["capsolver", "2captcha"] as const satisfies readonly CaptchaProviderName[];

/** Vision rounds: a tile grid (tap cells) or a free canvas (tap points). */
export const VISION_KINDS = ["grid", "canvas"] as const;
export type VisionKind = (typeof VISION_KINDS)[number];
/** Grid: 0-based row-major cell indices. Canvas: points normalised to the image (0..1). */
export type VisionAnswer = { cells: number[] } | { points: { x: number; y: number }[] };
/** Default rounds per vision solve before CAPTCHA_UNSOLVED. */
export const VISION_DEFAULT_ROUNDS = 3;

/** How a widget got solved. */
export const CAPTCHA_METHODS = ["already", "click", "solver"] as const;
export type CaptchaMethod = (typeof CAPTCHA_METHODS)[number];

/** Why a CAPTCHA was not solved. Every CAPTCHA_UNSOLVED error names one. */
export const CAPTCHA_REASONS = [
  "unsupported_vendor",
  "no_sitekey",
  "no_provider",
  "not_allowed",
  "rate_limited",
  "provider_auth",
  "provider_balance",
  "provider_unsupported",
  "unsolvable",
  "provider_error",
  "timeout",
  "not_accepted",
  "bridge_unavailable",
  "vision_refused",
  "vision_unparseable",
  "vision_unsupported",
] as const;
export type CaptchaReason = (typeof CAPTCHA_REASONS)[number];

/** A solver gets this long per solve (bridge side); CapSolver / 2Captcha usually answer in 5-60s. */
export const CAPTCHA_SOLVE_CAP_MS = 120_000;
/** Free path: after the trusted checkbox click, poll the solved state this long. */
export const CAPTCHA_CLICK_POLL_MS = 6_000;

export const VENDOR_LABEL: Record<CaptchaVendor, string> = { hcaptcha: "hCaptcha", recaptcha: "reCAPTCHA", turnstile: "Cloudflare Turnstile", arkose: "Arkose (FunCaptcha)" };

const REASON_HINT: Partial<Record<CaptchaReason, string>> = {
  unsupported_vendor: "TabAgent does not solve this CAPTCHA type. Use auth.handoff so the user can finish it.",
  no_sitekey: "The widget has no readable site key. Use auth.handoff so the user can finish it.",
  no_provider: "Ask the user to run `tabagent captcha enable capsolver` (or 2captcha) on the bridge machine, or use auth.handoff.",
  not_allowed: "Automatic solving is off for this token. Call captcha.solve, or ask the user to run `tabagent token auto-captcha <name> on`.",
  rate_limited: "The bridge's hourly solve limit was reached. Wait, or use auth.handoff.",
  provider_auth: "The solver rejected the API key. Ask the user to run `tabagent captcha enable <provider>` again with a valid key.",
  provider_balance: "The solver account is out of funds or capacity. Ask the user to top it up, or use auth.handoff.",
  provider_unsupported: "The configured solver does not support this CAPTCHA. Try the other provider, or use auth.handoff.",
  unsolvable: "The solver could not solve it. Retry once, then use auth.handoff.",
  provider_error: "The solver failed. Retry once, then use auth.handoff.",
  timeout: "The solver did not answer in time. Retry once, then use auth.handoff.",
  not_accepted: "The token was written but the page did not accept it (the site may read it through its own script). Use auth.handoff.",
  bridge_unavailable: "The TabAgent bridge is not connected.",
  vision_refused: "The vision model refused the challenge. Use auth.handoff so the user can finish it.",
  vision_unparseable: "The vision model did not answer in the expected format. Check the model setting (`tabagent captcha status`), or use auth.handoff.",
  vision_unsupported: "No image challenge to answer (or this vendor has none). Use auth.handoff.",
};

/** The CAPTCHA_UNSOLVED error for a reason. Message and hint are TabAgent-authored, never page text. */
export function captchaUnsolved(reason: CaptchaReason, vendor?: CaptchaVendor, detail?: string): TabAgentError {
  const what = vendor ? VENDOR_LABEL[vendor] : "The CAPTCHA";
  return new TabAgentError("CAPTCHA_UNSOLVED", `${what} was not solved (reason: ${reason})${detail ? `: ${detail}` : ""}`, REASON_HINT[reason]);
}

/** The reason inside a CAPTCHA_UNSOLVED message, if any. */
export function captchaReasonOf(message: string): CaptchaReason | undefined {
  const m = /\(reason: ([a-z_]+)\)/.exec(message);
  return m && (CAPTCHA_REASONS as readonly string[]).includes(m[1]) ? (m[1] as CaptchaReason) : undefined;
}

/** Tools that may ask the bridge for a token: captcha.solve always; these only with autoCaptcha. */
export const AUTO_CAPTCHA_TOOLS: readonly string[] = ["act.click", "form.submit"];

/** Extra bridge wait so a solve inside a command never trips the command timeout. */
export function captchaExtraTimeout(tool: string, meta?: { autoCaptcha?: boolean }): number {
  if (tool === "captcha.solve") return CAPTCHA_SOLVE_CAP_MS + 30_000;
  if (meta?.autoCaptcha && AUTO_CAPTCHA_TOOLS.includes(tool)) return CAPTCHA_SOLVE_CAP_MS + 30_000;
  return 0;
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------
const WireError = z.object({ code: z.enum(ERROR_CODES), message: z.string(), hint: z.string().optional() });
const httpUrl = z
  .string()
  .max(4096)
  .refine((u) => /^https?:\/\//i.test(u), { message: "http(s) URL only" });

/** ext → bridge: solve this widget. Sent only while a captcha.solve (or autoCaptcha click/submit) runs. */
export const CaptchaSolveRequestSchema = z.object({
  type: z.literal("captcha.solve.request"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  vendor: z.enum(CAPTCHA_VENDORS),
  sitekey: z.string().min(1).max(200),
  url: httpUrl,
  invisible: z.boolean().optional(),
  enterprise: z.boolean().optional(),
  /** reCAPTCHA: v2 (checkbox or invisible) or v3 (score). */
  version: z.enum(["v2", "v3"]).optional(),
  /** reCAPTCHA v3 / Turnstile `data-action`. */
  action: z.string().max(200).optional(),
  /** Turnstile `data-cdata`. */
  cdata: z.string().max(500).optional(),
  /** Providers already tried for this widget (the fallback order resumes after them). */
  exclude: z.array(z.enum(CAPTCHA_PROVIDERS)).max(CAPTCHA_PROVIDERS.length).optional(),
});
export type CaptchaSolveRequest = z.infer<typeof CaptchaSolveRequestSchema>;

/** bridge → ext: the response token (never logged), or why not. */
export const CaptchaTokenSchema = z.object({
  type: z.literal("captcha.token"),
  id: z.string().min(1),
  commandId: z.string().optional(),
  ok: z.boolean(),
  token: z.string().max(20_000).optional(),
  provider: z.enum(CAPTCHA_PROVIDERS).optional(),
  reason: z.enum(CAPTCHA_REASONS).optional(),
  error: WireError.optional(),
  /** Not a failure: the next provider in the order is vision, so the extension runs vision rounds. */
  vision: z.boolean().optional(),
  /** Vision rounds allowed (with `vision: true`). */
  rounds: z.number().int().min(1).max(10).optional(),
  /** Providers tried so far, including the one that just failed. */
  tried: z.array(z.enum(CAPTCHA_PROVIDERS)).optional(),
});
export type CaptchaToken = z.infer<typeof CaptchaTokenSchema>;

/** ext → bridge: one image-challenge round for the vision provider. */
export const CaptchaVisionRequestSchema = z.object({
  type: z.literal("captcha.vision.request"),
  id: z.string().min(1),
  commandId: z.string().min(1),
  vendor: z.enum(CAPTCHA_VENDORS),
  /** The challenge's instruction text (page text; goes to the model only). */
  prompt: z.string().max(1000),
  kind: z.enum(VISION_KINDS),
  rows: z.number().int().min(1).max(6).optional(),
  cols: z.number().int().min(1).max(6).optional(),
  mime: z.enum(["image/png", "image/jpeg"]),
  /** At most ~4 MB of base64. */
  imageBase64: z.string().min(1).max(4_000_000),
});
export type CaptchaVisionRequest = z.infer<typeof CaptchaVisionRequestSchema>;

const Point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
/** bridge → ext: where to tap, or why not. */
export const CaptchaVisionAnswerSchema = z.object({
  type: z.literal("captcha.vision.answer"),
  id: z.string().min(1),
  ok: z.boolean(),
  cells: z.array(z.number().int().min(0).max(35)).max(36).optional(),
  points: z.array(Point).max(20).optional(),
  reason: z.enum(CAPTCHA_REASONS).optional(),
  error: WireError.optional(),
});
export type CaptchaVisionAnswer = z.infer<typeof CaptchaVisionAnswerSchema>;

export const CAPTCHA_EXT_MESSAGE_TYPES = ["captcha.solve.request", "captcha.vision.request"] as const;
export function isCaptchaExtMessage(m: unknown): boolean {
  return !!m && typeof m === "object" && (CAPTCHA_EXT_MESSAGE_TYPES as readonly string[]).includes(String((m as { type?: unknown }).type));
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------
const tabId = z.number().int().optional().describe("Tab id; default: the session's active tab");

export const CAPTCHA_TOOLS = [
  {
    name: "captcha.solve",
    group: "auth",
    description: "Solve the CAPTCHA on the page (hCaptcha, reCAPTCHA, Turnstile): checkbox click first, then the bridge's solver. Never returns the token.",
    params: z.object({ tabId, ref: z.string().optional().describe("Widget ref when the page has several") }),
    result: z.strictObject({
      vendor: z.enum(CAPTCHA_VENDORS),
      solved: z.boolean(),
      method: z.enum(CAPTCHA_METHODS),
      provider: z.enum(CAPTCHA_PROVIDERS).optional(),
      ms: z.number(),
    }),
    level: "act",
    pageContent: [],
    profiles: ["auth"],
    lite: "unsupported",
    handledBy: "both",
  },
] as const satisfies readonly ToolDef[];
