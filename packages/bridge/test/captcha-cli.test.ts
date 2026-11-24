// captcha.json settings (keys from env or a 0600 file) and `tabagent captcha enable|disable|status`,
// plus `tabagent token create --auto-captcha` / `token auto-captcha`.
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { captchaUnsolved } from "@tabagent/protocol";
import { captchaCommand, readCaptchaSettings, type CaptchaCliDeps } from "../src/captcha";
import { tokenCommand } from "../src/commands";
import { loadConfig } from "../src/config";
import { authenticate } from "../src/tokens";
import { tempHome } from "./helpers";

const KEY = "CAP-1111222233334444555566667777aaaa";
let home: string;
let path: string;
beforeEach(() => {
  home = tempHome();
  path = join(home, "captcha.json");
});

function deps(o: Partial<CaptchaCliDeps> = {}): CaptchaCliDeps & { asked: string[] } {
  const asked: string[] = [];
  return { asked, readKey: async (p) => (asked.push(p), KEY), balance: async () => 3.5, env: {}, path, ...o };
}
const text = (o: { out: string[]; err: string[] }) => [...o.out, ...o.err].join("\n");

describe("readCaptchaSettings", () => {
  it("off by default", () => {
    expect(readCaptchaSettings(path, {}).providers).toEqual([]);
  });
  it("CAPSOLVER_API_KEY alone turns on the default provider; TABAGENT_CAPTCHA_KEY too", () => {
    const s = readCaptchaSettings(path, { CAPSOLVER_API_KEY: KEY });
    expect(s.providers).toEqual(["capsolver"]);
    expect(s.keys.capsolver).toEqual({ key: KEY, source: "env CAPSOLVER_API_KEY" });
    expect(readCaptchaSettings(path, { TABAGENT_CAPTCHA_KEY: KEY }).keys.capsolver?.source).toBe("env TABAGENT_CAPTCHA_KEY");
  });
  it("env wins over the file; TABAGENT_CAPTCHA_KEY goes to the first token provider", () => {
    writeFileSync(path, JSON.stringify({ providers: ["vision", "2captcha"], keys: { "2captcha": "file-key-123456" } }), { mode: 0o600 });
    const s = readCaptchaSettings(path, { TABAGENT_CAPTCHA_KEY: KEY });
    expect(s.keys["2captcha"]).toEqual({ key: KEY, source: "env TABAGENT_CAPTCHA_KEY" });
    expect(readCaptchaSettings(path, {}).keys["2captcha"]).toEqual({ key: "file-key-123456", source: "file" });
  });
  it("a group/world-readable file's keys are ignored with a fix-it problem", () => {
    writeFileSync(path, JSON.stringify({ providers: ["capsolver"], keys: { capsolver: KEY } }));
    chmodSync(path, 0o644);
    const s = readCaptchaSettings(path, {});
    expect(s.keys.capsolver).toBeUndefined();
    expect(s.problems.join("\n")).toMatch(/chmod 600/);
    expect(s.problems.join("\n")).not.toContain(KEY);
  });
  it("vision endpoint, model, key and rounds; env overrides", () => {
    writeFileSync(path, JSON.stringify({ providers: ["vision"], vision: { baseUrl: "https://a.test/v1", model: "m1", key: "sk-file", rounds: 99 } }), { mode: 0o600 });
    expect(readCaptchaSettings(path, {}).vision).toEqual({ baseUrl: "https://a.test/v1", model: "m1", key: { key: "sk-file", source: "file" }, rounds: 10 });
    expect(readCaptchaSettings(path, { TABAGENT_VISION_MODEL: "m2", TABAGENT_VISION_KEY: "sk-env" }).vision).toMatchObject({ model: "m2", key: { source: "env TABAGENT_VISION_KEY" } });
  });
});

