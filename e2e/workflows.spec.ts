import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    await panel.locator(`input[data-dedupe-key="${recipe.id}"]`).fill("fixture-{{SEARCH}}");
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

  await h.ok(c, "workflow.schedule", { id: recipe.id, tabId, cron: "* * * * *", timeZone: "UTC", inputs: { "{{SEARCH}}": "widgets" } });
  const before = history.json.runs.length;
  // Alarm delivery and a foreground tick can overlap. The cron minute still has exactly one run.
  await Promise.all([
    h.sw.evaluate(() => (globalThis as any).__tabagent.runDueSchedules()),
    h.sw.evaluate(() => (globalThis as any).__tabagent.runDueSchedules()),
  ]);
  const scheduled = await h.ok(c, "workflow.runs", { id: recipe.id });
  expect(scheduled.json.runs).toHaveLength(before + 1);
  expect(scheduled.json.runs.at(-1).state).toBe("skipped");
  expect(scheduled.json.runs.at(-1).dedupeKey).toBe("fixture-widgets");

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
  await Harness.openSection(panel, "workflows");
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
    await Harness.openSection(panel, "workflows");
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

test("agent capture replays check, fill, targeted press and scroll; exact names are not repairs", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "workflow-replay-kinds" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "workflow.capture_start", { tabId, source: "agent", name: "replay kinds" });
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/workflow-replay.html` });
  const snap = await h.ok(c, "page.snapshot", { tabId });
  await h.ok(c, "act.click", { tabId, ref: Harness.ref(snap.text, /link "new"/) });
  await h.ok(c, "act.fill", { tabId, ref: Harness.ref(snap.text, /textbox "Query"/), value: "widgets" });
  await h.ok(c, "act.check", { tabId, ref: Harness.ref(snap.text, /checkbox "Hide abstracts"/), checked: true });
  await h.ok(c, "act.press", { tabId, ref: Harness.ref(snap.text, /textbox "Query"/), key: "Enter" });
  await h.ok(c, "nav.wait", { tabId, for: "selector", value: ".result" });
  await h.ok(c, "act.scroll", { tabId, dy: 1200 });
  const recipe = (await h.ok(c, "workflow.capture_stop", { tabId })).json.recipe;
  expect(recipe.steps.map((s: any) => s.kind)).toEqual(["navigate", "click", "input", "check", "press", "wait", "scroll"]);
  expect(recipe.steps[4]).toMatchObject({ key: "Enter", locator: { name: "Query" } });

  const panel = await h.openPanel();
  try {
    await expect(panel.locator("#workflows")).toContainText("check: Hide abstracts → on");
    await expect(panel.locator("#workflows")).toContainText("wait: selector .result");
    await panel.locator(`input[data-url-assertion="${recipe.id}"]`).fill("hide=1");
    await panel.locator(`button[data-review-workflow="${recipe.id}"]`).click();
    await expect(panel.locator("#workflows")).toContainText("reviewed");
  } finally {
    await panel.close();
  }
  await h.ok(c, "nav.goto", { tabId, url: "about:blank" }).catch(() => {});
  const replay = await h.ok(c, "workflow.run", { id: recipe.id, tabId });
  expect(replay.json.run.state, JSON.stringify(replay.json.run)).toBe("succeeded");
  expect(replay.json.run.repairs).toEqual([]);
});

test("#107 workflow.edit_draft edits a captured draft that still needs side-panel review", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "workflow-edit-draft" });
  const tabId = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  await h.ok(c, "workflow.capture_start", { tabId, source: "agent", name: "edit draft fixture" });
  await h.ok(c, "nav.goto", { tabId, url: `${h.A}/index.html` });
  await h.ok(c, "nav.wait", { tabId, for: "load" });
  const snap = await h.ok(c, "page.snapshot", { tabId });
  await h.ok(c, "act.click", { tabId, ref: Harness.ref(snap.text, /button "Click me"/) });
  await h.ok(c, "act.type", { tabId, ref: Harness.ref(snap.text, /searchbox "Search"/), text: "widgets" });
  const recipe = (await h.ok(c, "workflow.capture_stop", { tabId })).json.recipe;
  expect(recipe.steps.map((s: any) => s.kind)).toEqual(["navigate", "wait", "click", "input"]);

  // Atomic: op 2 would hit the input on the original list, but after op 1 index 3 is out of range.
  const bad = await h.call(c, "workflow.edit_draft", { id: recipe.id, ops: [{ op: "remove_step", index: 1 }, { op: "parameterize", index: 3, name: "QUERY" }] });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("BAD_REQUEST");
  const unchanged = (await h.ok(c, "workflow.list", {})).json.workflows.find((w: any) => w.id === recipe.id);
  expect(unchanged.steps).toHaveLength(4);

  // Indices refer to the list left by the previous op: removing the wait moves the input to 2.
  const edited = await h.ok(c, "workflow.edit_draft", { id: recipe.id, ops: [{ op: "remove_step", index: 1 }, { op: "parameterize", index: 2, name: "QUERY" }] });
  expect(edited.json).toMatchObject({ id: recipe.id, status: "draft", needsReview: true });
  expect(edited.json.steps).toEqual([
    { index: 0, kind: "navigate", detail: `${h.A}/index.html` },
    { index: 1, kind: "click", detail: "Click me" },
    { index: 2, kind: "input", detail: "Search", parameter: "{{QUERY}}" },
  ]);
  expect(edited.json.applied).toEqual([
    { op: "remove_step", index: 1, kind: "wait" },
    { op: "parameterize", index: 2, kind: "input", placeholder: "{{QUERY}}" },
  ]);

  // A draft is not runnable until the user reviews it.
  const unreviewed = await h.ok(c, "workflow.run", { id: recipe.id, tabId, inputs: { "{{QUERY}}": "widgets" } });
  expect(unreviewed.json.run).toMatchObject({ state: "blocked", reason: expect.stringMatching(/not been reviewed/) });

  const panel = await h.openPanel();
  try {
    await expect(panel.locator("#workflows")).toContainText("{{QUERY}}");
    await expect(panel.locator(`button[data-delete-workflow-step="${recipe.id}"]`)).toHaveCount(3);
    await expect(panel.locator(`button[data-review-workflow="${recipe.id}"]`)).toBeVisible();
    await panel.locator(`button[data-review-workflow="${recipe.id}"]`).click();
    await expect(panel.locator(`button[data-review-workflow="${recipe.id}"]`)).toHaveCount(0);
  } finally {
    await panel.close();
  }

  // Reviewed recipes are immutable from the CLI.
  const approved = await h.call(c, "workflow.edit_draft", { id: recipe.id, ops: [{ op: "remove_step", index: 0 }] });
  expect(approved.isError).toBe(true);
  expect(approved.text).toContain("BAD_REQUEST");
  expect(approved.text).toMatch(/only draft/i);
  expect((await h.ok(c, "workflow.list", {})).json.workflows.find((w: any) => w.id === recipe.id).steps).toHaveLength(3);

  const missing = await h.call(c, "workflow.edit_draft", { id: "00000000-0000-4000-8000-000000000000", ops: [{ op: "remove_step", index: 0 }] });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("NOT_FOUND");

  // The audit log has the command (with its ops) and one workflow.edit event per applied op.
  await expect.poll(() => readFileSync(join(h.home, "audit.jsonl"), "utf8")).toMatch(/"event":"workflow\.edit".*"op":"parameterize"/);
  const audit = readFileSync(join(h.home, "audit.jsonl"), "utf8");
  expect(audit).toMatch(/"tool":"workflow\.edit_draft".*"outcome":"ok"/);
  const events = audit.split("\n").filter((l) => l.includes('"event":"workflow.edit"') && l.includes(recipe.id)).map((l) => JSON.parse(l).data);
  expect(events).toEqual([
    expect.objectContaining({ recipeId: recipe.id, source: "agent", op: "remove_step", index: 1, kind: "wait" }),
    expect.objectContaining({ recipeId: recipe.id, source: "agent", op: "parameterize", index: 2, placeholder: "{{QUERY}}" }),
  ]);
});
