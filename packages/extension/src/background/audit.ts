// Audit record (D20) and the result envelope (D14). Pure; built in the extension
// because only it knows what is sensitive.

export const MASK = "••••";

export type Outcome = "ok" | "error" | "denied";

export interface AuditRecord {
  tool: string;
  action?: string;
  origin: string | null;
  params: unknown;
  outcome: Outcome;
  errorCode?: string;
  resultSummary: { bytes: number; sha256: string };
}

/** Param keys whose values are always masked. */
export const SENSITIVE_KEY = /pass(word|wd|code)?|pwd|secret|token|card|cc-?(num|number|csc|exp)|cvv|cvc|csc|security.?code|ssn|social.?sec|\bpin\b|otp|iban|routing|account.?num|tax.?id/i;
const CARD_LIKE = /^\d{13,19}$/;
const SSN_LIKE = /^\d{3}-?\d{2}-?\d{4}$/;

export interface RedactOpts {
  /** Param paths (e.g. "text", "fields.e12") the caller knows are sensitive (password/card fields). */
  sensitivePaths?: string[];
  maxString?: number;
}

/** Our own option names that merely contain a sensitive-looking word. */
const SAFE_KEYS = /^(max(Tokens|Chars|Bytes|Pages)|tabId|timeout)$/;

function sensitiveKey(k: string) {
  return !!k && !SAFE_KEYS.test(k) && SENSITIVE_KEY.test(k);
}

function looksSensitiveValue(v: string) {
  const d = v.replace(/[\s-]/g, "");
  return CARD_LIKE.test(d) || SSN_LIKE.test(v.trim());
}

/** Redact params for the feed and audit log. Never returns a raw sensitive value. */
export function redactParams(value: unknown, opts: RedactOpts = {}, path = "", keyHint = ""): unknown {
  const max = opts.maxString ?? 300;
  const forced = !!path && (opts.sensitivePaths ?? []).includes(path);
  if (value == null) return value;
  if (typeof value === "string") {
    if (forced || sensitiveKey(keyHint) || looksSensitiveValue(value)) return MASK;
    return value.length > max ? value.slice(0, max) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (forced || sensitiveKey(keyHint)) return MASK;
    if (typeof value === "number" && looksSensitiveValue(String(value))) return MASK;
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => redactParams(v, opts, path ? `${path}.${i}` : String(i), keyHint));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (forced) {
        out[k] = MASK;
        continue;
      }
      out[k] = redactParams(v, opts, p, k);
    }
    return out;
  }
  return MASK;
}

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function summarizeResult(result: unknown): Promise<{ bytes: number; sha256: string }> {
  const s = result === undefined ? "" : JSON.stringify(result) ?? "";
  return { bytes: enc.encode(s).length, sha256: await sha256Hex(s) };
}

export async function buildAudit(a: { tool: string; action?: string; origin: string | null; params: unknown; outcome: Outcome; errorCode?: string; result?: unknown; redact?: RedactOpts }): Promise<AuditRecord> {
  return {
    tool: a.tool,
    ...(a.action ? { action: a.action } : {}),
    origin: a.origin,
    params: redactParams(a.params ?? {}, a.redact),
    outcome: a.outcome,
    ...(a.errorCode ? { errorCode: a.errorCode } : {}),
    resultSummary: await summarizeResult(a.result),
  };
}

// ---------------------------------------------------------------------------
// Envelope (contract §3/§4): lift handler `__side` to top-level fields.
// ---------------------------------------------------------------------------

export interface SideEffects {
  snapshotDiff?: string;
  navigation?: { url: string; title: string; kind: string };
  dialogs?: { type: string; message: string; defaultPrompt?: string }[];
  downloads?: { id: number; filename: string; state: string }[];
}

const SIDE_KEYS = ["snapshotDiff", "navigation", "dialogs", "downloads"] as const;

export function liftSide(result: unknown): { result: unknown; side: SideEffects } {
  if (!result || typeof result !== "object" || Array.isArray(result) || !("__side" in result)) return { result, side: {} };
  const { __side, ...rest } = result as { __side?: Record<string, unknown> };
  const side: SideEffects = {};
  if (__side && typeof __side === "object") {
    for (const k of SIDE_KEYS) if (__side[k] !== undefined && __side[k] !== null) (side as any)[k] = __side[k];
  }
  return { result: rest, side };
}

export function outcomeFor(code: string | undefined): Outcome {
  if (!code) return "ok";
  return code === "PERMISSION_DENIED" || code === "KILLED" || code === "PROMPT_TIMEOUT" ? "denied" : "error";
}
