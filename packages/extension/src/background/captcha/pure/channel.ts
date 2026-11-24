// #61 solve wire, extension side (like auth/pure/channel.ts). index.ts hands every bridge message of
// type captcha.token / captcha.vision.answer to onMessage(). A token is returned to exactly one waiting
// caller and never stored here: the pending map holds resolvers only.
import { CAPTCHA_SOLVE_CAP_MS, type CaptchaSolveRequest, type CaptchaToken, type CaptchaVisionAnswer, type CaptchaVisionRequest } from "@tabagent/protocol";

export type Sender = (msg: unknown) => boolean;

export interface CaptchaChannelDeps {
  send: Sender;
  newId?: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export type TokenRequest = Omit<CaptchaSolveRequest, "type" | "id" | "commandId">;
export type VisionRequest = Omit<CaptchaVisionRequest, "type" | "id" | "commandId">;

interface Waiter {
  type: "captcha.token" | "captcha.vision.answer";
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

export function createCaptchaChannel(deps: CaptchaChannelDeps) {
  const waiting = new Map<string, Waiter>();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const st = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  function request<T>(type: Waiter["type"], msg: Record<string, unknown>, timeoutMs: number, offline: T, late: T): Promise<T> {
    const id = newId();
    return new Promise<T>((resolve, reject) => {
      if (!deps.send({ ...msg, id })) return resolve({ ...offline, id } as T);
      const timer = st(() => {
        waiting.delete(id);
        resolve({ ...late, id } as T);
      }, timeoutMs);
      waiting.set(id, { type, resolve, reject, timer });
    });
  }

  return {
    /** Ask the bridge's providers (in its configured order) for a token. Never rejects except on kill. */
    solve(commandId: string, req: TokenRequest, timeoutMs = CAPTCHA_SOLVE_CAP_MS * 2 + 15_000): Promise<CaptchaToken> {
      return request<CaptchaToken>(
        "captcha.token",
        { type: "captcha.solve.request", commandId, ...req },
        timeoutMs,
        { type: "captcha.token", id: "", ok: false, reason: "bridge_unavailable" },
        { type: "captcha.token", id: "", ok: false, reason: "timeout" },
      );
    },
    /** One vision round. */
    vision(commandId: string, round: VisionRequest, timeoutMs = 90_000): Promise<CaptchaVisionAnswer> {
      return request<CaptchaVisionAnswer>(
        "captcha.vision.answer",
        { type: "captcha.vision.request", commandId, ...round },
        timeoutMs,
        { type: "captcha.vision.answer", id: "", ok: false, reason: "bridge_unavailable" },
        { type: "captcha.vision.answer", id: "", ok: false, reason: "timeout" },
      );
    },
    onMessage(msg: any): boolean {
      if (msg?.type !== "captcha.token" && msg?.type !== "captcha.vision.answer") return false;
      const w = waiting.get(msg.id);
      if (!w || w.type !== msg.type) return true; // late or unknown: drop (and never keep the token)
      waiting.delete(msg.id);
      ct(w.timer);
      w.resolve(msg);
      return true;
    },
    rejectAll(e: Error) {
      for (const [id, w] of waiting) {
        ct(w.timer);
        waiting.delete(id);
        w.reject(e);
      }
    },
    pendingCount: () => waiting.size,
  };
}

export type CaptchaChannel = ReturnType<typeof createCaptchaChannel>;
