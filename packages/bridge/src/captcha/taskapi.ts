// The createTask / getTaskResult JSON flow that CapSolver and 2Captcha (API v2) both speak (the
// anti-captcha.com shape). Providers only map a CaptchaTask to their task object.
import { CAPTCHA_SOLVE_CAP_MS, captchaUnsolved, type CaptchaReason } from "@tabagent/protocol";
import type { CaptchaProvider, CaptchaTask, ProviderOpts } from "./provider";

/** Map a provider errorCode to a CAPTCHA_UNSOLVED reason. */
export function reasonForCode(code: string): CaptchaReason {
  const c = code.toUpperCase();
  if (/KEY|IP_NOT_ALLOWED|IP_BLOCKED|ACCOUNT_SUSPENDED|ACCESS_DENIED|PROXY_BANNED/.test(c)) return "provider_auth";
  if (/BALANCE|NO_SLOT|NO_FUNDS|INSUFFICIENT/.test(c)) return "provider_balance";
  if (/NOT_SUPPORTED|INVALID_TASK_DATA|TASK_ABSENT|BAD_PARAMETERS|TASK_TYPE|UNSUPPORTED/.test(c)) return "provider_unsupported";
  if (/UNSOLVABLE|SOLVE_FAILED/.test(c)) return "unsolvable";
  if (/TIMEOUT/.test(c)) return "timeout";
  return "provider_error";
}

/** Only [A-Z0-9_] survives from a provider code: no prose, no echoed key. */
export const safeCode = (c: unknown) =>
  String(c ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 60) || "UNKNOWN";

export abstract class TaskApiProvider implements CaptchaProvider {
  abstract readonly name: "capsolver" | "2captcha";
  protected abstract readonly base: string;
  protected abstract readonly defaultPollMs: number;
  private readonly key: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private o: ProviderOpts) {
    this.key = o.key;
    this.fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  /** The provider's task object for this widget, or null when it has no task type for the vendor. */
  abstract taskFor(t: CaptchaTask): Record<string, unknown> | null;

  private fail(reason: CaptchaReason, t: CaptchaTask | undefined, detail: string): never {
    throw captchaUnsolved(reason, t?.vendor, `${this.name} ${detail}`);
  }

  private async post(path: string, body: Record<string, unknown>, t?: CaptchaTask, signal?: AbortSignal): Promise<Record<string, any>> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientKey: this.key, ...body }), signal });
    } catch {
      if (signal?.aborted) this.fail("timeout", t, "aborted");
      this.fail("provider_error", t, "network error");
    }
    if (!r.ok) this.fail("provider_error", t, `HTTP ${r.status}`);
    let j: unknown;
    try {
      j = await r.json();
    } catch {
      this.fail("provider_error", t, "bad JSON");
    }
    if (!j || typeof j !== "object") this.fail("provider_error", t, "bad JSON");
    const o = j as Record<string, any>;
    if (o.errorId && o.errorId !== 0) {
      const code = safeCode(o.errorCode);
      this.fail(reasonForCode(code), t, code);
    }
    return o;
  }

  async solve(t: CaptchaTask, signal?: AbortSignal): Promise<string> {
    const task = this.taskFor(t);
    if (!task) this.fail("provider_unsupported", t, `has no task type for ${t.vendor}`);
    const started = this.now();
    const cap = this.o.capMs ?? CAPTCHA_SOLVE_CAP_MS;
    const pollMs = this.o.pollMs ?? this.defaultPollMs;
    const created = await this.post("createTask", { task }, t, signal);
    if (created.taskId === undefined || created.taskId === null) this.fail("provider_error", t, "no taskId");
    // Some tasks come back solved straight from createTask.
    let res: Record<string, any> = created;
    while (res.status !== "ready") {
      if (signal?.aborted) this.fail("timeout", t, "aborted");
      if (this.now() - started >= cap) this.fail("timeout", t, `no answer in ${Math.round(cap / 1000)}s`);
      await this.sleep(pollMs);
      if (signal?.aborted) this.fail("timeout", t, "aborted");
      res = await this.post("getTaskResult", { taskId: created.taskId }, t, signal);
      if (res.status === "failed") {
        const code = safeCode(res.errorCode ?? "ERROR_CAPTCHA_SOLVE_FAILED");
        this.fail(reasonForCode(code), t, code);
      }
    }
    const sol = (res.solution ?? {}) as Record<string, unknown>;
    const token = typeof sol.gRecaptchaResponse === "string" && sol.gRecaptchaResponse ? sol.gRecaptchaResponse : sol.token;
    if (typeof token !== "string" || !token) this.fail("provider_error", t, "ready without a token");
    return token;
  }

  async balance(): Promise<number> {
    const r = await this.post("getBalance", {});
    return Number(r.balance ?? 0);
  }
}
