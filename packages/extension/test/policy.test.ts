import { describe, expect, it } from "vitest";
import { applySensitiveAnswer, applySiteAnswer, clearSessionGrants, effectiveLevel, hostMatches, isHardDenied, resolve, type Level, type PolicyRequest, type PolicyState, type StoredPolicy } from "../src/background/policy";

const A = "https://a.example";
const base = (over: Partial<PolicyState> = {}): PolicyState => ({ paused: false, sites: {}, denylist: ["*.bank.example"], grants: {}, ...over });
const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({ sessionId: "s1", cap: "full", sites: [], url: `${A}/page`, level: "read", ...over });

describe("resolve: stored level x required level", () => {
  const stored: (StoredPolicy | undefined)[] = [undefined, "deny", "read", "act", "full"];
  const required: Level[] = ["read", "act", "full"];
  const rank = { deny: 0, read: 1, act: 2, full: 3 } as const;
  for (const s of stored) {
    for (const r of required) {
      it(`stored ${s ?? "(none)"} / required ${r}`, () => {
        const st = base({ sites: s ? { [A]: { policy: s } } : {} });
        const d = resolve(st, req({ level: r }));
        if (s === undefined) expect(d).toMatchObject({ decision: "ask", kind: "site", origin: A, level: r });
        else if (s === "deny") expect(d).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED" });
        else if (rank[s] >= rank[r]) expect(d.decision).toBe("allow");
        else expect(d).toMatchObject({ decision: "ask", kind: "site", level: r, reason: expect.stringContaining(`"${s}"`) });
      });
    }
  }
  it("unknown origin asks", () => {
    expect(resolve(base(), req()).decision).toBe("ask");
  });
});

describe("resolve: evaluation order (D16)", () => {
  it("paused beats everything, including allow", () => {
    const d = resolve(base({ paused: true, sites: { [A]: { policy: "full" } } }), req());
    expect(d).toMatchObject({ decision: "deny", code: "KILLED" });
  });
  it("paused beats a not-site-scoped call too", () => {
    expect(resolve(base({ paused: true }), req({ url: "", level: null }))).toMatchObject({ code: "KILLED" });
  });
  it("denylist beats an Always", () => {
    const u = "https://my.bank.example/login";
    const d = resolve(base({ sites: { "https://my.bank.example": { policy: "full" } } }), req({ url: u }));
    expect(d).toMatchObject({ decision: "deny", message: expect.stringContaining("denylist") });
  });
  it("token cap read beats site policy act", () => {
    const d = resolve(base({ sites: { [A]: { policy: "act" } } }), req({ cap: "read", level: "act" }));
    expect(d).toMatchObject({ decision: "deny", message: expect.stringContaining('limited to "read"') });
  });
  it("token --sites miss denies without a prompt", () => {
    const d = resolve(base(), req({ sites: ["*.other.example"] }));
    expect(d).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED", message: expect.stringContaining("not allowed on a.example") });
  });
  it("token --sites hit continues to site policy", () => {
    expect(resolve(base(), req({ sites: ["a.example"] })).decision).toBe("ask");
  });
  it("site policy is checked before the sensitive gate", () => {
    expect(resolve(base(), req({ sensitive: "c" }))).toMatchObject({ decision: "ask", kind: "site" });
    expect(resolve(base({ sites: { [A]: { policy: "full" } } }), req({ sensitive: "c" }))).toMatchObject({ decision: "ask", kind: "sensitive", category: "c" });
  });
});

