// #24: each task's end-state checker passes its recorded passing state and
// fails its recorded failing state.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { getTask, profileOf, TASK_SET_VERSION, TASKS } from "../tasks.mjs";
// @ts-expect-error untyped .mjs
import { loadRecordedStates } from "../recorded-env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const states = loadRecordedStates();

describe("task set", () => {
  it("has 20 tasks with unique ids, a goal, a fixture page and a script", () => {
    expect(TASKS).toHaveLength(20);
    expect(new Set(TASKS.map((t: any) => t.id)).size).toBe(20);
    const pages = new Set(readdirSync(join(HERE, "../fixtures")));
    for (const t of TASKS) {
      expect(t.goal.length, t.id).toBeGreaterThan(10);
      expect(pages.has(t.page), `${t.id}: ${t.page}`).toBe(true);
      expect(t.script.length, t.id).toBeGreaterThan(0);
    }
    expect(TASK_SET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs on core unless the task says otherwise", () => {
    expect(profileOf(getTask("signup-basic"))).toBe("core");
    expect(profileOf(getTask("download-row-count"))).toBe("core,data");
    expect(() => getTask("nope")).toThrow(/unknown task/);
  });

  it("every task has recorded pass and fail states, and nothing else is recorded", () => {
    expect(Object.keys(states).sort()).toEqual(TASKS.map((t: any) => t.id).sort());
  });
});

describe.each(TASKS.map((t: any) => [t.id, t]))("checker %s", (id, task: any) => {
  it("passes the recorded passing state", () => {
    const v = task.check(states[id].pass);
    expect(v, v.reason).toMatchObject({ pass: true });
  });
  it("fails the recorded failing state with a reason", () => {
    const v = task.check(states[id].fail);
    expect(v.pass).toBe(false);
    expect(v.reason.length).toBeGreaterThan(0);
  });
  it("fails an empty state (nothing happened)", () => {
    expect(task.check({ url: null, title: null, text: "", bench: {}, answer: null }).pass).toBe(false);
  });
});
