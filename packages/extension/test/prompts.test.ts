import { describe, expect, it } from "vitest";
import { PromptQueue, PROMPT_TIMEOUT_MS, type PromptRequest } from "../src/background/prompts";

function fakeTimers() {
  let now = 0;
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
    pending: () => timers.size,
  };
}

const site = (over: Partial<PromptRequest> = {}): PromptRequest => ({ kind: "site", sessionId: "s1", sessionLabel: "agent", origin: "https://a.example", level: "read", tool: "nav.goto", summary: "open", reasons: [], ...over });

describe("PromptQueue", () => {
  it("identical pending requests share one prompt", async () => {
    const q = new PromptQueue(fakeTimers());
    const a = q.request(site());
    const b = q.request(site({ summary: "different summary is ignored for site prompts" }));
    expect(b.shared).toBe(true);
    expect(b.promptId).toBe(a.promptId);
    expect(q.list()).toHaveLength(1);
    q.answer(a.promptId, "once");
    expect(await a.outcome).toBe("once");
    expect(await b.outcome).toBe("once");
  });
  it("different level / origin / session are separate prompts, FIFO", () => {
    const q = new PromptQueue(fakeTimers());
    q.request(site());
    q.request(site({ level: "act" }));
    q.request(site({ origin: "https://b.example" }));
    q.request(site({ sessionId: "s2" }));
    expect(q.list().map((p) => [p.sessionId, p.origin, p.level])).toEqual([
      ["s1", "https://a.example", "read"],
      ["s1", "https://a.example", "act"],
      ["s1", "https://b.example", "read"],
      ["s2", "https://a.example", "read"],
    ]);
  });
  it("no answer in 120s -> timeout; a late answer does nothing", async () => {
    const t = fakeTimers();
    const q = new PromptQueue(t);
    const r = q.request(site());
    expect(q.get(r.promptId)?.expires).toBe(PROMPT_TIMEOUT_MS);
    t.advance(PROMPT_TIMEOUT_MS - 1);
    expect(q.size).toBe(1);
    t.advance(1);
    expect(await r.outcome).toBe("timeout");
    expect(q.answer(r.promptId, "always")).toBe(false);
    expect(q.size).toBe(0);
  });
  it("answering clears the timer and removes the prompt", async () => {
    const t = fakeTimers();
    const q = new PromptQueue(t);
    const events: string[] = [];
    q.on((e) => events.push(`${e.type}:${e.outcome ?? ""}`));
    const r = q.request(site());
    expect(q.answer(r.promptId, "deny")).toBe(true);
    expect(await r.outcome).toBe("deny");
    expect(t.pending()).toBe(0);
    expect(events).toEqual(["added:", "removed:deny"]);
  });
  it("dropAll (kill) settles everything as killed; dropSession denies one session's prompts", async () => {
    const q = new PromptQueue(fakeTimers());
    const a = q.request(site());
    const b = q.request(site({ sessionId: "s2" }));
    const c = q.request(site({ sessionId: "s3" }));
    q.dropSession("s2");
    expect(await b.outcome).toBe("deny");
    q.dropAll();
    expect(await a.outcome).toBe("killed");
    expect(await c.outcome).toBe("killed");
    expect(q.list()).toEqual([]);
  });
  it("sensitive prompts dedupe on summary and category", () => {
    const q = new PromptQueue(fakeTimers());
    const s = (summary: string, category: "a" | "b") => q.request({ kind: "sensitive", sessionId: "s1", sessionLabel: "x", origin: "https://a.example", sensitive: { category, description: "" }, tool: "act.click", summary, reasons: [] });
    expect(s("click Pay", "a").shared).toBe(false);
    expect(s("click Pay", "a").shared).toBe(true);
    expect(s("click Pay", "b").shared).toBe(false);
    expect(s("click Delete", "a").shared).toBe(false);
  });
  it("unsubscribe stops events", () => {
    const q = new PromptQueue(fakeTimers());
    let n = 0;
    const off = q.on(() => n++);
    off();
    q.request(site());
    expect(n).toBe(0);
  });
});