describe("hard deny", () => {
  for (const u of ["chrome://settings", "chrome-extension://abc/page.html", "devtools://devtools/x", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x", "view-source:https://a.example"]) {
    it(`${u} is denied and cannot be unlocked`, () => {
      const o = (() => {
        try {
          return new URL(u).origin;
        } catch {
          return u;
        }
      })();
      const st = base({ denylist: [], sites: { [o]: { policy: "full" } } });
      expect(isHardDenied(u)).toBe(true);
      expect(resolve(st, req({ url: u }))).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED" });
    });
  }
  it("about:blank is allowed and not hard denied", () => {
    expect(isHardDenied("about:blank")).toBe(false);
    expect(resolve(base(), req({ url: "about:blank" })).decision).toBe("allow");
  });
  it("unsupported schemes are denied", () => {
    expect(resolve(base(), req({ url: "ftp://x.example/" }))).toMatchObject({ decision: "deny" });
  });
});

describe("hostMatches", () => {
  it.each([
    ["*.github.com", "github.com", true],
    ["*.github.com", "gist.github.com", true],
    ["*.github.com", "github.com.evil.example", false],
    ["*.github.com", "evilgithub.com", false],
    ["github.com", "github.com", true],
    ["github.com", "gist.github.com", false],
    ["*", "anything.example", true],
    ["", "a", false],
  ])("%s vs %s -> %s", (g, h, want) => expect(hostMatches(g, h)).toBe(want));
});

describe("answers", () => {
  it("once = same session + origin only; covers lower levels", () => {
    const st = applySiteAnswer(base(), "s1", A, "act", "once");
    expect(resolve(st, req({ level: "act" })).decision).toBe("allow");
    expect(resolve(st, req({ level: "read" })).decision).toBe("allow");
    expect(resolve(st, req({ sessionId: "s2", level: "read" })).decision).toBe("ask");
    expect(resolve(st, req({ url: "https://b.example/", level: "read" })).decision).toBe("ask");
  });
  it("a higher request asks again", () => {
    const st = applySiteAnswer(base(), "s1", A, "read", "once");
    expect(resolve(st, req({ level: "act" }))).toMatchObject({ decision: "ask", level: "act" });
  });
  it("once does not downgrade an earlier higher once", () => {
    let st = applySiteAnswer(base(), "s1", A, "full", "once");
    st = applySiteAnswer(st, "s1", A, "read", "once");
    expect(resolve(st, req({ level: "full" })).decision).toBe("allow");
  });
  it("once is gone at session end and after kill", () => {
    const st = applySiteAnswer(base(), "s1", A, "act", "once");
    expect(resolve(clearSessionGrants(st, "s1"), req()).decision).toBe("ask");
    expect(resolve(clearSessionGrants(st), req()).decision).toBe("ask");
    const two = applySiteAnswer(st, "s2", A, "act", "once");
    expect(resolve(clearSessionGrants(two, "s1"), req({ sessionId: "s2" })).decision).toBe("allow");
  });
  it("always stores exactly the requested level", () => {
    const st = applySiteAnswer(base(), "s1", A, "act", "always");
    expect(st.sites[A].policy).toBe("act");
    expect(resolve(st, req({ sessionId: "other", level: "act" })).decision).toBe("allow");
    expect(resolve(st, req({ level: "full" })).decision).toBe("ask");
  });
  it("deny sticks for the session at and above the denied level", () => {
    const st = applySiteAnswer(base(), "s1", A, "act", "deny");
    expect(resolve(st, req({ level: "act" }))).toMatchObject({ decision: "deny" });
    expect(resolve(st, req({ level: "full" }))).toMatchObject({ decision: "deny" });
    expect(resolve(st, req({ level: "read" })).decision).toBe("ask");
    expect(resolve(st, req({ sessionId: "s2", level: "act" })).decision).toBe("ask");
    const lower = applySiteAnswer(st, "s1", A, "read", "deny");
    expect(resolve(lower, req({ level: "read" })).decision).toBe("deny");
  });
});

describe("frames and navigation", () => {
  it("cross-origin frame uses the frame's own origin", () => {
    const st = base({ sites: { [A]: { policy: "full" }, "https://frame.example": { policy: "deny" } } });
    expect(resolve(st, req({ url: "https://frame.example/embed" })).decision).toBe("deny");
  });
  it("a tab that navigated to a denied origin is denied on the next command", () => {
    const st = base({ sites: { [A]: { policy: "full" } } });
    expect(resolve(st, req({ url: `${A}/x` })).decision).toBe("allow");
    expect(resolve(st, req({ url: "https://x.bank.example/" })).decision).toBe("deny");
  });
});

describe("sensitive gate (D18)", () => {
  const full = (over: Partial<PolicyState> = {}) => base({ sites: { [A]: { policy: "full" } }, ...over });
  for (const c of ["a", "b", "c", "d", "e"] as const) {
    it(`category ${c} asks, and pre-approval on the origin passes`, () => {
      expect(resolve(full(), req({ sensitive: c }))).toMatchObject({ decision: "ask", kind: "sensitive", category: c });
      const st = applySensitiveAnswer(full(), A, c, "always");
      expect(resolve(st, req({ sensitive: c })).decision).toBe("allow");
    });
  }
  it("pre-approval for a on X does not cover c on X nor a on Y", () => {
    const st = applySensitiveAnswer(base({ sites: { [A]: { policy: "full" }, "https://y.example": { policy: "full" } } }), A, "a", "always");
    expect(resolve(st, req({ sensitive: "c" })).decision).toBe("ask");
    expect(resolve(st, req({ url: "https://y.example/", sensitive: "a" })).decision).toBe("ask");
  });
  it("tabs attach (f) can't be pre-approved and devAllowSensitive does not skip it", () => {
    const st = applySensitiveAnswer(full({ devAllowSensitive: true }), A, "f", "always");
    expect(st.sites[A].preapproved).toBeUndefined();
    expect(resolve(st, req({ sensitive: "f" }))).toMatchObject({ decision: "ask", category: "f" });
  });
  it("devAllowSensitive passes a-e without prompting", () => {
    for (const c of ["a", "b", "c", "d", "e"] as const) expect(resolve(full({ devAllowSensitive: true }), req({ sensitive: c })).decision).toBe("allow");
  });
  it("denylist policy changes always ask: neither YOLO, developer mode nor Always persists an approval", () => {
    const on = full({ devAllowSensitive: true, yolo: true });
    expect(resolve(on, req({ url: "", level: "full", sensitive: "p" }))).toMatchObject({ decision: "ask", kind: "sensitive", category: "p" });
    expect(applySensitiveAnswer(on, A, "p", "always")).toBe(on);
  });
  it("once / deny on a sensitive prompt change nothing", () => {
    const st = full();
    expect(applySensitiveAnswer(st, A, "c", "once")).toBe(st);
    expect(applySensitiveAnswer(st, A, "c", "deny")).toBe(st);
  });
  it("blank page sensitive asks keyed to about:blank", () => {
    expect(resolve(base(), req({ url: "about:blank", level: null, sensitive: "c" }))).toMatchObject({ decision: "ask", origin: "about:blank" });
  });
});

describe("auth category g (M6)", () => {
  const on = (extra = {}) => base({ sites: { [A]: { policy: "full", auth: true, ...extra } } });
  it("is denied unless sign-in is enabled for the origin", () => {
    expect(resolve(base({ sites: { [A]: { policy: "full" } } }), req({ sensitive: "g", accountId: "x" }))).toMatchObject({ decision: "deny", message: expect.stringContaining("not enabled") });
  });
  it("asks when enabled, and Always remembers that account only", () => {
    expect(resolve(on(), req({ sensitive: "g", accountId: "acct1" }))).toMatchObject({ decision: "ask", category: "g" });
    const st = applySensitiveAnswer(on(), A, "g", "always", "acct1");
    expect(st.sites[A].authAlways).toEqual(["acct1"]);
    expect(resolve(st, req({ sensitive: "g", accountId: "acct1" })).decision).toBe("allow");
    expect(resolve(st, req({ sensitive: "g", accountId: "acct2" })).decision).toBe("ask");
    expect(applySensitiveAnswer(st, A, "g", "always", "acct1")).toBe(st);
    expect(applySensitiveAnswer(st, A, "g", "always")).toBe(st);
  });
  it("pre-approving a does not cover g, devAllowSensitive does not skip it", () => {
    const st = applySensitiveAnswer(on(), A, "a", "always");
    expect(resolve({ ...st, devAllowSensitive: true }, req({ sensitive: "g", accountId: "x" })).decision).toBe("ask");
  });
  it("banking sign-in (#100): asks once removed from the denylist and enabled; refused otherwise", () => {
    const o = "https://app.mercury.com";
    const on = base({ denylist: [], sites: { [o]: { policy: "full", auth: true } } });
    expect(resolve(on, req({ url: `${o}/login`, sensitive: "g", accountId: "x" })).decision).toBe("ask");
    const listed = base({ denylist: ["*.mercury.com"], sites: { [o]: { policy: "full", auth: true } } });
    expect(resolve(listed, req({ url: `${o}/login`, sensitive: "g", accountId: "x" })).decision).toBe("deny");
    const off = base({ denylist: [], sites: { [o]: { policy: "full" } } });
    expect(resolve(off, req({ url: `${o}/login`, sensitive: "g", accountId: "x" }))).toMatchObject({ decision: "deny", message: expect.stringContaining("not enabled") });
  });
  it("password-manager hosts stay denied for auth even when enabled and removed from the denylist", () => {
    const o = "https://my.1password.com";
    const st = base({ denylist: [], sites: { [o]: { policy: "full", auth: true } } });
    expect(resolve(st, req({ url: `${o}/signin`, sensitive: "g", accountId: "x" }))).toMatchObject({ decision: "deny" });
  });
  it("Google sign-in (#81): allowed once not denylisted, enabled and policy act; refused otherwise", () => {
    const o = "https://accounts.google.com";
    const on = base({ denylist: [], sites: { [o]: { policy: "act", auth: true } } });
    expect(resolve(on, req({ url: `${o}/v3/signin/identifier`, sensitive: "g", accountId: "x" })).decision).toBe("ask");
    const listed = base({ denylist: ["accounts.google.com"], sites: { [o]: { policy: "act", auth: true } } });
    expect(resolve(listed, req({ url: `${o}/v3/signin/identifier`, sensitive: "g", accountId: "x" })).decision).toBe("deny");
    const off = base({ denylist: [], sites: { [o]: { policy: "act" } } });
    expect(resolve(off, req({ url: `${o}/v3/signin/identifier`, sensitive: "g", accountId: "x" }))).toMatchObject({ decision: "deny", message: expect.stringContaining("not enabled") });
  });
  it("Google account pages stay never-reachable after the change (D4)", () => {
    const st = base({ denylist: [], yolo: true, sites: { "https://myaccount.google.com": { policy: "full", auth: true } } });
    expect(resolve(st, req({ url: "https://myaccount.google.com/security" })).decision).toBe("deny");
  });
  it("needs an http(s) page", () => {
    expect(resolve(base(), req({ url: "about:blank", level: null, sensitive: "g" }))).toMatchObject({ decision: "deny" });
  });
});

describe("effectiveLevel (session.permissions)", () => {
  it("reports stored, once, denylist, token cap", () => {
    expect(effectiveLevel(base(), { sessionId: "s1", cap: "full", sites: [], url: `${A}/` })).toMatchObject({ level: "ask" });
    expect(effectiveLevel(base({ sites: { [A]: { policy: "full" } } }), { sessionId: "s1", cap: "read", sites: [], url: `${A}/` })).toMatchObject({ level: "read", source: expect.stringContaining("token cap") });
    const once = applySiteAnswer(base(), "s1", A, "act", "once");
    expect(effectiveLevel(once, { sessionId: "s1", cap: "full", sites: [], url: `${A}/` })).toMatchObject({ level: "act", source: expect.stringContaining("once") });
    expect(effectiveLevel(base(), { sessionId: "s1", cap: "full", sites: [], url: "https://x.bank.example/" })).toMatchObject({ level: "deny" });
    expect(effectiveLevel(base(), { sessionId: "s1", cap: "full", sites: ["b.example"], url: `${A}/` })).toMatchObject({ level: "deny" });
    expect(effectiveLevel(base(), { sessionId: "s1", cap: "act", sites: [], url: "about:blank" })).toMatchObject({ level: "act" });
    expect(effectiveLevel(base(), { sessionId: "s1", cap: "act", sites: [], url: "chrome://x" })).toMatchObject({ level: "deny" });
  });
});

describe("YOLO mode (allow every site without asking)", () => {
  const y = (over: Partial<PolicyState> = {}) => base({ yolo: true, ...over });
  it("allows any level on an unknown site", () => {
    for (const level of ["read", "act", "full"] as const) expect(resolve(y(), req({ level })).decision).toBe("allow");
  });
  it("allows above a lower stored level", () => {
    expect(resolve(y({ sites: { [A]: { policy: "read" } } }), req({ level: "full" })).decision).toBe("allow");
  });
  it("passes sensitive a-e", () => {
    for (const c of ["a", "b", "c", "d", "e"] as const) expect(resolve(y(), req({ sensitive: c })).decision).toBe("allow");
  });
  it("still asks for f (take over a user tab) and g (sign in)", () => {
    expect(resolve(y(), req({ sensitive: "f" })).decision).toBe("ask");
    expect(resolve(y({ sites: { [A]: { auth: true } } }), req({ sensitive: "g", accountId: "x" })).decision).toBe("ask");
  });
  it("keeps the kill switch, hard denies, denylist, explicit site deny, session deny and token limits", () => {
    expect(resolve(y({ paused: true }), req())).toMatchObject({ code: "KILLED" });
    expect(resolve(y(), req({ url: "chrome://settings" })).decision).toBe("deny");
    expect(resolve(y(), req({ url: "https://my.bank.example/" })).decision).toBe("deny");
    expect(resolve(y({ sites: { [A]: { policy: "deny" } } }), req()).decision).toBe("deny");
    expect(resolve(y({ grants: { s1: { [A]: { denied: "act" } } } }), req({ level: "act" })).decision).toBe("deny");
    expect(resolve(y(), req({ cap: "read", level: "act" })).decision).toBe("deny");
    expect(resolve(y(), req({ sites: ["b.example"] })).decision).toBe("deny");
  });
  it("DA12 (review M3): Google password/account/mail surfaces and vault apps are denied even with an empty denylist, under YOLO and site allow", () => {
    for (const url of ["https://passwords.google.com/", "https://myaccount.google.com/security", "https://mail.google.com/mail/u/0/", "https://vault.bitwarden.eu/", "https://my.1password.eu/", "https://my.1password.ca/"]) {
      const origin = new URL(url).origin;
      const st = y({ denylist: [], sites: { [origin]: { policy: "full", preapproved: { c: true, d: true } } } });
      expect(resolve(st, req({ url, level: "read" })), url).toMatchObject({ decision: "deny", code: "PERMISSION_DENIED" });
      expect(resolve(st, req({ url, level: null })).decision, url).toBe("deny");
      expect(effectiveLevel(st, { sessionId: "s1", cap: "full", sites: [], url }).level, url).toBe("deny");
    }
    expect(resolve(y({ denylist: [] }), req({ url: "https://docs.google.com/" })).decision).toBe("allow");
  });
  it("effectiveLevel reports the token cap with source yolo", () => {
    expect(effectiveLevel(y(), { sessionId: "s1", cap: "act", sites: [], url: `${A}/` })).toMatchObject({ level: "act", source: expect.stringContaining("YOLO") });
    expect(effectiveLevel(y({ sites: { [A]: { policy: "deny" } } }), { sessionId: "s1", cap: "full", sites: [], url: `${A}/` })).toMatchObject({ level: "deny" });
  });
});
