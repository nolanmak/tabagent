// DA8: strict one-time-code extraction, shared by the Gmail reader (extension, #34) and the SMS source
// (bridge, #36). Pure: messages and clock in, one code (or a count) out. Message text is untrusted and
// is never returned; only the digits leave this module.
import { TabAgentError } from "./errors";

export interface CodeMessage {
  /** Stable id (row id, Gmail message id). Lets callers mark a code as used. */
  id?: string;
  /** Received time, epoch ms. */
  date: number;
  text: string;
  subject?: string;
  /** Sender: email address, phone number or short code. */
  from?: string;
}

export interface ExtractOptions {
  /** Only messages received at or after this (epoch ms). */
  since: number;
  now: number;
  /** The site's stated format: a digit count (6) or a regex source for the whole code (`[A-Z0-9]{8}`). */
  format?: number | string;
  /** Sender filter: email domain (subdomains match) or exact phone/short code. */
  from?: string;
  /** Default 10 minutes (DA8). */
  maxAgeMs?: number;
  /** Message ids already consumed: a code is used once. */
  used?: ReadonlySet<string>;
}

export type ExtractResult = { code: string; messageId?: string } | { none: true } | { ambiguous: number };

export const CODE_MAX_AGE_MS = 10 * 60_000;
/** DA8 default `since`: the request moment minus 30s. */
export const CODE_SINCE_SLACK_MS = 30_000;
export const CODE_DEFAULT_TIMEOUT = 60_000;

const KEYWORD = /\b(?:code|codes|verification|verify|otp|passcode|pass\s?code|2fa|two[-\s]factor|one[-\s]time|security\s+code|login\s+code|sign[-\s]in\s+code|pin)\b/i;
/** Keyword within this many characters of the code, either side. */
const NEAR = 80;

/** Digits 4-8 long, optionally one space or dash in the middle of 6 or 8 ("123 456", "1234-5678"). */
// "-" right before the digits means "not a bare code", except one capital letter + "-" (Google's "G-123456", #83 D9).
const DIGIT_CODE = /(?<![\d+()./:,$#])(?<!(?<!(?:^|[^A-Za-z0-9])[A-Z])-)(?<!\d[ -])(?:(\d{3})[ -](\d{3})|(\d{4})[ -](\d{4})|(\d{4,8}))(?![\d\-/:%]|[.,]\d|[ -]\d)/g;

function senderMatches(filter: string, from: string | undefined): boolean {
  if (!from) return false;
  const f = filter.trim().toLowerCase().replace(/^@/, "");
  const s = from.trim().toLowerCase();
  const email = s.match(/@([a-z0-9.-]+)>?$/);
  if (email) {
    const d = email[1];
    return d === f || d.endsWith("." + f);
  }
  return s.replace(/[\s()-]/g, "") === f.replace(/[\s()-]/g, "");
}

function isYear(n: string): boolean {
  return n.length === 4 && /^(19|20)\d\d$/.test(n);
}

/** Candidate codes in one piece of text, each with a keyword nearby. */
function candidatesIn(text: string, format?: number | string): string[] {
  const out: string[] = [];
  if (!text) return out;
  if (typeof format === "string") {
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${format})(?![A-Za-z0-9])`, "g");
    for (const m of text.matchAll(re)) if (nearKeyword(text, m.index!, m[0].length)) out.push(m[0]);
    return out;
  }
  for (const m of text.matchAll(DIGIT_CODE)) {
    const code = m[1] ? m[1] + m[2] : m[3] ? m[3] + m[4] : m[5];
    if (typeof format === "number" && code.length !== format) continue;
    if (format === undefined && isYear(code)) continue;
    if (!nearKeyword(text, m.index!, m[0].length)) continue;
    out.push(code);
  }
  return out;
}

function nearKeyword(text: string, at: number, len: number): boolean {
  const window = text.slice(Math.max(0, at - NEAR), at) + " " + text.slice(at + len, at + len + NEAR);
  return KEYWORD.test(window);
}

/**
 * DA8. Messages newer than `since` and younger than `maxAgeMs`, optional sender filter; a 4-8 digit
 * number (or `format`) near a keyword. One distinct candidate → it; none → none; more → ambiguous: n.
 */
export function extractCode(messages: readonly CodeMessage[], opts: ExtractOptions): ExtractResult {
  const maxAge = opts.maxAgeMs ?? CODE_MAX_AGE_MS;
  const found = new Map<string, string | undefined>();
  for (const m of messages) {
    if (!Number.isFinite(m.date) || m.date < opts.since || opts.now - m.date > maxAge) continue;
    if (m.id !== undefined && opts.used?.has(m.id)) continue;
    if (opts.from && !senderMatches(opts.from, m.from)) continue;
    const codes = new Set([...candidatesIn(m.subject ?? "", opts.format), ...candidatesIn(m.text ?? "", opts.format)]);
    for (const c of codes) if (!found.has(c)) found.set(c, m.id);
  }
  if (found.size === 0) return { none: true };
  if (found.size > 1) return { ambiguous: found.size };
  const [[code, messageId]] = [...found];
  return messageId === undefined ? { code } : { code, messageId };
}

export interface PollOptions extends Omit<ExtractOptions, "now"> {
  /** Total wait, ms (default 60000). */
  timeout?: number;
  /** Re-poll interval, ms (default 2000). */
  interval?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop early (kill switch, command cancelled). */
  signal?: AbortSignal;
}

/**
 * Re-poll `read` until exactly one code appears. none → wait and retry until `timeout` → TIMEOUT;
 * ambiguous → BAD_REQUEST with the count (never the values).
 */
export async function pollCode(read: () => Promise<readonly CodeMessage[]> | readonly CodeMessage[], opts: PollOptions): Promise<{ code: string; messageId?: string }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = opts.timeout ?? CODE_DEFAULT_TIMEOUT;
  const interval = opts.interval ?? 2000;
  const deadline = now() + timeout;
  for (;;) {
    if (opts.signal?.aborted) throw new TabAgentError("KILLED", "Code wait was cancelled");
    const r = extractCode(await read(), { ...opts, now: now() });
    if ("code" in r) return r;
    if ("ambiguous" in r) {
      throw new TabAgentError("BAD_REQUEST", `${r.ambiguous} different codes arrived since the request; refusing to guess`, "Wait for a single fresh code and call auth.code again.");
    }
    const left = deadline - now();
    if (left <= 0) throw new TabAgentError("TIMEOUT", `No code arrived within ${Math.round(timeout / 1000)}s`, "Check that the code was sent, then call auth.code again (optionally with a longer timeout).");
    await sleep(Math.min(interval, left));
  }
}
