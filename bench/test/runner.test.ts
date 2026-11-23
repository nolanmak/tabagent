// #24: dry run with the scripted fake agent produces the results table with the
// right columns and marks a task failed when its checker fails.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { main, parseArgs } from "../run.mjs";
// @ts-expect-error untyped .mjs
import { COLUMNS, renderTable, runTasks } from "../runner.mjs";
// @ts-expect-error untyped .mjs
import { TASK_SET_VERSION, TASKS } from "../tasks.mjs";

const quiet = { log: () => {} };

describe("bench dry run", () => {
  it("all tasks pass with recorded passing states", async () => {
    const { rows, summary } = await main(["--dry-run", "--date", "2026-11-23"], quiet);
    expect(rows).toHaveLength(20);
    expect(summary.passed).toBe(20);
    for (const r of rows) {
      expect(r.agent).toBe("fake");
      expect(r.model).toBe("scripted");
      expect(r.date).toBe("2026-11-23");
      expect(r.taskSet).toBe(TASK_SET_VERSION);
      expect(r.calls).toBe(TASKS.find((t: any) => t.id === r.task).script.length);
      expect(r.modelTokens).toBeGreaterThan(0);
      expect(r.charTokens).toBeGreaterThan(0);
    }
  });

  it("the table has the agreed columns and a total row", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "bench-")), "results.md");
    const { table } = await main(["--dry-run", "--date", "2026-11-23", "--out", out], quiet);
    const lines = table.trim().split("\n");
    expect(lines[0]).toBe(`| ${COLUMNS.join(" | ")} |`);
    expect(COLUMNS).toEqual(["agent", "model", "date", "task-set", "task", "success", "calls", "tokens (model)", "tokens (chars/4)"]);
    expect(lines).toHaveLength(2 + 20 + 1);
    expect(lines[lines.length - 1]).toContain("| **total** | 20/20 |");
    expect(readFileSync(out, "utf8")).toBe(table);
  });

  it("marks a task failed when its checker fails", async () => {
    const { rows, table, summary } = await main(["--dry-run", "--fail", "dialog-prompt,checkout-multi-step"], quiet);
    expect(summary.passed).toBe(18);
    const bad = rows.filter((r: any) => !r.success).map((r: any) => r.task);
    expect(bad.sort()).toEqual(["checkout-multi-step", "dialog-prompt"]);
    expect(table).toMatch(/\| dialog-prompt \| FAIL: displayName is null \|/);
  });

  it("--tasks selects a subset; unknown ids are rejected", async () => {
    const { rows } = await main(["--dry-run", "--tasks", "link-url"], quiet);
    expect(rows.map((r: any) => r.task)).toEqual(["link-url"]);
    await expect(main(["--dry-run", "--fail", "bogus"], quiet)).rejects.toThrow(/unknown task/);
    await expect(main([], quiet)).rejects.toThrow(/--agent claude-code/);
  });

  it("an agent or env error fails the task instead of the run", async () => {
    const task = { id: "t", script: [], check: () => ({ pass: true, reason: "" }) };
    const rows = await runTasks({
      tasks: [task],
      agent: { name: "a", model: "m", run: async () => { throw new Error("boom"); } },
      env: { prepare: async () => ({ startUrl: "x" }), state: async () => ({}) },
    });
    expect(rows[0]).toMatchObject({ success: false, reason: "error: boom", modelTokens: null });
    expect(renderTable(rows)).toContain("| n/a |");
  });

  it("parseArgs", () => {
    expect(parseArgs(["--dry-run", "--tasks", "a,b", "x"])).toEqual({ "dry-run": true, tasks: "a,b" });
  });
});
