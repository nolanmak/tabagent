// ~/.tabagent/captcha.json (0600): which solvers, in which order, and their keys. Separate from
// config.json so the keys never sit beside settings that `tabagent config show` prints.
//
// {
//   "providers": ["capsolver", "vision"],        // fallback order; capsolver is the default
//   "keys": { "capsolver": "CAP-…", "2captcha": "…" },
//   "vision": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o", "key": "sk-…", "rounds": 3 },
//   "maxPerHour": 30
// }
//
// Keys from the environment win over the file: CAPSOLVER_API_KEY, TWOCAPTCHA_API_KEY,
// TABAGENT_CAPTCHA_KEY (the first token provider in the order), TABAGENT_VISION_KEY.
// TABAGENT_VISION_BASE_URL / TABAGENT_VISION_MODEL override the vision endpoint.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAPTCHA_PROVIDERS, VISION_DEFAULT_ROUNDS, type CaptchaProviderName } from "@tabagent/protocol";
import { home } from "../config";

export type TokenProviderName = "capsolver" | "2captcha";

export interface CaptchaFile {
  providers?: CaptchaProviderName[];
  keys?: Partial<Record<TokenProviderName, string>>;
  vision?: { baseUrl?: string; model?: string; key?: string; rounds?: number };
  maxPerHour?: number;
}

export interface KeyRef {
  key: string;
  /** Where it came from, for `status`: "env CAPSOLVER_API_KEY" or "file". Never the key. */
  source: string;
}

export interface CaptchaSettings {
  providers: CaptchaProviderName[];
  keys: Partial<Record<TokenProviderName, KeyRef>>;
  vision: { baseUrl?: string; model?: string; key?: KeyRef; rounds: number };
  maxPerHour: number;
  /** Things the user must fix (shown by `status`; no secret in them). */
  problems: string[];
}

export const DEFAULT_MAX_PER_HOUR = 30;

export function captchaPath(): string {
  return join(home(), "captcha.json");
}

const isProvider = (p: unknown): p is CaptchaProviderName => (CAPTCHA_PROVIDERS as readonly string[]).includes(p as string);
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);

export function readCaptchaFile(path = captchaPath()): { file: CaptchaFile; loose: boolean } {
  if (!existsSync(path)) return { file: {}, loose: false };
  let loose = false;
  try {
    loose = process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0;
  } catch {
    /* */
  }
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { file: j && typeof j === "object" ? (j as CaptchaFile) : {}, loose };
  } catch {
    return { file: {}, loose };
  }
}

export function readCaptchaSettings(path = captchaPath(), env: NodeJS.ProcessEnv = process.env): CaptchaSettings {
  const { file, loose } = readCaptchaFile(path);
  const problems: string[] = [];
  const fileHasSecret = !!(file.keys && Object.values(file.keys).some(Boolean)) || !!file.vision?.key;
  const fileKeysOk = !(loose && fileHasSecret);
  if (!fileKeysOk) problems.push(`${path} is readable by other users, so its keys are ignored. Run: chmod 600 ${path}`);
  let providers = Array.isArray(file.providers) ? [...new Set(file.providers.filter(isProvider))] : [];
  // No file: a CapSolver key in the environment is enough to turn the default provider on.
  if (!Array.isArray(file.providers) && (env.CAPSOLVER_API_KEY || env.TABAGENT_CAPTCHA_KEY)) providers = ["capsolver"];
  const firstToken = providers.find((p): p is TokenProviderName => p === "capsolver" || p === "2captcha");
  const keys: CaptchaSettings["keys"] = {};
  const pick = (name: TokenProviderName, envName: string) => {
    if (env[envName]) keys[name] = { key: String(env[envName]).trim(), source: `env ${envName}` };
    else if (name === firstToken && env.TABAGENT_CAPTCHA_KEY) keys[name] = { key: String(env.TABAGENT_CAPTCHA_KEY).trim(), source: "env TABAGENT_CAPTCHA_KEY" };
    else if (fileKeysOk && typeof file.keys?.[name] === "string" && file.keys[name]) keys[name] = { key: String(file.keys[name]).trim(), source: "file" };
  };
  pick("capsolver", "CAPSOLVER_API_KEY");
  pick("2captcha", "TWOCAPTCHA_API_KEY");
  const v = file.vision ?? {};
  const visionKey = env.TABAGENT_VISION_KEY ? { key: env.TABAGENT_VISION_KEY.trim(), source: "env TABAGENT_VISION_KEY" } : fileKeysOk && v.key ? { key: v.key, source: "file" } : undefined;
  const vision = {
    baseUrl: env.TABAGENT_VISION_BASE_URL || v.baseUrl || undefined,
    model: env.TABAGENT_VISION_MODEL || v.model || undefined,
    ...(visionKey ? { key: visionKey } : {}),
    rounds: clamp(v.rounds, 1, 10, VISION_DEFAULT_ROUNDS),
  };
  for (const p of providers) {
    if ((p === "capsolver" || p === "2captcha") && !keys[p]) problems.push(`${p} is enabled but has no API key. Run: tabagent captcha enable ${p}`);
    if (p === "vision" && (!vision.baseUrl || !vision.model)) problems.push("vision is enabled but has no endpoint. Run: tabagent captcha enable vision --base-url <url> --model <model>");
  }
  return { providers, keys, vision, maxPerHour: clamp(file.maxPerHour, 1, 1000, DEFAULT_MAX_PER_HOUR), problems };
}

/** Atomic write, 0600 file in a 0700 dir. */
export function writeCaptchaFile(change: (f: CaptchaFile) => CaptchaFile, path = captchaPath()): CaptchaFile {
  const next = change(readCaptchaFile(path).file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return next;
}

export function removeCaptchaFile(path = captchaPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
