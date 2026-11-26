import { test, expect, Harness } from "./fixture";

test("#68/#69 agent capture produces a reviewed recipe that replays safely", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "workflow-e2e" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "workflow.capture_start", { tabId, source: "agent", name: "fixture click and search" });
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/index.html` });
  const snap = await h.ok(c, "page.snapshot", { tabId });
  await h.ok(c, "act.click", { tabId, ref: Harness.ref(snap.text, /button "Click me"/) });
  await h.ok(c, "act.type", { tabId, ref: Harness.ref(snap.text, /searchbox "Search"/), text: "widgets" });
  const stopped = await h.ok(c, "workflow.capture_stop", { tabId });
  const recipe = stopped.json.recipe;
  expect(recipe.status).toBe("draft");
  expect(recipe.steps.map((s: any) => s.kind)).toEqual(["navigate", "click", "input"]);
  expect(JSON.stringify(recipe)).not.toContain("cookie");

  const panel = await h.openPanel();
  try {
    await panel.locator(`input[data-dedupe-key="${recipe.id}"]`).fill("fixture-report-v1");
    await panel.locator(`input[data-url-assertion="${recipe.id}"]`).fill("/index.html");
    await panel.locator(`button[data-review-workflow="${recipe.id}"]`).click();
    await expect(panel.locator("#workflows")).toContainText("reviewed");
  } finally {
    await panel.close();
  }
  const replay = await h.ok(c, "workflow.run", { id: recipe.id, tabId });
  expect(replay.json.run.state, JSON.stringify(replay.json.run)).toBe("succeeded");
  const history = await h.ok(c, "workflow.runs", { id: recipe.id });
  expect(history.json.runs.at(-1).state).toBe("succeeded");

  await h.ok(c, "workflow.schedule", { id: recipe.id, tabId, cron: "* * * * *", timeZone: "UTC" });
  const before = history.json.runs.length;
  // Alarm delivery and a foreground tick can overlap. The cron minute still has exactly one run.
  await Promise.all([
    h.sw.evaluate(() => (globalThis as any).__tabagent.runDueSchedules()),
    h.sw.evaluate(() => (globalThis as any).__tabagent.runDueSchedules()),
  ]);
  const scheduled = await h.ok(c, "workflow.runs", { id: recipe.id });
  expect(scheduled.json.runs).toHaveLength(before + 1);
  expect(scheduled.json.runs.at(-1).state).toBe("skipped");
  expect(scheduled.json.runs.at(-1).dedupeKey).toBe("fixture-report-v1");
});

test("#68 manual capture records trusted user events without raw secrets", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "manual-workflow-e2e" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/index.html` });
  const panel = await h.openPanel();
  await panel.locator("#manualCaptureTab").selectOption(String(tabId));
  await panel.locator("#manualCaptureStart").click();
  await expect(panel.locator("#manualCaptureState")).toContainText(`Recording tab ${tabId}`);
  // The harness shares one browser context across the serial E2E suite; choose the tab this
  // test just opened, not an earlier fixture page left by another test.
  const page = h.ctx.pages().filter((p) => p.url().includes("/index.html")).at(-1);
  if (!page) throw new Error("fixture tab not found");
  await page.click("#counter");
  await page.locator('input[aria-label="Search"]').fill("manual widgets");
  await page.locator('input[aria-label="Search"]').press("Tab"); // change event commits the capture
  await page.waitForTimeout(200); // extension runtime messages are asynchronous
  await panel.locator("#manualCaptureStop").click();
  await expect(panel.locator("#workflows")).toContainText("Manual browser task");
  const recipes = await h.ok(c, "workflow.list", {});
  const recipe = recipes.json.workflows.at(-1);
  await panel.close();
  expect(recipe.source).toBe("manual");
  expect(recipe.steps.map((s: any) => s.kind)).toContain("click");
  expect(recipe.steps.map((s: any) => s.kind)).toContain("input");
  expect(JSON.stringify(recipe)).toContain("manual widgets");
  expect(JSON.stringify(recipe)).not.toMatch(/password|cookie|otp/i);
});
