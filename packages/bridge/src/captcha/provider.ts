// #61 provider interfaces (bridge side), built like the auth providers (../auth/provider.ts). Adding a
// solver needs no protocol change: implement one of these and register it in createCaptcha(). API keys
// live only inside provider objects; they are never logged, audited, or sent to the extension.
//
// Two kinds:
//   token providers (capsolver, 2captcha) return a response token for the widget;
//   the vision provider answers one image challenge round (which tiles / points to tap), and the
//   extension does the tapping with trusted CDP clicks.
import type { CaptchaVendor, VisionAnswer, VisionKind } from "@tabagent/protocol";

/** The widget facts the extension sends. Never carries the page's cookies or the user's data. */
export interface CaptchaTask {
  vendor: CaptchaVendor;
  sitekey: string;
  url: string;
  invisible?: boolean;
  enterprise?: boolean;
  version?: "v2" | "v3";
  action?: string;
  cdata?: string;
}

export interface CaptchaProvider {
  readonly name: "capsolver" | "2captcha";
  /**
   * Solve and return the response token. Throws TabAgentError CAPTCHA_UNSOLVED whose message names a
   * CaptchaReason; the message never quotes provider prose (it could echo the key).
   */
  solve(task: CaptchaTask, signal?: AbortSignal): Promise<string>;
  /** Account balance in USD, for `tabagent captcha status` / `enable`. Throws like solve(). */
  balance(): Promise<number>;
}

/** One image-challenge round as the extension saw it. */
export interface VisionRound {
  vendor: CaptchaVendor;
  /** The challenge's instruction text, e.g. "Please click each image containing a bus". Page text. */
  prompt: string;
  kind: VisionKind;
  /** Grid challenges: tiles row-major. */
  rows?: number;
  cols?: number;
  /** PNG or JPEG of the challenge area, base64. */
  imageBase64: string;
  mime: "image/png" | "image/jpeg";
}

export interface VisionSolver {
  readonly name: "vision";
  answer(round: VisionRound, signal?: AbortSignal): Promise<VisionAnswer>;
}

export interface ProviderOpts {
  key: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll interval for getTaskResult. */
  pollMs?: number;
  /** Give up after this long (default CAPTCHA_SOLVE_CAP_MS). */
  capMs?: number;
}
