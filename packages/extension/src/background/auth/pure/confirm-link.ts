// #113 auth.confirm_link, pure parts. The extension reads the sign-up confirmation email itself (in the
// private "TabAgent auth" tab, like the code reader) and the agent never sees the email or the link.
//
// O1 (the Atom feed has no links): the feed entry id carries Gmail's decimal message id; the message's
// "show original" view (/mail/u/0/?view=om&permmsgid=msg-f:<id>) is the raw RFC 822 message inside one
// <pre id="raw_message_text">, with no Gmail link rewriting. From it only the body parts are read, and
// from those only <a href> values (or bare https URLs in a text-only mail) with their anchor text.
// Headers (List-Unsubscribe and friends) and attachments are ignored.
//
// Selection (D3): https links whose host's registrable domain equals the sign-up site's, minus
// unsubscribe / preference links, that look like a confirmation link (path or anchor text says verify,
// confirm, activate or validate). Exactly one distinct URL → follow it; none or several → handoff.
import { registrableDomain, senderMatches, TabAgentError, type CodeMessage } from "@tabagent/protocol";
import { decode } from "./gmail";

export interface MailLink {
  href: string;
  /** Visible anchor text, whitespace collapsed (empty for bare URLs in text mail). */
  text: string;
}

export type LinkPick = { ok: true; url: string } | { ok: false; reason: "none" | "ambiguous" };

/** Mail older than this is never read for a confirmation link, whatever `since` says. */
export const CONFIRM_MAX_AGE_MS = 30 * 60_000;
const MAX_RAW = 2_000_000;
const MAX_DEPTH = 6;
const MAX_TEXT = 200;

const CONFIRM = /verif|confirm|activat|validat/i;
const UNSUBSCRIBE = /unsubscribe|opt[-_ ]?out|preferences|manage[-_ ]?(?:subscriptions?|notifications?|e-?mails?)|e-?mail[-_ ]?settings/i;

