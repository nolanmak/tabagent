// #158 Timed tasks end to end: task.start / task.end through a real MCP client, calls in between logged under
// the task with durations, and the side panel's Tasks section showing the task, its timeline and ✓/✗ labels.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

const audit = (h: Harness) =>
  readFileSync(join(h.home, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("task.start / task.end time the calls between them; the panel lists the task with its calls", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "timer" });
  const started = await h.ok(c, "task.start", { goal: "Read the fixtures home page" });
  const taskId: string = started.json.taskId;
  expect(taskId).toMatch(/^t-/);
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  await h.ok(c, "page.snapshot");
  const ended = await h.ok(c, "task.end", { outcome: "success", note: "read it" });
  expect(ended.json).toMatchObject({ taskId, callCount: 2 });

  const recs = audit(h).filter((l) => l.taskId === taskId);
  expect(recs.map((l) => l.tool)).toEqual(["nav.goto", "page.snapshot"]);
  for (const r of recs) expect(r.durationMs).toBeGreaterThanOrEqual(0);
  expect(audit(h).find((l) => l.event === "task.ended" && l.data?.taskId === taskId)?.data).toMatchObject({ outcome: "success", callCount: 2 });

  const again = await h.call(c, "task.end", { outcome: "failed" });
  expect(again.text).toContain("NOT_FOUND");

  const panel = await h.openPanel();
  const box = panel.locator("#tasksBox");
  await expect(box).toBeVisible();
  await box.locator("summary").click();
  const row = panel.locator(`#tasks li.task[data-task-id="${taskId}"]`);
  await expect(row).toContainText("Read the fixtures home page");
  await expect(row.locator(".task-badge")).toHaveText("✓ Done");
  await row.locator("[data-task-toggle]").click();
  await expect(row.locator(".task-timeline li")).toHaveCount(2);
  await expect(row.locator(".task-timeline")).toContainText("nav.goto");
  await expect(row).toContainText("read it");
  await c.close();
  await panel.close();
});

test("calls without task.start form an implicit task the user can label from the panel", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "implicit" });
  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const taskId: string = audit(h).filter((l) => l.tool === "nav.goto").at(-1).taskId;
  expect(taskId).toBeTruthy();
  // ending the session ends its implicit task
  await h.ok(c, "session.end");
  await expect.poll(() => audit(h).some((l) => l.event === "task.ended" && l.data?.taskId === taskId)).toBe(true);

  const panel = await h.openPanel();
  await panel.locator("#tasksBox summary").click();
  const row = panel.locator(`#tasks li.task[data-task-id="${taskId}"]`);
  await expect(row.locator(".task-badge")).toHaveText("Unlabeled");
  await row.locator('[data-task-label="success"]').click();
  await expect(row.locator(".task-badge")).toHaveText("✓ Done");
  expect(audit(h).find((l) => l.event === "task.labeled" && l.data?.taskId === taskId)?.data).toMatchObject({ outcome: "success" });
  await c.close();
  await panel.close();
});