describe("tabagent captcha enable", () => {
  it("defaults to capsolver, checks the key, writes it 0600 and never prints it", async () => {
    const d = deps();
    const o = await captchaCommand(["enable"], {}, d);
    expect(o.code).toBe(0);
    expect(text(o)).toMatch(/balance \$3\.50/);
    expect(text(o)).not.toContain(KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ providers: ["capsolver"], keys: { capsolver: KEY } });
  });
  it("a key the provider rejects is not saved", async () => {
    const o = await captchaCommand(["enable", "capsolver"], {}, deps({ balance: async () => Promise.reject(captchaUnsolved("provider_auth", undefined, "capsolver ERROR_KEY_DENIED_ACCESS")) }));
    expect(o.code).toBe(1);
    expect(() => readFileSync(path)).toThrow();
  });
  it("a key from CAPSOLVER_API_KEY is used and not written to disk", async () => {
    const d = deps({ env: { CAPSOLVER_API_KEY: KEY } });
    const o = await captchaCommand(["enable", "capsolver"], {}, d);
    expect(o.code).toBe(0);
    expect(d.asked).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain(KEY);
    expect(text(o)).toMatch(/CAPSOLVER_API_KEY/);
  });
  it("vision needs an https endpoint and model; --fallback sets the order", async () => {
    expect((await captchaCommand(["enable", "vision"], {}, deps())).code).toBe(1);
    expect((await captchaCommand(["enable", "vision"], { "base-url": "http://evil.test/v1", model: "m" }, deps())).code).toBe(1);
    const v = await captchaCommand(["enable", "vision"], { "base-url": "https://llm.test/v1", model: "gpt-vis", rounds: "4" }, deps());
    expect(v.code).toBe(0);
    const o = await captchaCommand(["enable", "capsolver"], { fallback: "vision" }, deps());
    expect(text(o)).toMatch(/capsolver -> vision/);
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f).toMatchObject({ providers: ["capsolver", "vision"], vision: { baseUrl: "https://llm.test/v1", model: "gpt-vis", rounds: 4, key: KEY } });
  });
  it("re-enabling keeps the rest of the order", async () => {
    await captchaCommand(["enable", "vision"], { "base-url": "http://127.0.0.1:11434/v1", model: "llava" }, deps({ readKey: async () => "" }));
    await captchaCommand(["enable", "capsolver"], {}, deps());
    expect(readCaptchaSettings(path, {}).providers).toEqual(["capsolver", "vision"]);
  });
  it("rejects unknown providers and bad fallback lists", async () => {
    expect((await captchaCommand(["enable", "anticaptcha"], {}, deps())).code).toBe(1);
    expect((await captchaCommand(["enable"], { fallback: "vision,nope" }, deps())).code).toBe(1);
  });
});

describe("tabagent captcha status / disable", () => {
  it("status shows the order, key source and a short prefix only", async () => {
    await captchaCommand(["enable"], {}, deps());
    const o = await captchaCommand(["status"], { check: true }, deps({ autoTokens: () => ["jarvis"] }));
    expect(text(o)).toMatch(/Order: capsolver/);
    expect(text(o)).toMatch(/key from file \(CAP-…\)/);
    expect(text(o)).toMatch(/balance \$3\.50/);
    expect(text(o)).toMatch(/autoCaptcha tokens: jarvis/);
    expect(text(o)).not.toContain(KEY);
  });
  it("disable <provider> drops it; disable removes the file", async () => {
    await captchaCommand(["enable", "vision"], { "base-url": "https://llm.test/v1", model: "m" }, deps());
    await captchaCommand(["enable", "capsolver"], { fallback: "vision" }, deps());
    expect(text(await captchaCommand(["disable", "vision"], {}, deps()))).toMatch(/Order now: capsolver/);
    expect(JSON.parse(readFileSync(path, "utf8")).vision).toBeUndefined();
    await captchaCommand(["disable"], {}, deps());
    expect(text(await captchaCommand(["status"], {}, deps()))).toMatch(/off/);
  });
});

describe("token autoCaptcha", () => {
  it("token create --auto-captcha and token auto-captcha on|off", () => {
    const o = tokenCommand(["create"], { name: "jarvis", caps: "act", "auto-captcha": true });
    expect(o.code).toBe(0);
    const tok = o.out[0];
    expect(authenticate(loadConfig(), tok)).toMatchObject({ name: "jarvis", autoCaptcha: true });
    expect(tokenCommand(["list"], {}).out.join("\n")).toMatch(/jarvis.*auto-captcha/);
    expect(tokenCommand(["auto-captcha", "jarvis", "off"], {}).code).toBe(0);
    expect(authenticate(loadConfig(), tok)?.autoCaptcha).toBeUndefined();
    expect(tokenCommand(["auto-captcha", "jarvis", "on"], {}).code).toBe(0);
    expect(authenticate(loadConfig(), tok)?.autoCaptcha).toBe(true);
    expect(tokenCommand(["auto-captcha", "nobody", "on"], {}).code).toBe(1);
    expect(tokenCommand(["auto-captcha", "jarvis", "maybe"], {}).code).toBe(1);
  });
});
