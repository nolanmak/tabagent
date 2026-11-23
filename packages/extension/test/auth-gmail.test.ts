// #34 Gmail reader (OA4: Atom feed) against saved fixtures, plus extractCode wiring.
import { extractCode } from "@tabagent/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GMAIL_FEED_URL, readFeed } from "../src/background/auth/pure/gmail";

const FIX = join(__dirname, "../../../e2e/fixtures/auth/gmail");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");
const T = Date.parse("2026-11-23T10:05:00Z");

describe("readFeed", () => {
  it("signed-in feed → messages with sender, subject, snippet, date", () => {
    const r = readFeed(GMAIL_FEED_URL, fx("feed-code.xml"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]).toMatchObject({ from: "noreply@github.com", subject: "Your GitHub launch code", date: Date.parse("2026-11-23T10:04:30Z"), id: "tag:gmail.google.com,2004:1800000000000000001" });
    expect(r.messages[1].subject).toBe("Weekly digest & offers");
  });

  it("code mail → exactly the one fresh code (old code, phone, year, order no. are not candidates)", () => {
    const r = readFeed(GMAIL_FEED_URL, fx("feed-code.xml"));
    if (!r.ok) throw new Error("not ok");
    expect(extractCode(r.messages, { since: T - 120_000, now: T })).toEqual({ code: "482913", messageId: "tag:gmail.google.com,2004:1800000000000000001" });
    expect(extractCode(r.messages, { since: T - 120_000, now: T, from: "github.com" })).toMatchObject({ code: "482913" });
    expect(extractCode(r.messages, { since: T - 120_000, now: T, from: "other.example" })).toEqual({ none: true });
  });

  it("redirected to accounts.google.com → NOT_FOUND (Gmail not signed in)", () => {
    expect(readFeed("https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com", fx("signin.html"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("sign-in page served without a redirect → NOT_FOUND", () => {
    expect(readFeed(GMAIL_FEED_URL, fx("signin.html"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("unrecognised structure (inbox HTML instead of the feed) → UNSUPPORTED", () => {
    expect(readFeed(GMAIL_FEED_URL, fx("unrecognised.html"))).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  });

  it("empty feed → no messages", () => {
    expect(readFeed(GMAIL_FEED_URL, `<?xml version="1.0"?><feed version="0.3"><fullcount>0</fullcount></feed>`)).toEqual({ ok: true, messages: [] });
  });

  it("entries without a parseable date are skipped; entities and CDATA decoded", () => {
    const xml = `<feed><fullcount>2</fullcount><entry><title>x</title><issued>bogus</issued></entry><entry><title><![CDATA[Code &amp; more]]></title><summary>Your code is &#52;&#x35;6789</summary><issued>2026-11-23T10:00:00Z</issued></entry></feed>`;
    const r = readFeed(GMAIL_FEED_URL, xml);
    expect(r).toMatchObject({ ok: true, messages: [{ subject: "Code & more", text: "Your code is 456789" }] });
  });
});
