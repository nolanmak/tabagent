// #108: the bridge's view of the extension's pending prompts. A mirror only: it never decides anything.
import { describe, expect, it } from "vitest";
import type { MirroredPrompt } from "@tabagent/protocol";
import { PendingPrompts } from "../src/approvals/mirror";

const P = (id: string, expires = 10_000, over: Partial<MirroredPrompt> = {}): MirroredPrompt => ({ promptId: id, title: `t ${id}`, detail: "d", summary: "s", reasons: [], tool: "nav.goto", sessionLabel: "jarvis", origin: "https://a.example", expires, answers: ["deny", "once"], ...over });

describe("PendingPrompts", () => {
  it("replaces its list on every sync and reports what was added and removed", () => {
    const m = new PendingPrompts(() => 0);
    expect(m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a"), P("b")] })).toEqual({ added: ["a", "b"], removed: [] });
    expect(m.sync({ type: "prompts.sync", enabled: true, prompts: [P("b"), P("c")] })).toEqual({ added: ["c"], removed: ["a"] });
    expect(m.list().map((p) => p.promptId)).toEqual(["b", "c"]);
    expect(m.enabled).toBe(true);
    expect(m.size).toBe(2);
  });
  it("hides expired prompts", () => {
    let now = 0;
    const m = new PendingPrompts(() => now);
    m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a", 100), P("b", 200)] });
    now = 100;
    expect(m.get("a")).toBeUndefined();
    expect(m.list().map((p) => p.promptId)).toEqual(["b"]);
  });
  it("remembers prompts that just left, so a late answer is reported as already answered", () => {
    let now = 0;
    const m = new PendingPrompts(() => now);
    m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a")] });
    m.sync({ type: "prompts.sync", enabled: true, prompts: [] });
    expect(m.recentlyResolved("a")).toBe(true);
    expect(m.recentlyResolved("zz")).toBe(false);
    now = 11 * 60_000;
    expect(m.recentlyResolved("a")).toBe(false);
  });
  it("disabled syncs carry nothing; clear() empties the list on disconnect", () => {
    const m = new PendingPrompts(() => 0);
    m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a")] });
    m.sync({ type: "prompts.sync", enabled: false, prompts: [P("x")] });
    expect(m.enabled).toBe(false);
    expect(m.list()).toEqual([]);
    m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a")] });
    m.clear();
    expect(m.list()).toEqual([]);
    expect(m.enabled).toBe(true);
  });
  it("returns copies, so callers cannot edit the mirror", () => {
    const m = new PendingPrompts(() => 0);
    m.sync({ type: "prompts.sync", enabled: true, prompts: [P("a")] });
    m.list()[0].title = "changed";
    expect(m.get("a")!.title).toBe("t a");
  });
});
