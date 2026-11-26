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
    await panel.evaluate(async (id) => chrome.runtime.sendMessage({ type: "ui.workflow.review", id, approve: true }), recipe.id);
  } finally {
    await panel.close();
  }
  const replay = await h.ok(c, "workflow.run", { id: recipe.id, tabId });
  expect(replay.json.run.state, JSON.stringify(replay.json.run)).toBe("succeeded");
  const history = await h.ok(c, "workflow.runs", { id: recipe.id });
  expect(history.json.runs.at(-1).state).toBe("succeeded");
});
