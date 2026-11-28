// #108: the extension side of outside approvals. The extension stays the single place that decides and
// applies answers: one state machine (first answer wins, late answers never execute), one set of strings
// shared by the panel, the prompt window and every mirrored channel.
import { describe, expect, it } from "vitest";
import { MirroredPromptSchema, PromptsSyncSchema } from "@tabagent/protocol";
import { PromptQueue, PROMPT_TIMEOUT_MS, type PromptRequest } from "../src/background/prompts";
import { migrateSettings, settingsAuditEvents, DEFAULTS } from "../src/background/settingsModel";
import { mirrorMessage, onBridgeAnswer } from "../src/pure/promptMirror";
import { alwaysLabel, offeredAnswers, promptDetail, promptView } from "../src/pure/promptView";
import { promptTitle } from "../src/ui/reducers";

function fakeTimers() {
  let now = 1_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const h = ++id;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    newId: () => `p${++id}`,
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...timers]) if (t.at <= now) {
        timers.delete(h);
        t.fn();
      }
    },
    /** Move the clock without firing timers (a timer that runs late). */
    skew(ms: number) {
      now += ms;
    },
  };
}

const site = (over: Partial<PromptRequest> = {}): PromptRequest => ({ kind: "site", sessionId: "s1", sessionLabel: "jarvis", origin: "https://a.example", level: "read", tool: "nav.goto", summary: "open https://a.example/", reasons: [], ...over });
const sensitive = (category: string, over: Partial<PromptRequest> = {}): PromptRequest =>
  ({ kind: "sensitive", sessionId: "s1", sessionLabel: "jarvis", origin: "https://a.example", sensitive: { category, description: `desc ${category}` }, tool: "act.click", summary: 'click "Pay"', reasons: ["looks like a purchase"], ...over }) as PromptRequest;

describe("first answer wins (PromptQueue.answerAs)", () => {
  it("the first answer applies; a second one, from any channel, is reported as already answered and changes nothing", async () => {
    const q = new PromptQueue(fakeTimers());
    const r = q.request(site());
    expect(q.answerAs(r.promptId, "deny", "phone")).toEqual({ ok: true, outcome: "applied" });
    expect(q.answerAs(r.promptId, "once", "panel")).toEqual({ ok: false, outcome: "already_answered", by: "phone" });
    expect(q.answerAs(r.promptId, "always", "cli-presence")).toEqual({ ok: false, outcome: "already_answered", by: "phone" });
    expect(await r.outcome).toBe("deny");
  });
  it("race: panel and phone answer in the same tick, exactly one applies", async () => {
    for (const [first, second] of [
      ["panel", "phone"],
      ["phone", "panel"],
    ] as const) {
      const q = new PromptQueue(fakeTimers());
      const r = q.request(site());
      const outcomes: string[] = [];
      q.on((e) => e.type === "removed" && outcomes.push(`${e.outcome}:${e.channel}`));
      const results = await Promise.all([Promise.resolve().then(() => q.answerAs(r.promptId, "once", first)), Promise.resolve().then(() => q.answerAs(r.promptId, "deny", second))]);
      expect(results.filter((x) => x.ok)).toHaveLength(1);
      expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, outcome: "already_answered", by: first }]);
      expect(outcomes).toEqual([`once:${first}`]);
      expect(await r.outcome).toBe("once");
    }
  });
  it("records the answering channel on the removed event (audit)", () => {
    const q = new PromptQueue(fakeTimers());
    const ev: unknown[] = [];
    q.on((e) => e.type === "removed" && ev.push([e.outcome, e.channel]));
    q.answerAs(q.request(site()).promptId, "once", "cli-presence");
    q.answerAs(q.request(site({ origin: "https://b.example" })).promptId, "deny", "panel");
    expect(ev).toEqual([
      ["once", "cli-presence"],
      ["deny", "panel"],
    ]);
  });
  it("a late answer after expiry never executes, even when the timeout timer has not fired yet", async () => {
    const t = fakeTimers();
    const q = new PromptQueue(t);
    const r = q.request(site());
    t.skew(PROMPT_TIMEOUT_MS); // the timer is late; the clock says expired
    expect(q.answerAs(r.promptId, "once", "phone")).toEqual({ ok: false, outcome: "expired" });
    expect(await r.outcome).toBe("timeout");
    expect(q.answerAs(r.promptId, "once", "panel")).toEqual({ ok: false, outcome: "expired" });
  });
  it("after the timeout fired, any answer is expired", () => {
    const t = fakeTimers();
    const q = new PromptQueue(t);
    const r = q.request(site());
    t.advance(PROMPT_TIMEOUT_MS);
    expect(q.answerAs(r.promptId, "deny", "cli-presence")).toEqual({ ok: false, outcome: "expired" });
  });
  it("unknown prompts are not_found; killed prompts are already answered", () => {
    const q = new PromptQueue(fakeTimers());
    expect(q.answerAs("nope", "once", "phone")).toEqual({ ok: false, outcome: "not_found" });
    const r = q.request(site());
    q.dropAll("killed");
    expect(q.answerAs(r.promptId, "once", "phone").outcome).toBe("already_answered");
  });
  it("an answer the prompt does not offer is refused and the prompt stays pending", () => {
    const q = new PromptQueue(fakeTimers());
    const r = q.request(sensitive("p", { tool: "policy.denylist_change", summary: "remove example.com from the denylist" }));
    expect(q.answerAs(r.promptId, "always", "phone")).toEqual({ ok: false, outcome: "not_offered" });
    expect(q.answerAs(r.promptId, "always", "panel")).toEqual({ ok: false, outcome: "not_offered" });
    expect(q.size).toBe(1);
    expect(q.answerAs(r.promptId, "once", "panel")).toEqual({ ok: true, outcome: "applied" });
  });
  it("answer() (the panel path) is answerAs(..., 'panel')", () => {
    const q = new PromptQueue(fakeTimers());
    const ev: unknown[] = [];
    q.on((e) => e.type === "removed" && ev.push(e.channel));
    const r = q.request(site());
    expect(q.answer(r.promptId, "once")).toBe(true);
    expect(q.answer(r.promptId, "once")).toBe(false);
    expect(ev).toEqual(["panel"]);
  });
  it("remembers settled prompts only for a bounded time and count", () => {
    const t = fakeTimers();
    const q = new PromptQueue(t);
    const r = q.request(site());
    q.answerAs(r.promptId, "once", "panel");
    t.advance(11 * 60_000);
    expect(q.answerAs(r.promptId, "once", "phone").outcome).toBe("not_found");
    for (let i = 0; i < 300; i++) q.answerAs(q.request(site({ origin: `https://x${i}.example` })).promptId, "deny", "panel");
    expect(q.settledCount).toBeLessThanOrEqual(200);
  });
});

