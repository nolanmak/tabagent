// #158 Timed tasks: tool registry entries, wire schemas and goal/note redaction.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BridgeToExtSchema, ExtToBridgeSchema, getTool, redactText, TASK_LIMITS, TaskSummarySchema, TEXT_MASK, toMcpName, toolsForProfiles, validateParams } from "../src";

describe("task tools (#158)", () => {
  it("task.start and task.end are bridge-handled, not site-scoped, in core", () => {
    for (const name of ["task.start", "task.end"]) {
      const t = getTool(name)!;
      expect(t).toMatchObject({ group: "task", level: "none", handledBy: "bridge", lite: "supported", pageContent: [] });
      expect(t.sensitive).toBeUndefined();
      expect(toolsForProfiles("core").map((x) => x.name)).toContain(name);
    }
    expect(toMcpName("task.start")).toBe("task_start");
  });
  it("params: goal is required and capped; outcome is success|failed|abandoned", () => {
    const start = getTool("task.start")!;
    expect(validateParams(start, { goal: "add cheese" })).toEqual({ goal: "add cheese" });
    expect(() => validateParams(start, {})).toThrow();
    expect(() => validateParams(start, { goal: "" })).toThrow();
    expect(() => validateParams(start, { goal: "x".repeat(TASK_LIMITS.goal + 1) })).toThrow();
    const end = getTool("task.end")!;
    for (const o of ["success", "failed", "abandoned"]) expect(validateParams(end, { outcome: o })).toEqual({ outcome: o });
    expect(() => validateParams(end, { outcome: "unknown" })).toThrow();
    expect(validateParams(end, { outcome: "failed", note: "out of stock" })).toEqual({ outcome: "failed", note: "out of stock" });
  });
});

describe("wire schemas", () => {
  const summary = { taskId: "t-1", goal: null, explicit: false, startedAt: 1, outcome: null, callCount: 0, browserMs: 0, origins: [], lastAt: 1, calls: [] };
  it("tasks.list / tasks.label are extension -> bridge messages", () => {
    expect(ExtToBridgeSchema.safeParse({ type: "tasks.list", id: "a" }).success).toBe(true);
    expect(ExtToBridgeSchema.safeParse({ type: "tasks.list", id: "a", limit: 0 }).success).toBe(false);
    expect(ExtToBridgeSchema.safeParse({ type: "tasks.label", id: "a", taskId: "t", outcome: "success" }).success).toBe(true);
    // the user labels success or failure only
    expect(ExtToBridgeSchema.safeParse({ type: "tasks.label", id: "a", taskId: "t", outcome: "abandoned" }).success).toBe(false);
  });
  it("tasks.listed / tasks.labeled / tasks.changed are bridge -> extension messages", () => {
    expect(BridgeToExtSchema.safeParse({ type: "tasks.listed", id: "a", tasks: [summary] }).success).toBe(true);
    expect(BridgeToExtSchema.safeParse({ type: "tasks.labeled", id: "a", ok: false, code: "NOT_FOUND" }).success).toBe(true);
    expect(BridgeToExtSchema.safeParse({ type: "tasks.changed" }).success).toBe(true);
    expect(TaskSummarySchema.safeParse({ ...summary, outcome: "nope" }).success).toBe(false);
  });
});

describe("redactText", () => {
  it.each([
    ["sign in with password: hunter2 then pay", `sign in with password: ${TEXT_MASK} then pay`],
    ["pin=1234", `pin=${TEXT_MASK}`],
    ['token is "abc def"', `token is ${TEXT_MASK}`],
    ["card 4111 1111 1111 1111 exp 12/29", `card ${TEXT_MASK} exp 12/29`],
    ["card 4111-1111-1111-1111", `card ${TEXT_MASK}`],
    ["ssn 123-45-6789", `ssn ${TEXT_MASK}`],
    ["add a 32 oz bag of mozzarella to order 199874271", "add a 32 oz bag of mozzarella to order 199874271"],
  ])("%s", (input, want) => {
    expect(redactText(input)).toBe(want);
  });
  it("caps length and trims", () => {
    expect(redactText("  hi  ")).toBe("hi");
    const long = redactText("a".repeat(600));
    expect(long).toHaveLength(TASK_LIMITS.goal);
    expect(long.endsWith("…")).toBe(true);
    expect(redactText("abcdef", 4)).toBe("abc…");
  });
  it("never returns a card number embedded in text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.stringMatching(/^[0-9]{16}$/), fc.string({ maxLength: 20 }), (a, card, b) => {
        expect(redactText(`${a} ${card} ${b}`, 1000)).not.toContain(card);
      }),
    );
  });
});
