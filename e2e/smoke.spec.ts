import { test, expect, Harness } from "./fixture";

test("pair, navigate, snapshot, click", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const nav = await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  expect(nav.json.title).toBe("Fixtures home");
  const snap = await h.ok(c, "page.snapshot");
  console.log(snap.text);
  const btn = Harness.ref(snap.text, /button "Click me"/);
  const clk = await h.ok(c, "act.click", { ref: btn });
  console.log(clk.text);
  expect(clk.text).toContain("Clicked 1 times");
});