function cleanText(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

/** Links in an email body: `<a href>` values in HTML, bare https URLs in plain text. */
export function extractLinks(body: string, type: "text/html" | "text/plain" = "text/html"): MailLink[] {
  const out: MailLink[] = [];
  if (type === "text/plain") {
    for (const m of body.matchAll(/https:\/\/[^\s<>"'()[\]]+/g)) out.push({ href: m[0].replace(/[.,;:!?]+$/, ""), text: "" });
    return out;
  }
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const h = m[1].match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    if (!h) continue;
    out.push({ href: decode(h[1] ?? h[2] ?? h[3] ?? "").trim(), text: cleanText(m[2]) });
  }
  return out;
}

/** D3: the one confirmation link on `siteDomain` (a registrable domain), or why there is none. */
export function selectConfirmLink(links: readonly MailLink[], siteDomain: string): LinkPick {
  const site = siteDomain.toLowerCase();
  const found = new Set<string>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname) continue;
    if (registrableDomain(u.hostname) !== site) continue;
    if (UNSUBSCRIBE.test(u.pathname + u.search) || UNSUBSCRIBE.test(l.text)) continue;
    if (!CONFIRM.test(u.pathname) && !CONFIRM.test(l.text)) continue;
    u.hash = "";
    found.add(u.href);
  }
  if (found.size === 1) return { ok: true, url: [...found][0] };
  return { ok: false, reason: found.size ? "ambiguous" : "none" };
}

// ---------------------------------------------------------------------------
// Raw message (RFC 822 / MIME)
// ---------------------------------------------------------------------------

interface Part {
  type: string;
  boundary?: string;
  cte: string;
  body: string;
}

function splitPart(text: string): Part {
  const m = text.match(/\r?\n\r?\n/);
  const head = m ? text.slice(0, m.index) : text;
  const body = m ? text.slice(m.index! + m[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const ct = headers.get("content-type") ?? "text/plain";
  const boundary = ct.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  return { type: ct.split(";")[0].trim().toLowerCase(), boundary: boundary ? (boundary[1] ?? boundary[2]) : undefined, cte: (headers.get("content-transfer-encoding") ?? "").toLowerCase(), body };
}

function utf8(bytes: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function decodeBody(body: string, cte: string): string {
  if (cte === "base64") {
    try {
      const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
      return utf8([...bin].map((c) => c.charCodeAt(0)));
    } catch {
      return "";
    }
  }
  if (cte === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    const enc = new TextEncoder();
    for (let i = 0; i < s.length; i++) {
      const hex = s.slice(i + 1, i + 3);
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else bytes.push(...enc.encode(s[i]));
    }
    return utf8(bytes);
  }
  return body;
}

function walk(text: string, out: { html: string[]; plain: string[] }, depth: number) {
  if (depth > MAX_DEPTH) return;
  const p = splitPart(text);
  if (p.type.startsWith("multipart/")) {
    if (!p.boundary) return;
    const lines = p.body.split(/\r?\n/);
    let cur: string[] | null = null;
    for (const line of lines) {
      const t = line.trimEnd();
      if (t === `--${p.boundary}--`) break;
      if (t === `--${p.boundary}`) {
        if (cur) walk(cur.join("\n"), out, depth + 1);
        cur = [];
      } else cur?.push(line);
    }
    if (cur) walk(cur.join("\n"), out, depth + 1);
    return;
  }
  if (p.type === "text/html") out.html.push(decodeBody(p.body, p.cte));
  else if (p.type === "text/plain") out.plain.push(decodeBody(p.body, p.cte));
}

/** Links in a raw message: from its HTML parts, or its plain-text parts when it has no HTML. */
export function parseRawMessage(raw: string): MailLink[] {
  const out = { html: [] as string[], plain: [] as string[] };
  walk(raw.slice(0, MAX_RAW), out, 0);
  return out.html.length ? out.html.flatMap((h) => extractLinks(h)) : out.plain.flatMap((t) => extractLinks(t, "text/plain"));
}

// ---------------------------------------------------------------------------
// Gmail pages and ids
// ---------------------------------------------------------------------------

/** The Gmail web app (read only inside the private auth tab, never by agent tools). */
export const GMAIL_APP_URL = "https://mail.google.com/mail/u/0/";

export type OriginalRead = { ok: true; raw: string } | { ok: false; code: "NOT_FOUND" | "UNSUPPORTED"; reason: string };

function isSignIn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "accounts.google.com" || /ServiceLogin|signin/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** The raw message on Gmail's "show original" page. A changed page is UNSUPPORTED, never guessed at. */
export function readOriginalPage(finalUrl: string, html: string): OriginalRead {
  if (isSignIn(finalUrl)) return { ok: false, code: "NOT_FOUND", reason: "Gmail is not signed in in this browser" };
  const m = html.match(/<pre\b[^>]*\bid\s*=\s*["']?raw_message_text["']?[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) return { ok: false, code: "UNSUPPORTED", reason: "The Gmail message view did not have the expected structure" };
  return { ok: true, raw: decode(m[1]) };
}

/** Gmail's decimal message id from an Atom feed entry id (`tag:gmail.google.com,2004:<id>`). */
export function gmailMessageId(entryId: string | undefined): string | null {
  const m = entryId?.match(/^tag:gmail\.google\.com,2004:(\d{1,20})$/);
  return m ? m[1] : null;
}

/** The "show original" view of one message, optionally with the account key Gmail may ask for. */
export function originalUrl(messageId: string, ik?: string): string {
  const q = new URLSearchParams();
  if (ik) q.set("ik", ik);
  q.set("view", "om");
  q.set("permmsgid", `msg-f:${messageId}`);
  return `${GMAIL_APP_URL}?${q}`;
}

/** Top-level elements of a JS array literal's body (strings and nesting respected). */
function topLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(src.slice(start).trim());
  return out;
}

/** Gmail's per-account key (`ik`) from the app page: GLOBALS[9], or an `"ik":"…"` pair. */
export function findIk(html: string): string | null {
  const g = html.match(/GLOBALS\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (g) {
    const v = topLevel(g[1])[9]?.match(/^"([0-9a-f]{10})"$/);
    if (v) return v[1];
  }
  return html.match(/["']ik["']\s*:\s*["']([0-9a-f]{10})["']/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Waiting for the mail
// ---------------------------------------------------------------------------

export interface MessagePollOptions {
  since: number;
  /** Sender filter (email domain; subdomains match). */
  from: string;
  /** Message ids already checked or followed. */
  skip: ReadonlySet<string>;
  timeout: number;
  interval?: number;
  maxAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Re-read the inbox until at least one unchecked message from `from` arrived since `since`; returns
 * them newest first (ids and dates only). None within `timeout` → TIMEOUT.
 */
export async function pollMessages(read: () => Promise<readonly CodeMessage[]>, o: MessagePollOptions): Promise<{ id: string; date: number }[]> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAge = o.maxAgeMs ?? CONFIRM_MAX_AGE_MS;
  const deadline = now() + o.timeout;
  for (;;) {
    if (o.signal?.aborted) throw new TabAgentError("KILLED", "The email wait was cancelled");
    const t = now();
    const hits = (await read())
      .filter((m): m is CodeMessage & { id: string } => !!m.id && !o.skip.has(m.id) && Number.isFinite(m.date) && m.date >= o.since && t - m.date <= maxAge && senderMatches(o.from, m.from))
      .sort((a, b) => b.date - a.date)
      .map((m) => ({ id: m.id, date: m.date }));
    if (hits.length) return hits;
    const left = deadline - now();
    if (left <= 0) throw new TabAgentError("TIMEOUT", `No new email from ${o.from} arrived within ${Math.round(o.timeout / 1000)}s`, "Check that the site sent the confirmation email (and that it is unread in the Gmail inbox), then call auth.confirm_link again.");
    await sleep(Math.min(o.interval ?? 2000, left));
  }
}
