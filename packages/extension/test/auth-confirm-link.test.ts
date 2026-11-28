// #113 auth.confirm_link pure parts: link extraction from an email body, the one-link selection rule
// (D3), the Gmail "show original" page and raw MIME, and the matching-message poll. Synthetic
// fixtures only; no real email content.
import { describe, expect, it } from "vitest";
import {
  CONFIRM_MAX_AGE_MS,
  extractLinks,
  findIk,
  gmailMessageId,
  originalUrl,
  parseRawMessage,
  pollMessages,
  readOriginalPage,
  selectConfirmLink,
  type MailLink,
} from "../src/background/auth/pure/confirm-link";

const L = (href: string, text = ""): MailLink => ({ href, text });

describe("extractLinks", () => {
  it("collects <a href> values with their visible text, decoding entities", () => {
    const html = `<p>Hi</p><a class="btn" href="https://app.example.com/verify?t=abc&amp;u=1">Confirm <b>your</b> email</a> <A HREF='https://example.com/help'>Help</A> <a href=https://example.com/x>x</a>`;
    expect(extractLinks(html)).toEqual([L("https://app.example.com/verify?t=abc&u=1", "Confirm your email"), L("https://example.com/help", "Help"), L("https://example.com/x", "x")]);
  });

  it("ignores anchors without href and non-anchor tags carrying href", () => {
    expect(extractLinks(`<a name="top">t</a><link href="https://example.com/style.css"><area href="https://example.com/m">`)).toEqual([]);
  });

  it("plain text bodies: bare https URLs, trailing punctuation trimmed", () => {
    expect(extractLinks("Confirm here: https://example.com/confirm/abc. Or https://example.com/help).", "text/plain")).toEqual([L("https://example.com/confirm/abc"), L("https://example.com/help")]);
  });
});

