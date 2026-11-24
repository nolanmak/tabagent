// #61 autoCaptcha seam for act.click / form.submit. Handlers import only this file; captcha/index.ts
// installs the real hook, so handler unit tests never pull in chrome.* or the bridge channel.
import type { Ctx, TabCtx } from "../tabctx";

export type AutoCaptchaHook = (c: Ctx & { cmdId?: string }, t: TabCtx, phase: "before" | "after") => Promise<void>;

let hook: AutoCaptchaHook | null = null;

export function setAutoCaptchaHook(h: AutoCaptchaHook | null) {
  hook = h;
}

/** Runs only for sessions whose token has autoCaptcha on (meta.autoCaptcha, set by the bridge). */
export async function autoCaptcha(c: Ctx & { cmdId?: string }, t: TabCtx, phase: "before" | "after"): Promise<void> {
  if (!hook || c.meta?.autoCaptcha !== true) return;
  await hook(c, t, phase);
}
