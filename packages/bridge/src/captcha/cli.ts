// `tabagent captcha enable|disable|status`. Plain functions returning their output (like commands.ts)
// with injectable deps so they are unit-tested. Keys are read from the environment, stdin or a hidden
// prompt, never from a flag (shell history), and are never printed.
import { CAPTCHA_PROVIDERS, captchaReasonOf, toTabAgentError, type CaptchaProviderName } from "@tabagent/protocol";
import type { Out } from "../commands";
import { captchaPath, readCaptchaSettings, removeCaptchaFile, writeCaptchaFile, type CaptchaFile, type TokenProviderName } from "./config";

type Flags = Record<string, string | boolean>;
const ok = (out: string[] = [], err: string[] = []): Out => ({ out, err, code: 0 });
const fail = (msg: string, out: string[] = []): Out => ({ out, err: [msg], code: 1 });

export interface CaptchaCliDeps {
  /** Ask for a key (hidden prompt on a TTY, else stdin). Empty/null = none given. */
  readKey(prompt: string): Promise<string | null>;
  /** Balance check for a token provider; throws CAPTCHA_UNSOLVED with a reason. */
  balance(name: TokenProviderName, key: string): Promise<number>;
  env?: NodeJS.ProcessEnv;
  path?: string;
  /** Token names with autoCaptcha on, for `status`. */
  autoTokens?: () => string[];
}

const ENV_KEY: Record<TokenProviderName, string> = { capsolver: "CAPSOLVER_API_KEY", "2captcha": "TWOCAPTCHA_API_KEY" };

export const CAPTCHA_EXPLAIN = [
  "CAPTCHA solving lets agents get past hCaptcha, reCAPTCHA and Turnstile on sites you allow them to act on.",
  "TabAgent first clicks the checkbox itself; only if an image challenge appears does it ask a solver.",
  "capsolver / 2captcha get the widget's site key and the page URL (no cookies, no page content) and are paid per solve.",
  "vision sends a screenshot of the challenge and its instruction to the model endpoint you configure.",
  "Keys stay in this bridge (captcha.json, 0600, or the environment); agents and the extension never see them.",
  "Identity checks (ID / selfie / passkey) are never automated: those use auth.handoff.",
];

function parseProviders(s: unknown): CaptchaProviderName[] | null {
  if (typeof s !== "string" || !s) return [];
  const list = s.split(",").map((x) => x.trim()).filter(Boolean);
  return list.every((x) => (CAPTCHA_PROVIDERS as readonly string[]).includes(x)) ? (list as CaptchaProviderName[]) : null;
}

