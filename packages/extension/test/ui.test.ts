import { describe, expect, it } from "vitest";
import { BADGE, badgeState, type BadgeInput } from "../src/background/badge";
import { buildAudit, MASK } from "../src/background/audit";
import { FEED_MAX, feedReducer, promptReducer, promptTitle, summarizeParams, type FeedEntry } from "../src/ui/reducers";

const entry = (id: number, over: Partial<FeedEntry> = {}): FeedEntry => ({ id, ts: id, sessionId: "s", label: "a", tool: "t", origin: null, params: {}, status: "ok", ...over });

describe("feed reducer", () => {
  it("appends, replaces by id, caps at 200", () => {
    let f: FeedEntry[] = [];
    for (let i = 1; i <= FEED_MAX + 5; i++) f = feedReducer(f, entry(i, { status: "running" }));
    expect(f).toHaveLength(FEED_MAX);
    expect(f[0].id).toBe(6);
    f = feedReducer(f, entry(FEED_MAX + 5, { status: "ok" }));
    expect(f).toHaveLength(FEED_MAX);
    expect(f[f.length - 1].status).toBe("ok");
  });
  it("property: entries built from audit records never contain an unmasked sensitive value", async () => {
    const secrets = ["hunter2-pw", "4242424242424242", "123-45-6789", "tok_abcdef"];
    const shapes = (v: string) => [{ password: v }, { fields: { "Card number": v } }, { token: v }, { fields: { e3: v } }, { text: v }];
    let f: FeedEntry[] = [];
    let id = 0;
    for (const s of secrets) {
      for (const params of shapes(s)) {
        const a = await buildAudit({ tool: "act.type", origin: "https://a", params, outcome: "ok", redact: { sensitivePaths: ["fields.e3", "text"] } });
        f = feedReducer(f, entry(++id, { params: a.params }));
      }
    }
    const text = JSON.stringify(f);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).toContain(MASK);
  });
});

describe("prompt reducer", () => {
  it("FIFO, dedupes, removes on answer or timeout, replace", () => {
    let l = promptReducer([], { type: "added", prompt: { promptId: "1" } });
    l = promptReducer(l, { type: "added", prompt: { promptId: "2" } });
    l = promptReducer(l, { type: "added", prompt: { promptId: "1" } });
    expect(l.map((p) => p.promptId)).toEqual(["1", "2"]);
    l = promptReducer(l, { type: "removed", promptId: "1" });
    expect(l.map((p) => p.promptId)).toEqual(["2"]);
    expect(promptReducer(l, { type: "replace", prompts: [] })).toEqual([]);
  });
  it("titles", () => {
    expect(promptTitle({ kind: "site", sessionLabel: "bot", level: "read", origin: "https://a" })).toBe("bot wants to read https://a");
    expect(promptTitle({ kind: "site", label: "bot", level: "act", origin: "https://a" })).toBe("bot wants to act on https://a");
    expect(promptTitle({ kind: "site", level: "full", origin: "https://a" })).toBe("An agent wants full access to https://a");
    expect(promptTitle({ kind: "sensitive", sessionLabel: "bot", origin: "https://a", summary: 'click "Pay"' })).toBe('bot wants to click "Pay"');
    const signup = "Create an account on a.example as n•••@x.com and save it to Bitwarden?";
    expect(promptTitle({ kind: "sensitive", origin: "https://a.example", summary: signup, sensitive: { category: "g" }, auth: { accountMasked: "n•••@x.com", provider: "bitwarden", signup: true } })).toBe(signup);
    expect(promptTitle({ kind: "sensitive", origin: "https://a" })).toContain("sensitive");
    expect(promptTitle({ kind: "sensitive", origin: "https://a", sensitive: { category: "g" }, auth: { accountMasked: "n•••@x.com", provider: "1Password" } })).toBe("Sign in to https://a as n•••@x.com with 1Password?");
  });
  it("summarizeParams", () => {
    expect(summarizeParams({ a: "x", b: { c: 1 }, d: undefined, long: "y".repeat(100) }, 10)).toBe('a=x b={"c":1} long=yyyyyyyyy…');
    expect(summarizeParams(null)).toBe("");
  });
});

describe("badge state machine (D40)", () => {
  const s = (o: Partial<BadgeInput>): BadgeInput => ({ connected: true, paused: false, pendingPrompts: 0, inflight: 0, ...o });
  it.each([
    ["off when the bridge is not connected", s({ connected: false }), "off"],
    ["connected when idle", s({}), "connected"],
    ["acting while a command is in flight", s({ inflight: 2 }), "acting"],
    ["needs approval beats acting", s({ inflight: 1, pendingPrompts: 1 }), "approval"],
    ["needs approval even when disconnected", s({ connected: false, pendingPrompts: 1 }), "approval"],
    ["paused beats everything", s({ paused: true, pendingPrompts: 3, inflight: 3 }), "paused"],
    ["off beats acting", s({ connected: false, inflight: 1 }), "off"],
    ["YOLO shows while idle (review M1)", s({ yolo: true }), "yolo"],
    ["YOLO shows while acting", s({ yolo: true, inflight: 2 }), "yolo"],
    ["needs approval beats YOLO", s({ yolo: true, pendingPrompts: 1 }), "approval"],
    ["paused beats YOLO", s({ yolo: true, paused: true }), "paused"],
    ["off beats YOLO (nothing can act)", s({ yolo: true, connected: false }), "off"],
  ])("%s", (_n, input, want) => expect(badgeState(input)).toBe(want));
  it("transitions: off -> connected -> acting -> approval -> acting -> paused -> connected", () => {
    const seq = [s({ connected: false }), s({}), s({ inflight: 1 }), s({ inflight: 1, pendingPrompts: 1 }), s({ inflight: 1 }), s({ paused: true }), s({})].map(badgeState);
    expect(seq).toEqual(["off", "connected", "acting", "approval", "acting", "paused", "connected"]);
  });
  it("approval shows ! and paused shows the pause glyph", () => {
    expect(BADGE.approval.text).toBe("!");
    expect(BADGE.paused.text).toBe("⏸");
    expect(new Set(Object.values(BADGE).map((b) => b.color)).size).toBe(6);
    expect(BADGE.yolo.text).toBe("YOLO");
    expect(BADGE.yolo.title).toMatch(/YOLO/);
  });
});
