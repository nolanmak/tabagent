import { test, expect, Harness } from "./fixture";

test("#68/#69 agent capture produces a reviewed recipe that replays safely", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "workflow-e2e" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "workflow.capture_start", { tabId, source: "agent", name: "fixture click and search" });
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/index.html` });
  await h.ok(c, "nav.wait", { tabId, for: "load" });
  const snap = await h.ok(c, "page.snapshot", { tabId });
  await h.ok(c, "act.click", { tabId, ref: Harness.ref(snap.text, /button "Click me"/) });
  await h.ok(c, "act.type", { tabId, ref: Harness.ref(snap.text, /searchbox "Search"/), text: "widgets" });
  const stopped = await h.ok(c, "workflow.capture_stop", { tabId });
  const recipe = stopped.json.recipe;
  expect(recipe.status).toBe("draft");
  expect(recipe.steps.map((s: any) => s.kind)).toEqual(["navigate", "wait", "click", "input"]);
  expect(JSON.stringify(recipe)).not.toContain("cookie");

  const panel = await h.openPanel();
  try {
    await expect(panel.locator("#workflows")).toContainText("click: Click me");
    await expect(panel.locator(`button[data-delete-workflow-step="${recipe.id}"]`)).toHaveCount(4);
    await panel.locator(`button[data-parameterize-workflow-step="${recipe.id}"]`).click();
    await expect(panel.locator("#workflows")).toContainText("{{SEARCH}}");
    await panel.locator(`input[data-dedupe-key="${recipe.id}"]`).fill("fixture-report-v1");
    await panel.locator(`input[data-url-assertion="${recipe.id}"]`).fill("/index.html");
    await panel.locator(`button[data-review-workflow="${recipe.id}"]`).click();
    await expect(panel.locator("#workflows")).toContainText("reviewed");
  } finally {
    await panel.close();
  }
  const missingInput = await h.ok(c, "workflow.run", { id: recipe.id, tabId });
  expect(missingInput.json.run).toMatchObject({ state: "blocked", reasonCode: "ASSERTION_FAILED" });
  const replay = await h.ok(c, "workflow.run", { id: recipe.id, tabId, inputs: { "{{SEARCH}}": "widgets" } });
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

  await h.sw.evaluate(() => (globalThis as any).__tabagent.runDueSchedules(new Date(Date.now() + 60_000), false));
  const offline = await h.ok(c, "workflow.runs", { id: recipe.id });
  expect(offline.json.runs.at(-1)).toMatchObject({ state: "blocked", reasonCode: "NO_EXTENSION" });
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

test("#68/#69 agent capture replays a metadata-only download checkpoint", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "workflow-download-e2e" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "workflow.capture_start", { tabId, source: "agent", name: "download csv" });
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/downloads.html` });
  const snap = await h.ok(c, "page.snapshot", { tabId });
  await h.ok(c, "act.click", { tabId, ref: Harness.ref(snap.text, /link "Download CSV"/) });
  await h.ok(c, "downloads.wait", { timeout: 15000 });
  const stopped = await h.ok(c, "workflow.capture_stop", { tabId });
  const recipe = stopped.json.recipe;
  const checkpoint = recipe.steps.at(-1);
  // Chrome may provide a generated temporary filename, so MIME is the stable
  // reviewed expectation here; a usable extension is included when available.
  expect(checkpoint).toMatchObject({ kind: "download", download: { mime: "text/csv" } });
  expect(JSON.stringify(checkpoint)).not.toMatch(/data\.csv|https?:/i);

  const panel = await h.openPanel();
  try {
    await panel.locator(`button[data-review-workflow="${recipe.id}"]`).click();
  } finally {
    await panel.close();
  }
  const replay = await h.ok(c, "workflow.run", { id: recipe.id, tabId });
  expect(replay.json.run.state, JSON.stringify(replay.json.run)).toBe("succeeded");
});

test("#68 manual capture records a tab-attributed download without its filename or URL", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "manual-download-e2e" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/downloads.html` });
  const panel = await h.openPanel();
  try {
    await panel.locator("#manualCaptureTab").selectOption(String(tabId));
    await panel.locator("#manualCaptureStart").click();
    const page = h.ctx.pages().filter((p) => p.url().includes("/downloads.html")).at(-1);
    if (!page) throw new Error("fixture tab not found");
    await Promise.all([page.waitForEvent("download"), page.click("#txt")]);
    await page.waitForTimeout(200);
    await panel.locator("#manualCaptureStop").click();
    await expect(panel.locator("#workflows")).toContainText("download: application/octet-stream");
  } finally {
    await panel.close();
  }
  const recipe = (await h.ok(c, "workflow.list", {})).json.workflows.at(-1);
  const downloads = recipe.steps.filter((step: any) => step.kind === "download");
  expect(downloads).toHaveLength(1);
  expect(downloads[0].download).toMatchObject({ mime: "application/octet-stream" });
  expect(JSON.stringify(downloads)).not.toMatch(/notes\.txt|https?:/i);
});
