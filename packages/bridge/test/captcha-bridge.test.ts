// Bridge side of the CAPTCHA wire through a real Daemon and a fake extension, with stub providers.
// Covers: only in-flight captcha.solve (or autoCaptcha click/submit) may spend a solve, fallback order
// incl. the vision hand-over, spend caps, audit without token/key/image, kill aborts.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captchaUnsolved, type VisionAnswer } from "@tabagent/protocol";
import type { CaptchaSettings } from "../src/captcha";
import { saveConfig } from "../src/config";
import { createToken } from "../src/tokens";
import { okEnvelope, pairedExt, startDaemon, type FakeExt } from "./helpers";

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = `P1_${randomBytes(24).toString("hex")}`;
const KEY = `CAP-${randomBytes(16).toString("hex")}`;
const IMAGE = `iVBOR${randomBytes(20).toString("base64")}`;

let ctx: Awaited<ReturnType<typeof startDaemon>>;
let ext: FakeExt;
let solves: { name: string; task: any }[];
let behaviour: Record<string, () => Promise<string>>;
let visionAnswer: () => Promise<VisionAnswer>;
let settings: CaptchaSettings;

function baseSettings(over: Partial<CaptchaSettings> = {}): CaptchaSettings {
  return { providers: ["capsolver"], keys: { capsolver: { key: KEY, source: "file" } }, vision: { rounds: 3 }, maxPerHour: 30, problems: [], ...over };
}

async function boot(s: CaptchaSettings) {
  settings = s;
  solves = [];
  behaviour = { capsolver: async () => TOKEN, "2captcha": async () => TOKEN };
  visionAnswer = async () => ({ cells: [1, 4] });
  ctx = await startDaemon({
    captcha: {
      settings: () => settings,
      tokenProvider: (name, key) => ({
        name,
        balance: async () => 1,
        solve: async (task) => {
          expect(key).toBe(KEY);
          solves.push({ name, task });
          return behaviour[name]();
        },
      }),
      visionProvider: () => ({ name: "vision", answer: () => visionAnswer() }),
    },
  });
  ext = await pairedExt(ctx.d);
}

afterEach(async () => {
  // Answer every command still open so stop() does not wait on hanging HTTP calls.
  for (const m of ext?.msgs ?? []) if (m.type === "command") ext.send({ type: "result", id: m.id, ...okEnvelope({}, m.tool) });
  await new Promise((r) => setTimeout(r, 20));
  ext?.close();
  await ctx?.d.stop();
});

