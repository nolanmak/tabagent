// CapSolver and 2Captcha clients against a mocked fetch: createTask -> getTaskResult polling, task
// mapping per vendor, error-code mapping to CAPTCHA_UNSOLVED reasons, timeouts, and key hygiene.
import { describe, expect, it } from "vitest";
import { captchaReasonOf, TabAgentError } from "@tabagent/protocol";
import { CapSolverProvider, TwoCaptchaProvider, type CaptchaTask } from "../src/captcha";

const KEY = "CAP-0123456789abcdef0123456789abcdef";

interface Call {
  url: string;
  body: any;
}
/** A fetch that answers from a script of JSON bodies, recording each call. */
function scripted(replies: (unknown | ((body: any) => unknown))[], status = 200) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    const next = replies.shift();
    if (next === undefined) throw new Error("no more replies");
    const j = typeof next === "function" ? (next as (b: any) => unknown)(body) : next;
    if (j instanceof Error) throw j;
    return new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const noSleep = async () => {};

const H: CaptchaTask = { vendor: "hcaptcha", sitekey: "10000000-ffff-ffff-ffff-000000000001", url: "https://shop.test/signup" };
const R2: CaptchaTask = { vendor: "recaptcha", sitekey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI", url: "https://shop.test/signup", version: "v2" };
const T: CaptchaTask = { vendor: "turnstile", sitekey: "1x00000000000000000000AA", url: "https://shop.test/signup", action: "login", cdata: "abc" };

describe("CapSolver", () => {
  it("createTask then polls getTaskResult until ready; returns the token", async () => {
    const f = scripted([{ errorId: 0, taskId: "t-1" }, { errorId: 0, status: "processing" }, { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN-R" } }]);
    const p = new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep });
    expect(await p.solve(R2)).toBe("TOKEN-R");
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.capsolver.com/createTask", "https://api.capsolver.com/getTaskResult", "https://api.capsolver.com/getTaskResult"]);
    expect(f.calls[0].body).toEqual({ clientKey: KEY, task: { type: "ReCaptchaV2TaskProxyLess", websiteURL: R2.url, websiteKey: R2.sitekey } });
    expect(f.calls[1].body).toEqual({ clientKey: KEY, taskId: "t-1" });
  });
  it("maps each vendor to its task type", () => {
    const p = new CapSolverProvider({ key: KEY });
    expect(p.taskFor(H)).toEqual({ type: "HCaptchaTaskProxyLess", websiteURL: H.url, websiteKey: H.sitekey });
    expect(p.taskFor({ ...H, invisible: true })).toMatchObject({ isInvisible: true });
    expect(p.taskFor({ ...R2, invisible: true })).toMatchObject({ type: "ReCaptchaV2TaskProxyLess", isInvisible: true });
    expect(p.taskFor({ ...R2, enterprise: true })).toMatchObject({ type: "ReCaptchaV2EnterpriseTaskProxyLess" });
    expect(p.taskFor({ ...R2, version: "v3", action: "signup" })).toEqual({ type: "ReCaptchaV3TaskProxyLess", websiteURL: R2.url, websiteKey: R2.sitekey, pageAction: "signup" });
    expect(p.taskFor({ ...R2, version: "v3", enterprise: true })).toMatchObject({ type: "ReCaptchaV3EnterpriseTaskProxyLess" });
    expect(p.taskFor(T)).toEqual({ type: "AntiTurnstileTaskProxyLess", websiteURL: T.url, websiteKey: T.sitekey, metadata: { action: "login", cdata: "abc" } });
    expect(p.taskFor({ ...H, vendor: "arkose" })).toBeNull();
  });
  it("turnstile token comes from solution.token", async () => {
    const f = scripted([{ errorId: 0, taskId: "t" }, { errorId: 0, status: "ready", solution: { token: "0.TURN" } }]);
    expect(await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(T)).toBe("0.TURN");
  });
  it.each([
    ["ERROR_KEY_DENIED_ACCESS", "provider_auth"],
    ["ERROR_ZERO_BALANCE", "provider_balance"],
    ["ERROR_INVALID_TASK_DATA", "provider_unsupported"],
    ["ERROR_TASK_NOT_SUPPORTED", "provider_unsupported"],
    ["ERROR_CAPTCHA_SOLVE_FAILED", "unsolvable"],
    ["ERROR_SERVICE_UNAVALIABLE", "provider_error"],
  ])("createTask error %s -> %s", async (code, reason) => {
    const f = scripted([{ errorId: 1, errorCode: code, errorDescription: `bad thing with key ${KEY}` }]);
    const e = await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(H).catch((x) => x);
    expect(e).toBeInstanceOf(TabAgentError);
    expect(e.code).toBe("CAPTCHA_UNSOLVED");
    expect(captchaReasonOf(e.message)).toBe(reason);
    expect(e.message).toContain(code);
    // Never echo provider prose (it may quote the key).
    expect(JSON.stringify(e.toJSON())).not.toContain(KEY);
  });
  it("a failed task during polling is unsolvable", async () => {
    const f = scripted([{ errorId: 0, taskId: "t" }, { errorId: 0, status: "failed", errorCode: "ERROR_CAPTCHA_SOLVE_FAILED" }]);
    const e = await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(H).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe("unsolvable");
  });
  it("ready without a token is a provider error", async () => {
    const f = scripted([{ errorId: 0, taskId: "t" }, { errorId: 0, status: "ready", solution: {} }]);
    const e = await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(H).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe("provider_error");
  });
  it("gives up after the cap with reason timeout", async () => {
    let t = 0;
    const f = scripted([{ errorId: 0, taskId: "t" }, ...Array.from({ length: 50 }, () => ({ errorId: 0, status: "processing" }))]);
    const p = new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: async (ms) => void (t += ms), now: () => t, capMs: 10_000, pollMs: 2_000 });
    const e = await p.solve(H).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe("timeout");
    expect(f.calls.length).toBeLessThanOrEqual(7);
  });
  it("an aborted solve stops polling", async () => {
    const ac = new AbortController();
    const f = scripted([{ errorId: 0, taskId: "t" }, () => (ac.abort(), { errorId: 0, status: "processing" }), { errorId: 0, status: "processing" }]);
    const e = await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(H, ac.signal).catch((x) => x);
    expect(e.code).toBe("CAPTCHA_UNSOLVED");
    expect(f.calls).toHaveLength(2);
  });
  it("network errors and HTTP errors are provider errors without the key", async () => {
    const f = scripted([new Error(`connect ECONNREFUSED ${KEY}`)]);
    const e = await new CapSolverProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(H).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe("provider_error");
    expect(e.message).not.toContain(KEY);
    const g = scripted([{ nope: true }], 502);
    const e2 = await new CapSolverProvider({ key: KEY, fetch: g.fetch, sleep: noSleep }).solve(H).catch((x) => x);
    expect(e2.message).toMatch(/HTTP 502/);
  });
  it("balance() reads getBalance", async () => {
    const f = scripted([{ errorId: 0, balance: 4.2 }]);
    expect(await new CapSolverProvider({ key: KEY, fetch: f.fetch }).balance()).toBe(4.2);
    expect(f.calls[0]).toEqual({ url: "https://api.capsolver.com/getBalance", body: { clientKey: KEY } });
  });
});