describe("prompt text: one source for panel, prompt window, CLI and phone", () => {
  it("site prompts offer once/always/deny with the level in the always label", () => {
    const p = { promptId: "p1", kind: "site", sessionLabel: "jarvis", origin: "https://a.example", level: "act", tool: "act.click", summary: "click", reasons: [], expires: 5 };
    expect(offeredAnswers(p)).toEqual(["deny", "always", "once"]);
    expect(alwaysLabel(p)).toBe("Always allow act");
    expect(promptDetail(p)).toBe("It will be able to click, type and navigate on this site.");
  });
  it.each([
    ["p", "Policy change"],
    ["r", "Workflow repair"],
  ])("category %s is one-shot (no always) and its detail is the description only", (category) => {
    const p = { promptId: "p1", kind: "sensitive", sessionLabel: "j", origin: "https://a.example", sensitive: { category, description: "Change TabAgent policy" }, tool: "policy.site_change", summary: "x", reasons: [], expires: 5 };
    expect(offeredAnswers(p)).toEqual(["deny", "once"]);
    expect(alwaysLabel(p)).toBeUndefined();
  });
  it("attach and sign-up prompts are one-shot; sign-in offers 'Always for this account'", () => {
    const base = { promptId: "p1", sessionLabel: "j", origin: "https://a.example", tool: "t", summary: "s", reasons: [], expires: 5 };
    expect(offeredAnswers({ ...base, kind: "attach", sensitive: { category: "f", description: "Take over a tab you opened" } })).toEqual(["deny", "once"]);
    expect(offeredAnswers({ ...base, kind: "sensitive", sensitive: { category: "g", description: "d" }, auth: { accountId: "a", accountMasked: "n***@x.com", provider: "Bitwarden", signup: true } })).toEqual(["deny", "once"]);
    const signin = { ...base, kind: "sensitive", sensitive: { category: "g", description: "d" }, auth: { accountId: "a", accountMasked: "n***@x.com", provider: "Bitwarden" } };
    expect(offeredAnswers(signin)).toEqual(["deny", "always", "once"]);
    expect(alwaysLabel(signin)).toBe("Always for this account");
  });
  it("promptView carries exactly the panel's strings and validates against the wire schema", () => {
    const p = { promptId: "p9", kind: "sensitive", sessionLabel: "jarvis", origin: "https://shop.example", sensitive: { category: "b", description: "Click that looks like a purchase" }, tool: "act.click", summary: 'click "Pay now"', reasons: ["button text matches purchase"], expires: 123, created: 1 };
    const v = promptView(p);
    expect(v).toEqual({
      promptId: "p9",
      title: promptTitle(p),
      detail: "Click that looks like a purchase · on https://shop.example",
      summary: 'click "Pay now"',
      reasons: ["button text matches purchase"],
      tool: "act.click",
      sessionLabel: "jarvis",
      origin: "https://shop.example",
      expires: 123,
      answers: ["deny", "always", "once"],
      alwaysLabel: "Always allow on this site",
    });
    expect(MirroredPromptSchema.parse(v)).toEqual(v);
  });
});