async function call(tool: string, params: Record<string, unknown> = {}, token = ctx.cfg.secret) {
  const resp = fetch(`${ctx.base}/v1/${tool}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(params) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const cmd = await ext.next("command", (m) => m.tool === tool);
  return { cmd, resp };
}
const solveReq = (commandId: string, extra: Record<string, unknown> = {}) => ({ type: "captcha.solve.request", id: `r-${randomBytes(3).toString("hex")}`, commandId, vendor: "hcaptcha", sitekey: "10000000-ffff-ffff-ffff-000000000001", url: "https://shop.test/signup", ...extra });
async function ask(m: Record<string, any>, replyType = "captcha.token") {
  ext.send(m);
  return ext.next(replyType, (x) => x.id === m.id, 5000);
}
const audit = () => readFileSync(join(ctx.home, "audit.jsonl"), "utf8");

describe("captcha.solve.request", () => {
  it("answers an in-flight captcha.solve with the token; audit has vendor/origin/provider/ms but no token or key", async () => {
    await boot(baseSettings());
    const { cmd, resp } = await call("captcha.solve", {});
    const r = await ask(solveReq(cmd.id, { invisible: true }));
    expect(r).toMatchObject({ ok: true, token: TOKEN, provider: "capsolver" });
    expect(solves[0].task).toMatchObject({ vendor: "hcaptcha", sitekey: "10000000-ffff-ffff-ffff-000000000001", url: "https://shop.test/signup", invisible: true });
    ext.send({ type: "result", id: cmd.id, ...okEnvelope({ vendor: "hcaptcha", solved: true, method: "solver", provider: "capsolver", ms: 5 }, "captcha.solve") });
    expect((await resp).body.ok).toBe(true);
    const a = audit();
    const ev = a.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "captcha.provider");
    expect(ev.data).toMatchObject({ kind: "captcha", vendor: "hcaptcha", origin: "https://shop.test", provider: "capsolver", outcome: "ok" });
    expect(typeof ev.data.ms).toBe("number");
    expect(a).not.toContain(TOKEN);
    expect(a).not.toContain(KEY);
  });

  it("refuses with not_allowed when no command, the wrong tool, or click without autoCaptcha", async () => {
    await boot(baseSettings());
    expect(await ask(solveReq("nope"))).toMatchObject({ ok: false, reason: "not_allowed" });
    const { cmd } = await call("act.click", { ref: "e1" });
    const r = await ask(solveReq(cmd.id));
    expect(r).toMatchObject({ ok: false, reason: "not_allowed", error: { code: "CAPTCHA_UNSOLVED" } });
    expect(r.token).toBeUndefined();
    expect(solves).toHaveLength(0);
  });

  it("act.click on a token with autoCaptcha may solve; the command meta carries autoCaptcha", async () => {
    await boot(baseSettings());
    const tok = createToken(ctx.d.cfg, "jarvis", "act", [], new Date(), { autoCaptcha: true });
    const plain = createToken(ctx.d.cfg, "other", "act");
    saveConfig(ctx.d.cfg);
    const { cmd } = await call("act.click", { ref: "e1" }, tok);
    expect(cmd.session.autoCaptcha).toBe(true);
    expect(await ask(solveReq(cmd.id))).toMatchObject({ ok: true, token: TOKEN });
    const { cmd: c2 } = await call("act.click", { ref: "e2" }, plain);
    expect(c2.session.autoCaptcha).toBeUndefined();
    expect(await ask(solveReq(c2.id))).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("arkose is never sent to a provider", async () => {
    await boot(baseSettings());
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(solveReq(cmd.id, { vendor: "arkose" }))).toMatchObject({ ok: false, reason: "unsupported_vendor" });
    expect(solves).toHaveLength(0);
  });

  it("no provider configured -> no_provider", async () => {
    await boot(baseSettings({ providers: [], keys: {} }));
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(solveReq(cmd.id))).toMatchObject({ ok: false, reason: "no_provider" });
  });

  it("falls back in order: capsolver fails -> 2captcha answers", async () => {
    await boot(baseSettings({ providers: ["capsolver", "2captcha"], keys: { capsolver: { key: KEY, source: "file" }, "2captcha": { key: KEY, source: "file" } } }));
    behaviour.capsolver = async () => {
      throw captchaUnsolved("provider_unsupported", "hcaptcha", "capsolver ERROR_INVALID_TASK_DATA");
    };
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(solveReq(cmd.id))).toMatchObject({ ok: true, provider: "2captcha" });
    expect(solves.map((s) => s.name)).toEqual(["capsolver", "2captcha"]);
  });

  it("hands over to vision after capsolver fails, then resumes after vision with exclude", async () => {
    await boot(baseSettings({ providers: ["capsolver", "vision", "2captcha"], keys: { capsolver: { key: KEY, source: "file" }, "2captcha": { key: KEY, source: "file" } }, vision: { baseUrl: "https://llm.test/v1", model: "m", rounds: 2 } }));
    behaviour.capsolver = async () => {
      throw captchaUnsolved("provider_unsupported", "hcaptcha");
    };
    const { cmd } = await call("captcha.solve", {});
    const r = await ask(solveReq(cmd.id));
    expect(r).toMatchObject({ ok: false, vision: true, rounds: 2, tried: ["capsolver"], reason: "provider_unsupported" });
    const r2 = await ask(solveReq(cmd.id, { exclude: ["capsolver", "vision"] }));
    expect(r2).toMatchObject({ ok: true, provider: "2captcha" });
  });

  it("vision first: hands over immediately without spending a token solve", async () => {
    await boot(baseSettings({ providers: ["vision"], keys: {}, vision: { baseUrl: "https://llm.test/v1", model: "m", rounds: 3 } }));
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(solveReq(cmd.id))).toMatchObject({ ok: false, vision: true, rounds: 3, tried: [] });
    expect(solves).toHaveLength(0);
  });

  it("caps token solves per command", async () => {
    await boot(baseSettings());
    behaviour.capsolver = async () => {
      throw captchaUnsolved("unsolvable", "hcaptcha");
    };
    const { cmd } = await call("captcha.solve", {});
    for (let i = 0; i < 3; i++) expect(await ask(solveReq(cmd.id))).toMatchObject({ reason: "unsolvable" });
    expect(await ask(solveReq(cmd.id))).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(solves).toHaveLength(3);
  });

  it("caps solves per hour across commands", async () => {
    await boot(baseSettings({ maxPerHour: 1 }));
    const a = await call("captcha.solve", {});
    expect(await ask(solveReq(a.cmd.id))).toMatchObject({ ok: true });
    expect(await ask(solveReq(a.cmd.id))).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("the extra bridge wait covers a slow solve (captcha.solve gets more than the default budget)", async () => {
    await boot(baseSettings());
    // The bridge must not time captcha.solve out at the plain act budget; it stays pending here.
    const { cmd, resp } = await call("captcha.solve", {});
    ext.send({ type: "result", id: cmd.id, ...okEnvelope({ vendor: "hcaptcha", solved: true, method: "already", ms: 1 }, "captcha.solve") });
    expect((await resp).body.ok).toBe(true);
  });
});

describe("captcha.vision.request", () => {
  const visionReq = (commandId: string) => ({ type: "captcha.vision.request", id: `v-${randomBytes(3).toString("hex")}`, commandId, vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3, mime: "image/png", imageBase64: IMAGE });
  it("answers a round from the vision provider; audit has no image or prompt", async () => {
    await boot(baseSettings({ providers: ["vision"], keys: {}, vision: { baseUrl: "https://llm.test/v1", model: "m", rounds: 3 } }));
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(visionReq(cmd.id), "captcha.vision.answer")).toMatchObject({ ok: true, cells: [1, 4] });
    const a = audit();
    expect(a).toContain('"provider":"vision"');
    expect(a).not.toContain(IMAGE);
    expect(a).not.toContain("containing a bus");
  });
  it("a refusal comes back as its reason", async () => {
    await boot(baseSettings({ providers: ["vision"], keys: {}, vision: { baseUrl: "https://llm.test/v1", model: "m", rounds: 3 } }));
    visionAnswer = async () => {
      throw captchaUnsolved("vision_refused", "hcaptcha", "vision model refused");
    };
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(visionReq(cmd.id), "captcha.vision.answer")).toMatchObject({ ok: false, reason: "vision_refused" });
  });
  it("vision not configured -> no_provider; not in flight -> not_allowed", async () => {
    await boot(baseSettings());
    const { cmd } = await call("captcha.solve", {});
    expect(await ask(visionReq(cmd.id), "captcha.vision.answer")).toMatchObject({ ok: false, reason: "no_provider" });
    expect(await ask(visionReq("nope"), "captcha.vision.answer")).toMatchObject({ ok: false, reason: "not_allowed" });
  });
});

describe("kill switch", () => {
  it("a killed event aborts a running solve", async () => {
    await boot(baseSettings());
    let aborted = false;
    behaviour.capsolver = () =>
      new Promise((_, rej) => {
        const t = setInterval(() => {
          if (aborted) {
            clearInterval(t);
            rej(captchaUnsolved("timeout", "hcaptcha", "aborted"));
          }
        }, 10);
      });
    const spy = vi.spyOn(ctx.d.captcha, "abortAll").mockImplementation(() => {
      aborted = true;
    });
    const { cmd } = await call("captcha.solve", {});
    const reply = ask(solveReq(cmd.id));
    ext.send({ type: "event", event: "killed", data: {} });
    expect(await reply).toMatchObject({ ok: false, reason: "timeout" });
    expect(spy).toHaveBeenCalled();
  });
});

describe("token flag", () => {
  it("autoCaptcha is a plain flag on the token record", async () => {
    await boot(baseSettings());
    createToken(ctx.d.cfg, "jarvis", "act", [], new Date(), { autoCaptcha: true });
    expect(ctx.d.cfg.tokens.find((t) => t.name === "jarvis")?.autoCaptcha).toBe(true);
  });
});
