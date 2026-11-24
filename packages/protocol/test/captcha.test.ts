import { describe, expect, it } from "vitest";
import {
  CaptchaSolveRequestSchema,
  CaptchaTokenSchema,
  CaptchaVisionAnswerSchema,
  CaptchaVisionRequestSchema,
  captchaExtraTimeout,
  captchaUnsolved,
  getTool,
  isCaptchaExtMessage,
  SessionMetaSchema,
  toolsForProfiles,
  CAPTCHA_SOLVE_CAP_MS,
} from "@tabagent/protocol";

describe("captcha.solve registry entry", () => {
  const t = getTool("captcha.solve")!;
  it("is an opt-in act tool in the auth profile, never in full", () => {
    expect(t.level).toBe("act");
    expect(t.handledBy).toBe("both");
    expect(t.lite).toBe("unsupported");
    expect(toolsForProfiles("auth").map((x) => x.name)).toContain("captcha.solve");
    expect(toolsForProfiles("full").map((x) => x.name)).not.toContain("captcha.solve");
  });
  it("result is strict: enums, booleans and numbers only (no token can ride along)", () => {
    expect(t.result.safeParse({ vendor: "hcaptcha", solved: true, method: "solver", provider: "capsolver", ms: 1200 }).success).toBe(true);
    expect(t.result.safeParse({ vendor: "hcaptcha", solved: true, method: "solver", ms: 1, token: "P1_abc" }).success).toBe(false);
    expect(t.result.safeParse({ vendor: "funcaptcha", solved: true, method: "click", ms: 1 }).success).toBe(false);
  });
  it("params: tabId and an optional widget ref", () => {
    expect(t.params.safeParse({ ref: "e4" }).success).toBe(true);
    expect(t.params.safeParse({}).success).toBe(true);
  });
});

describe("wire", () => {
  it("solve request carries the widget facts, never a key", () => {
    const m = { type: "captcha.solve.request", id: "r1", commandId: "c1", vendor: "recaptcha", sitekey: "6Lc_aCMTAAAAABx7u2W0WPXnVbI_v6ZdbM6rYf16", url: "https://x.test/signup", invisible: false, enterprise: false };
    expect(CaptchaSolveRequestSchema.safeParse(m).success).toBe(true);
    expect(isCaptchaExtMessage(m)).toBe(true);
    expect(isCaptchaExtMessage({ type: "auth.accounts" })).toBe(false);
    expect(CaptchaSolveRequestSchema.safeParse({ ...m, url: "javascript:alert(1)" }).success).toBe(false);
    expect(CaptchaSolveRequestSchema.safeParse({ ...m, sitekey: "x".repeat(300) }).success).toBe(false);
  });
  it("token reply: ok with token, or error with a reason", () => {
    expect(CaptchaTokenSchema.safeParse({ type: "captcha.token", id: "r1", ok: true, token: "t", provider: "capsolver" }).success).toBe(true);
    expect(CaptchaTokenSchema.safeParse({ type: "captcha.token", id: "r1", ok: false, reason: "no_provider", error: { code: "CAPTCHA_UNSOLVED", message: "m" } }).success).toBe(true);
  });
});

describe("vision wire", () => {
  const req = { type: "captcha.vision.request", id: "v1", commandId: "c1", vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3, mime: "image/png", imageBase64: "iVBORw0KGgo=" };
  it("round request carries the image and prompt, and counts as a captcha message", () => {
    expect(CaptchaVisionRequestSchema.safeParse(req).success).toBe(true);
    expect(isCaptchaExtMessage(req)).toBe(true);
    expect(CaptchaVisionRequestSchema.safeParse({ ...req, kind: "drag" }).success).toBe(false);
  });
  it("answer: grid cells or normalised points, nothing out of range", () => {
    expect(CaptchaVisionAnswerSchema.safeParse({ type: "captcha.vision.answer", id: "v1", ok: true, cells: [0, 4, 8] }).success).toBe(true);
    expect(CaptchaVisionAnswerSchema.safeParse({ type: "captcha.vision.answer", id: "v1", ok: true, points: [{ x: 0.5, y: 0.25 }] }).success).toBe(true);
    expect(CaptchaVisionAnswerSchema.safeParse({ type: "captcha.vision.answer", id: "v1", ok: true, points: [{ x: 1.5, y: 0 }] }).success).toBe(false);
  });
  it("a token reply may hand over to vision with the providers tried so far", () => {
    expect(CaptchaTokenSchema.safeParse({ type: "captcha.token", id: "r", ok: false, vision: true, rounds: 3, tried: ["capsolver"], reason: "provider_unsupported" }).success).toBe(true);
  });
});

describe("helpers", () => {
  it("captchaUnsolved builds a CAPTCHA_UNSOLVED error naming the reason", () => {
    const e = captchaUnsolved("no_provider", "hcaptcha");
    expect(e.code).toBe("CAPTCHA_UNSOLVED");
    expect(e.message).toMatch(/hCaptcha/);
    expect(e.message).toMatch(/no_provider/);
    expect(e.hint).toMatch(/tabagent captcha enable/);
  });
  it("extra bridge wait: captcha.solve always, click/submit only with autoCaptcha", () => {
    expect(captchaExtraTimeout("captcha.solve")).toBeGreaterThanOrEqual(CAPTCHA_SOLVE_CAP_MS);
    expect(captchaExtraTimeout("act.click")).toBe(0);
    expect(captchaExtraTimeout("act.click", { autoCaptcha: true })).toBeGreaterThanOrEqual(CAPTCHA_SOLVE_CAP_MS);
    expect(captchaExtraTimeout("form.submit", { autoCaptcha: true })).toBeGreaterThan(0);
    expect(captchaExtraTimeout("page.snapshot", { autoCaptcha: true })).toBe(0);
  });
  it("session meta may carry autoCaptcha", () => {
    expect(SessionMetaSchema.safeParse({ id: "s", label: "jarvis", cap: "act", sites: [], autoCaptcha: true }).success).toBe(true);
  });
});