describe("selectConfirmLink (D3)", () => {
  const site = "example.com";

  it("exactly one confirmation link on the site's registrable domain → it", () => {
    const r = selectConfirmLink([L("https://example.com/", "Home"), L("https://app.example.com/account/verify?token=t1", "Verify email"), L("https://example.com/privacy", "Privacy")], site);
    expect(r).toEqual({ ok: true, url: "https://app.example.com/account/verify?token=t1" });
  });

  it("anchor text alone can mark the confirmation link", () => {
    expect(selectConfirmLink([L("https://example.com/e/9f8e7d", "Activate my account"), L("https://example.com/about", "About")], site)).toEqual({ ok: true, url: "https://example.com/e/9f8e7d" });
  });

  it("the same link twice (button + plain-text copy) counts once", () => {
    const u = "https://example.com/confirm?k=1";
    expect(selectConfirmLink([L(u, "Confirm"), L(u + "#top", ""), L(u, u)], site)).toEqual({ ok: true, url: u });
  });

  it("several different confirmation links → ambiguous", () => {
    expect(selectConfirmLink([L("https://example.com/confirm?k=1"), L("https://example.com/validate?k=2")], site)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("no link looks like a confirmation link → none (a lone on-domain link is not followed)", () => {
    expect(selectConfirmLink([L("https://example.com/dashboard", "Open dashboard")], site)).toEqual({ ok: false, reason: "none" });
    expect(selectConfirmLink([], site)).toEqual({ ok: false, reason: "none" });
  });

  it("look-alike domains never match", () => {
    for (const h of ["https://example.com.evil.net/verify", "https://evil-example.com/verify", "https://examp1e.com/verify", "https://xn--exmple-cua.com/verify", "https://example.co/verify"]) {
      expect(selectConfirmLink([L(h, "Verify")], site)).toEqual({ ok: false, reason: "none" });
    }
  });

  it("tracking redirectors on other domains are dropped, even when they wrap a confirm URL", () => {
    const links = [L("https://click.mailer.example.net/ls/click?upn=https%3A%2F%2Fexample.com%2Fverify", "Verify email"), L("https://example.com/verify/t2", "Verify email")];
    expect(selectConfirmLink(links, site)).toEqual({ ok: true, url: "https://example.com/verify/t2" });
    expect(selectConfirmLink(links.slice(0, 1), site)).toEqual({ ok: false, reason: "none" });
  });

  it("unsubscribe and preference links are never candidates", () => {
    const links = [L("https://example.com/unsubscribe?confirm=1", "Unsubscribe"), L("https://example.com/email/preferences", "Confirm your preferences"), L("https://example.com/verify-email?t=3", "Verify")];
    expect(selectConfirmLink(links, site)).toEqual({ ok: true, url: "https://example.com/verify-email?t=3" });
    expect(selectConfirmLink([L("https://example.com/l/abc", "Unsubscribe from confirmation emails")], site)).toEqual({ ok: false, reason: "none" });
  });

  it("http, credentials in the URL, non-web schemes and junk are dropped", () => {
    for (const h of ["http://example.com/verify", "https://user:pw@example.com/verify", "javascript:alert(1)//example.com/verify", "mailto:verify@example.com", "not a url"]) {
      expect(selectConfirmLink([L(h, "Verify")], site)).toEqual({ ok: false, reason: "none" });
    }
  });

  it("multi-label public suffixes compare on the registrable domain", () => {
    expect(selectConfirmLink([L("https://id.shop.co.uk/confirm/1")], "shop.co.uk")).toEqual({ ok: true, url: "https://id.shop.co.uk/confirm/1" });
    expect(selectConfirmLink([L("https://other.co.uk/confirm/1")], "shop.co.uk")).toEqual({ ok: false, reason: "none" });
  });
});

describe("raw message (Gmail show-original)", () => {
  const html = `<html><body><a href="https://example.com/verify?t=q">Verify</a></body></html>`;
  const qp = `<a href=3D"https://example.com/confirm?a=3D1&amp;b=3D2">Confirm =\r\nemail</a>`;
  const raw = (body: string) =>
    [
      "From: Example <no-reply@example.com>",
      "Subject: Please confirm",
      "List-Unsubscribe: <https://example.com/unsub>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Plain https://example.com/plain-only",
      "--b1",
      'Content-Type: text/html; charset="UTF-8"',
      body,
      "--b1--",
      "",
    ].join("\r\n");

  it("multipart: links come from the html part (base64), not headers or the plain part", () => {
    const b64 = Buffer.from(html).toString("base64").replace(/(.{20})/g, "$1\r\n");
    const r = parseRawMessage(raw(`Content-Transfer-Encoding: base64\r\n\r\n${b64}`));
    expect(r).toEqual([L("https://example.com/verify?t=q", "Verify")]);
  });

  it("quoted-printable html part is decoded (soft breaks, =3D)", () => {
    expect(parseRawMessage(raw(`Content-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`))).toEqual([L("https://example.com/confirm?a=1&b=2", "Confirm email")]);
  });

  it("single-part text/plain message → bare URLs", () => {
    expect(parseRawMessage("Content-Type: text/plain\n\nGo to https://example.com/activate/x1 now")).toEqual([L("https://example.com/activate/x1")]);
  });

  it("nested multipart (mixed > alternative) is walked", () => {
    const inner = ['Content-Type: multipart/alternative; boundary="in"', "", "--in", "Content-Type: text/html", "", html, "--in--"].join("\n");
    const outer = ['Content-Type: multipart/mixed; boundary="out"', "", "--out", inner, "--out", "Content-Type: application/pdf", "", "JVBER", "--out--"].join("\n");
    expect(parseRawMessage(outer)).toEqual([L("https://example.com/verify?t=q", "Verify")]);
  });

  it("readOriginalPage: the raw text inside the raw_message_text block, unescaped", () => {
    const page = `<html><body><div>Original message</div><pre class="raw_message_text" id="raw_message_text">From: a@example.com\nContent-Type: text/html\n\n&lt;a href=&quot;https://example.com/verify&quot;&gt;Verify&lt;/a&gt;</pre></body></html>`;
    const r = readOriginalPage("https://mail.google.com/mail/u/0/?view=om&permmsgid=msg-f:1", page);
    expect(r).toEqual({ ok: true, raw: 'From: a@example.com\nContent-Type: text/html\n\n<a href="https://example.com/verify">Verify</a>' });
  });

  it("readOriginalPage: sign-in redirect → NOT_FOUND; other shapes → UNSUPPORTED", () => {
    expect(readOriginalPage("https://accounts.google.com/v3/signin/identifier", "<html></html>")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(readOriginalPage("https://mail.google.com/mail/u/0/#inbox", "<html>inbox app</html>")).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  });
});

describe("Gmail ids and URLs", () => {
  it("message id: the decimal id in the feed entry tag, nothing else", () => {
    expect(gmailMessageId("tag:gmail.google.com,2004:1800000000000000001")).toBe("1800000000000000001");
    expect(gmailMessageId("tag:gmail.google.com,2004:18000&view=x")).toBeNull();
    expect(gmailMessageId(undefined)).toBeNull();
  });

  it("original view URL, with the account key when known", () => {
    expect(originalUrl("1800000000000000001")).toBe("https://mail.google.com/mail/u/0/?view=om&permmsgid=msg-f%3A1800000000000000001");
    expect(originalUrl("1800000000000000001", "0a1b2c3d4e")).toBe("https://mail.google.com/mail/u/0/?ik=0a1b2c3d4e&view=om&permmsgid=msg-f%3A1800000000000000001");
  });

  it("findIk reads the account key from the Gmail page globals", () => {
    expect(findIk(`<script>var GLOBALS=[null,null,1,"x","y",[],null,"z",null,"0a1b2c3d4e",null];</script>`)).toBe("0a1b2c3d4e");
    expect(findIk(`<script>window.x = {"ik":"9f8e7d6c5b"}</script>`)).toBe("9f8e7d6c5b");
    expect(findIk("<html>nothing</html>")).toBeNull();
  });
});

describe("pollMessages", () => {
  const T = 10_000_000;
  const msg = (id: string, ago: number, from = "no-reply@example.com") => ({ id, date: T - ago, from, subject: "", text: "" });
  const clock = () => {
    let t = T;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("matching messages since `since`, from the sender domain, newest first, skipping seen ones", async () => {
    const c = clock();
    const r = await pollMessages(async () => [msg("a", 60_000), msg("b", 5_000), msg("c", 1_000, "x@other.net"), msg("d", 2_000), msg("old", 600_000)], { since: T - 120_000, from: "example.com", skip: new Set(["d"]), timeout: 5000, ...c });
    expect(r.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("re-polls until a message arrives; then TIMEOUT when none does", async () => {
    const c = clock();
    let n = 0;
    const read = async () => (++n >= 3 ? [msg("late", 0)] : []);
    expect((await pollMessages(read, { since: T - 1000, from: "example.com", skip: new Set(), timeout: 60_000, ...c })).map((m) => m.id)).toEqual(["late"]);
    await expect(pollMessages(async () => [], { since: T - 1000, from: "example.com", skip: new Set(), timeout: 6000, ...clock() })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("messages older than the max age or without an id are ignored", async () => {
    const c = clock();
    const r = pollMessages(async () => [msg("ancient", CONFIRM_MAX_AGE_MS + 1), { date: T, from: "a@example.com", subject: "", text: "" }], { since: 0, from: "example.com", skip: new Set(), timeout: 2000, ...c });
    await expect(r).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
