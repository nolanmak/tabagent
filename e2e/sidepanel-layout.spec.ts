import { test, expect } from "./fixture";

// Regression: long origins, URLs, labels and tab titles used to widen the side panel and give it a
// horizontal scrollbar (flex rows that could not shrink, and a <select> sized to its longest option).
const LONG = "https://www.example-really-long-subdomain-name.co.uk/path/to/a/very/long/resource/with/no/breaks?query=abcdefghijklmnopqrstuvwxyz0123456789";

test("side panel never scrolls horizontally with long content", async ({ h }) => {
  await h.setPolicies({ "https://accounts.supercalifragilisticexpialidocious-example.com": "act" });
  const panel = await h.openPanel();
  await panel.setViewportSize({ width: 320, height: 900 });
  await panel.waitForSelector("#sites tr", { state: "attached" });
  // The renderers' own markup for a handoff row and a capture-tab option, filled with long text.
  await panel.evaluate((long) => {
    document.getElementById("handoffBox")!.hidden = false;
    document.getElementById("handoffs")!.innerHTML = `<li><span><b>claude-code-with-a-very-long-client-name</b> · ${long}<br><span class="muted small">${long}</span></span><span><button>Cancel</button> <button class="primary">Done</button></span></li>`;
    document.getElementById("manualCaptureTab")!.innerHTML = `<option>A very long tab title ${long}</option>`;
    document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true));
  }, LONG);
  // The Sites search toolbar (#117), with a long query, a count and the clear button showing.
  await panel.getByLabel("Search sites").fill(LONG);
  await expect(panel.locator("#siteCount")).toHaveText("0 of 1 sites");
  await expect(panel.getByRole("button", { name: "Clear site search" })).toBeVisible();
  const { scrollWidth, clientWidth } = await panel.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await panel.close();
});