export async function captchaCommand(pos: string[], f: Flags, d: CaptchaCliDeps): Promise<Out> {
  const env = d.env ?? process.env;
  const path = d.path ?? captchaPath();
  const [sub, arg] = pos;
  if (sub === "status") return status(f, d, env, path);
  if (sub === "disable") {
    if (!arg) return ok([removeCaptchaFile(path) ? `CAPTCHA solving off. Removed ${path}.` : "CAPTCHA solving was already off."]);
    if (!(CAPTCHA_PROVIDERS as readonly string[]).includes(arg)) return fail(`Unknown provider "${arg}". Providers: ${CAPTCHA_PROVIDERS.join(", ")}`);
    const next = writeCaptchaFile((c) => {
      const keys = { ...(c.keys ?? {}) };
      delete keys[arg as TokenProviderName];
      const out: CaptchaFile = { ...c, providers: (c.providers ?? []).filter((p) => p !== arg), keys };
      if (arg === "vision") delete out.vision;
      return out;
    }, path);
    return ok([`Removed ${arg}. Order now: ${next.providers?.join(" -> ") || "(none: solving off)"}`]);
  }
  if (sub !== "enable") return fail("Usage: tabagent captcha enable [capsolver|2captcha|vision] [--fallback vision] [--base-url URL --model M] [--rounds N] | disable [provider] | status [--check]", CAPTCHA_EXPLAIN);

  const name = (arg ?? "capsolver") as CaptchaProviderName; // CapSolver is the default
  if (!(CAPTCHA_PROVIDERS as readonly string[]).includes(name)) return fail(`Unknown provider "${name}". Providers: ${CAPTCHA_PROVIDERS.join(", ")}`);
  const fallback = parseProviders(f.fallback);
  if (fallback === null) return fail(`--fallback must be a comma list of: ${CAPTCHA_PROVIDERS.join(", ")}`);
  const notes: string[] = [];
  const cur = readCaptchaSettings(path, env);
  let fileKey: string | undefined;
  let visionPatch: CaptchaFile["vision"] | undefined;

  if (name === "capsolver" || name === "2captcha") {
    const fromEnv = env[ENV_KEY[name]] ? ENV_KEY[name] : env.TABAGENT_CAPTCHA_KEY ? "TABAGENT_CAPTCHA_KEY" : null;
    const key = fromEnv ? String(env[fromEnv]).trim() : ((await d.readKey(`${name} API key: `)) ?? "").trim();
    if (!key) return fail(`No ${name} API key given. Pipe it in (\`tabagent captcha enable ${name} < keyfile\`) or set ${ENV_KEY[name]}.`);
    if (!/^[\x21-\x7e]{8,200}$/.test(key)) return fail("That does not look like an API key (8-200 printable characters, no spaces).");
    try {
      const bal = await d.balance(name, key);
      notes.push(`${name} key works (balance $${bal.toFixed(2)}).`);
    } catch (e) {
      const reason = captchaReasonOf(toTabAgentError(e).message);
      if (reason === "provider_auth") return fail(`${name} rejected the key. Nothing was saved.`);
      notes.push(`Could not check the key with ${name} right now (${reason ?? "error"}); saved anyway.`);
    }
    if (fromEnv) notes.push(`Using the key from $${fromEnv}; it is not written to disk. Keep it set wherever the bridge runs.`);
    else fileKey = key;
  } else {
    const baseUrl = (typeof f["base-url"] === "string" ? f["base-url"] : undefined) ?? cur.vision.baseUrl;
    const model = (typeof f.model === "string" ? f.model : undefined) ?? cur.vision.model;
    if (!baseUrl || !model) return fail("vision needs an OpenAI-compatible endpoint: --base-url https://api.openai.com/v1 --model <vision model> (or TABAGENT_VISION_BASE_URL / TABAGENT_VISION_MODEL).");
    if (!/^https?:\/\//i.test(baseUrl)) return fail("--base-url must be an http(s) URL.");
    if (/^http:\/\//i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(baseUrl)) return fail("--base-url must be https (plain http only for localhost), since the key and screenshots go there.");
    visionPatch = { baseUrl, model };
    if (f.rounds !== undefined) visionPatch.rounds = Number(f.rounds);
    if (env.TABAGENT_VISION_KEY) notes.push("Using the key from $TABAGENT_VISION_KEY; it is not written to disk.");
    else {
      const key = ((await d.readKey("vision API key (empty for none): ")) ?? "").trim();
      if (key) visionPatch.key = key;
      else if (cur.vision.key?.source === "file") notes.push("Keeping the saved vision key.");
      else notes.push("No vision key: requests go without an Authorization header (fine for a local endpoint).");
    }
  }

  const next = writeCaptchaFile((c) => {
    const rest = (c.providers ?? []).filter((p) => p !== name);
    const providers = [...new Set([name, ...(f.fallback !== undefined ? (fallback as CaptchaProviderName[]) : rest)])];
    const out: CaptchaFile = { ...c, providers };
    if (fileKey) out.keys = { ...(c.keys ?? {}), [name]: fileKey };
    if (visionPatch) out.vision = { ...(c.vision ?? {}), ...visionPatch };
    if (f["max-per-hour"] !== undefined) out.maxPerHour = Number(f["max-per-hour"]);
    return out;
  }, path);
  const after = readCaptchaSettings(path, env);
  return ok([...CAPTCHA_EXPLAIN, "", ...notes, `Order: ${next.providers!.join(" -> ")}. Saved ${path} (0600).`, ...after.problems.map((p) => `! ${p}`), "Agents use it through captcha.solve (--profile auth), or automatically on tokens with `tabagent token auto-captcha <name> on`."]);
}

async function status(f: Flags, d: CaptchaCliDeps, env: NodeJS.ProcessEnv, path: string): Promise<Out> {
  const s = readCaptchaSettings(path, env);
  if (!s.providers.length) return ok(["CAPTCHA solving: off. Turn it on with `tabagent captcha enable capsolver`."]);
  const out = [`CAPTCHA solving: on. Order: ${s.providers.join(" -> ")}. Limit ${s.maxPerHour} solves/hour.`];
  for (const p of s.providers) {
    if (p === "vision") {
      out.push(`  vision: ${s.vision.baseUrl ?? "(no endpoint)"} model ${s.vision.model ?? "(none)"}, key ${s.vision.key ? `from ${s.vision.key.source}` : "none"}, ${s.vision.rounds} rounds`);
      continue;
    }
    const k = s.keys[p];
    let line = `  ${p}: ${k ? `key from ${k.source} (${k.key.slice(0, 4)}…)` : "NO KEY"}`;
    if (k && f.check) {
      try {
        line += `, balance $${(await d.balance(p, k.key)).toFixed(2)}`;
      } catch (e) {
        line += `, check failed (${captchaReasonOf(toTabAgentError(e).message) ?? "error"})`;
      }
    }
    out.push(line);
  }
  const auto = d.autoTokens?.() ?? [];
  out.push(`autoCaptcha tokens: ${auto.length ? auto.join(", ") : "(none)"}`);
  return ok(out, s.problems.map((p) => `! ${p}`));
}
