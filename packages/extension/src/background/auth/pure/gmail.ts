// #34 / OA4: the Gmail email-code reader reads Gmail's Atom feed (/mail/u/0/feed/atom) in the private
// "TabAgent auth" tab, with the browser's own Gmail session. Chosen over the inbox DOM and the search
// URL because it is the smallest surface: a stable, documented XML format with sender, subject, a short
// snippet and a timestamp per unread inbox message, no scripts, no UI to parse, no click-through.
// Pure: page URL + document text in, messages (or a refusal) out. Message text is untrusted and is
// only ever handed to extractCode (protocol auth-code.ts); it is never returned or logged.
import type { CodeMessage } from "@tabagent/protocol";

export const GMAIL_FEED_URL = "https://mail.google.com/mail/u/0/feed/atom";

export type FeedRead = { ok: true; messages: CodeMessage[] } | { ok: false; code: "NOT_FOUND" | "UNSUPPORTED"; reason: string };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]).trim() : null;
}

function isSignInPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "accounts.google.com" || /ServiceLogin|signin/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Parse what the reader tab shows. `finalUrl` is where the tab ended up: a redirect to
 * accounts.google.com means Gmail isn't signed in (NOT_FOUND; we never try to sign in to Gmail).
 * A page that isn't the feed shape is UNSUPPORTED, so a Gmail change fails loudly, not silently.
 */
export function readFeed(finalUrl: string, text: string): FeedRead {
  if (isSignInPage(finalUrl)) return { ok: false, code: "NOT_FOUND", reason: "Gmail is not signed in in this browser" };
  if (!/<feed[\s>]/i.test(text) || !/<fullcount>/i.test(text)) {
    if (/<form[^>]+(signin|ServiceLogin)|accounts\.google\.com\/(v3\/)?signin/i.test(text)) return { ok: false, code: "NOT_FOUND", reason: "Gmail is not signed in in this browser" };
    return { ok: false, code: "UNSUPPORTED", reason: "The Gmail feed did not have the expected structure" };
  }
  const messages: CodeMessage[] = [];
  for (const m of text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1];
    const when = tag(e, "issued") ?? tag(e, "modified") ?? tag(e, "updated");
    const date = when ? Date.parse(when) : NaN;
    if (!Number.isFinite(date)) continue;
    const author = tag(e, "author") ?? "";
    const from = tag(author, "email") ?? undefined;
    const id = tag(e, "id") ?? undefined;
    messages.push({ id, date, subject: tag(e, "title") ?? "", text: tag(e, "summary") ?? "", from });
  }
  return { ok: true, messages };
}