describe("mirroring (prompts.sync)", () => {
  const p = { promptId: "p1", kind: "site", sessionLabel: "jarvis", origin: "https://a.example", level: "read", tool: "nav.goto", summary: "open", reasons: [], expires: 99 };
  it("sends the pending prompts when outside approvals are on", () => {
    const m = mirrorMessage(true, [p]);
    expect(PromptsSyncSchema.parse(m)).toEqual(m);
    expect(m).toEqual({ type: "prompts.sync", enabled: true, prompts: [promptView(p)] });
  });
  it("sends nothing about prompts when outside approvals are off", () => {
    expect(mirrorMessage(false, [p])).toEqual({ type: "prompts.sync", enabled: false, prompts: [] });
  });
});

describe("bridge answers (prompt.answer)", () => {
  const msg = (over: Record<string, unknown> = {}) => ({ type: "prompt.answer", id: "a1", promptId: "p1", answer: "once", channel: "phone", ...over });
  it("applies through the queue with the bridge's channel", () => {
    const calls: unknown[] = [];
    const r = onBridgeAnswer(msg(), true, (id, a, ch) => {
      calls.push([id, a, ch]);
      return { ok: true, outcome: "applied" };
    });
    expect(calls).toEqual([["p1", "once", "phone"]]);
    expect(r).toEqual({ type: "prompt.answer.result", id: "a1", ok: true, outcome: "applied" });
  });
  it("refuses everything while outside approvals are off", () => {
    let called = false;
    const r = onBridgeAnswer(msg(), false, () => {
      called = true;
      return { ok: true, outcome: "applied" };
    });
    expect(called).toBe(false);
    expect(r).toEqual({ type: "prompt.answer.result", id: "a1", ok: false, outcome: "disabled" });
  });
  it("the bridge can never claim to be the panel; malformed messages are dropped", () => {
    const never = () => {
      throw new Error("must not be called");
    };
    expect(onBridgeAnswer(msg({ channel: "panel" }), true, never)).toEqual({ type: "prompt.answer.result", id: "a1", ok: false, outcome: "not_found" });
    expect(onBridgeAnswer(msg({ answer: "yes" }), true, never)).toEqual({ type: "prompt.answer.result", id: "a1", ok: false, outcome: "not_found" });
    expect(onBridgeAnswer({ type: "prompt.answer" }, true, never)).toBeNull();
  });
  it("passes through already_answered with the winning channel", () => {
    expect(onBridgeAnswer(msg(), true, () => ({ ok: false, outcome: "already_answered", by: "panel" }))).toEqual({ type: "prompt.answer.result", id: "a1", ok: false, outcome: "already_answered", by: "panel" });
  });
});

describe("outsideApprovals setting", () => {
  it("is off by default and only true when stored as true", () => {
    expect(DEFAULTS.outsideApprovals).toBe(false);
    expect(migrateSettings({}).outsideApprovals).toBe(false);
    expect(migrateSettings({ outsideApprovals: "yes" } as any).outsideApprovals).toBe(false);
    expect(migrateSettings({ outsideApprovals: true } as any).outsideApprovals).toBe(true);
  });
  it("turning it on or off is audited", () => {
    const d = migrateSettings({});
    expect(settingsAuditEvents(d, { ...d, outsideApprovals: true })).toEqual([{ event: "settings.changed", data: { outsideApprovals: true } }]);
  });
});
