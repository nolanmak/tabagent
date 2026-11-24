// DA1 made structural (security review H1): after TabAgent types a credential into a tab,
// nothing on that tab can read it back, and no result anywhere may carry it.
import { describe, expect, it } from "vitest";
import { AuthTaint, credentialGuard, TAINT_MS } from "../src/background/authTaint";

function clock(t = 1_000_000) {
  const c = { t, now: () => c.t, tick: (ms: number) => (c.t += ms) };
  return c;
}

describe("auth taint per tab", () => {
  it("a fill taints that tab only", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    expect(a.tainted(1)).toBe(false);
    a.filled(1, "password", "hunter2!");
    expect(a.tainted(1)).toBe(true);
    expect(a.tainted(2)).toBe(false);
  });

  it("stays tainted while the filled document is still loaded, however long (submit:false keeps the password in the field)", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    a.filled(1, "password", "hunter2!");
    c.tick(TAINT_MS * 10);
    expect(a.tainted(1)).toBe(true);
  });

  it("ends only once the tab has navigated to a new document AND the window (bfcache lifetime) has passed", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    a.filled(1, "password", "hunter2!");
    c.tick(1000);
    a.navigated(1);
    expect(a.tainted(1)).toBe(true); // back/forward cache could restore the filled page
    c.tick(TAINT_MS);
    expect(a.tainted(1)).toBe(false);
  });

  it("a second fill re-opens the taint and needs a fresh navigation", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    a.filled(1, "password", "pw-one-1");
    a.navigated(1);
    c.tick(TAINT_MS + 1);
    expect(a.tainted(1)).toBe(false);
    a.filled(1, "code", "123456");
    c.tick(TAINT_MS + 1);
    expect(a.tainted(1)).toBe(true);
  });

  it("network requests started while the tab was tainted stay unreadable after the taint ends; earlier and later ones are fine", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    const before = c.t - 5;
    a.filled(1, "password", "hunter2!");
    const loginPost = c.t + 10;
    c.tick(50);
    a.navigated(1);
    c.tick(TAINT_MS + 1);
    const later = c.t + 1;
    expect(a.tainted(1)).toBe(false);
    expect(a.requestBlocked(1, before)).toBe(false);
    expect(a.requestBlocked(1, loginPost)).toBe(true);
    expect(a.requestBlocked(1, later)).toBe(false);
    expect(a.requestBlocked(2, loginPost)).toBe(false);
  });

  it("closing the tab forgets it", () => {
    const a = new AuthTaint(clock().now);
    a.filled(1, "password", "hunter2!");
    a.closed(1);
    expect(a.tainted(1)).toBe(false);
  });

  it("agent JavaScript marks the document dirty until a real navigation (a bfcache restore brings the same document back)", () => {
    const a = new AuthTaint(clock().now);
    expect(a.scriptDirty(1)).toBe(false);
    a.ranScript(1);
    expect(a.scriptDirty(1)).toBe(true);
    a.navigated(1, { bfcache: true });
    expect(a.scriptDirty(1)).toBe(true);
    a.navigated(1);
    expect(a.scriptDirty(1)).toBe(false);
  });
});

describe("secret screen", () => {
  it("withholds raw, URL-encoded, form-encoded, JSON-escaped and HTML-escaped copies of a password", () => {
    const a = new AuthTaint(clock().now);
    const pw = 'p@ss w"rd&<1>';
    a.filled(1, "password", pw);
    expect(a.leaks(`xx${pw}yy`)).toBe(true);
    expect(a.leaks(JSON.stringify({ postData: `login=n&password=${encodeURIComponent(pw)}` }))).toBe(true);
    expect(a.leaks(`password=${encodeURIComponent(pw).replace(/%20/g, "+")}`)).toBe(true);
    expect(a.leaks(JSON.stringify({ value: pw }))).toBe(true);
    expect(a.leaks("p@ss w&quot;rd&amp;&lt;1&gt;")).toBe(true);
    expect(a.leaks("nothing here")).toBe(false);
  });

  it("usernames and autofill fills taint the tab but are not screened (they appear on every signed-in page)", () => {
    const a = new AuthTaint(clock().now);
    a.filled(1, "username", "nolan@example.com");
    a.filled(1, "autofill");
    expect(a.tainted(1)).toBe(true);
    expect(a.leaks("Welcome nolan@example.com")).toBe(false);
  });

  it("codes match as whole tokens only", () => {
    const a = new AuthTaint(clock().now);
    a.filled(1, "code", "123456");
    expect(a.leaks('{"url":"https://x.example/verify?code=123456"}')).toBe(true);
    expect(a.leaks('{"id":91234567}')).toBe(false);
  });

  it("screening ends after the window; very short values are never screened", () => {
    const c = clock();
    const a = new AuthTaint(c.now);
    a.filled(1, "password", "abc");
    expect(a.leaks("abc")).toBe(false);
    a.filled(1, "password", "longer-secret");
    c.tick(TAINT_MS + 1);
    expect(a.leaks("longer-secret")).toBe(false);
  });
});

describe("credentialGuard", () => {
  it("refuses every c/d tool on a tainted tab, whatever the policy says", () => {
    const a = new AuthTaint(clock().now);
    a.filled(7, "password", "hunter2!");
    for (const [tool, sensitive] of [
      ["js.eval", "c"],
      ["nav.wait", "c"],
      ["network.get", "d"],
      ["storage.get", "d"],
      ["cookies.get", "d"],
    ] as const) {
      expect(() => credentialGuard(a, { tool, sensitive, tabId: 7 }), tool).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    }
  });

  it("lets everything else through, and c/d on other tabs", () => {
    const a = new AuthTaint(clock().now);
    a.filled(7, "password", "hunter2!");
    expect(() => credentialGuard(a, { tool: "page.snapshot", tabId: 7 })).not.toThrow();
    expect(() => credentialGuard(a, { tool: "act.upload", sensitive: "e", tabId: 7 })).not.toThrow();
    expect(() => credentialGuard(a, { tool: "js.eval", sensitive: "c", tabId: 8 })).not.toThrow();
    expect(() => credentialGuard(a, { tool: "downloads.read", sensitive: "e" })).not.toThrow();
  });
});