describe("2Captcha (API v2, JSON)", () => {
  it("createTask then getTaskResult on api.2captcha.com", async () => {
    const f = scripted([{ errorId: 0, taskId: 72345678 }, { errorId: 0, status: "processing" }, { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN-H", token: "TOKEN-H" } }]);
    const p = new TwoCaptchaProvider({ key: KEY, fetch: f.fetch, sleep: noSleep });
    expect(await p.solve(H)).toBe("TOKEN-H");
    expect(f.calls[0]).toEqual({ url: "https://api.2captcha.com/createTask", body: { clientKey: KEY, task: { type: "HCaptchaTaskProxyless", websiteURL: H.url, websiteKey: H.sitekey } } });
    expect(f.calls[1]).toEqual({ url: "https://api.2captcha.com/getTaskResult", body: { clientKey: KEY, taskId: 72345678 } });
  });
  it("maps each vendor to its task type", () => {
    const p = new TwoCaptchaProvider({ key: KEY });
    expect(p.taskFor({ ...R2, invisible: true })).toEqual({ type: "RecaptchaV2TaskProxyless", websiteURL: R2.url, websiteKey: R2.sitekey, isInvisible: true });
    expect(p.taskFor({ ...R2, enterprise: true })).toMatchObject({ type: "RecaptchaV2EnterpriseTaskProxyless" });
    expect(p.taskFor({ ...R2, version: "v3", action: "submit", enterprise: true })).toEqual({ type: "RecaptchaV3TaskProxyless", websiteURL: R2.url, websiteKey: R2.sitekey, minScore: 0.7, pageAction: "submit", isEnterprise: true });
    expect(p.taskFor(T)).toEqual({ type: "TurnstileTaskProxyless", websiteURL: T.url, websiteKey: T.sitekey, action: "login", data: "abc" });
    expect(p.taskFor({ ...H, vendor: "arkose" })).toBeNull();
  });
  it.each([
    ["ERROR_KEY_DOES_NOT_EXIST", "provider_auth"],
    ["ERROR_NO_SLOT_AVAILABLE", "provider_balance"],
    ["ERROR_CAPTCHA_UNSOLVABLE", "unsolvable"],
    ["ERROR_TASK_NOT_SUPPORTED", "provider_unsupported"],
  ])("%s -> %s", async (code, reason) => {
    const f = scripted([{ errorId: 0, taskId: 1 }, { errorId: 12, errorCode: code }]);
    const e = await new TwoCaptchaProvider({ key: KEY, fetch: f.fetch, sleep: noSleep }).solve(T).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe(reason);
  });
});
