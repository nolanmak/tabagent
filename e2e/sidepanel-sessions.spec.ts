// Side panel Sessions list (#133): click a session (or one of its tabs) to view that tab.
import type { Page } from "@playwright/test";
import { sessionRowHtml, sessionView } from "../packages/extension/src/pure/sessionsView";
import { test, expect, type Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

const isActive = (h: Harness, tabId: number) => h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId);

/** Make another tab active so a later focus is observable. */
async function activateOther(h: Harness, panel: Page) {
  const panelTab = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
  await h.sw.evaluate(async (id) => chrome.tabs.update(id!, { active: true }), panelTab);
  await expect.poll(() => isActive(h, panelTab!)).toBe(true);
}

test("clicking a session row activates its tab", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "viewer" });
  const r = await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const tabId: number = r.json.tabId;
  const panel = await h.openPanel();
  await activateOther(h, panel);
  expect(await isActive(h, tabId)).toBe(false);
  const row = panel.locator("#sessions li.session", { hasText: "viewer" });
  await expect(row).toContainText("1 tab");
  // End is untouched by View: clicking the view button focuses, End stays a separate control.
  await row.locator(`button.session-view[data-view-tab="${tabId}"]`).click();
  await expect.poll(() => isActive(h, tabId)).toBe(true);
  await expect.poll(() => h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id)).toBe(tabId);
  // keyboard: Enter on the focused view button
  await activateOther(h, panel);
  await row.locator("button.session-view").focus();
  await panel.keyboard.press("Enter");
  await expect.poll(() => isActive(h, tabId)).toBe(true);
  await c.close();
  await panel.close();
});

test("a two-tab session lists both tabs and each focuses the right one; a collapsed group expands", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "pair" });
  const first = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId as number;
  const second = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/article.html` })).json.tabId as number;
  const panel = await h.openPanel();
  const row = panel.locator("#sessions li.session", { hasText: "pair" });
  await expect(row).toContainText("2 tabs");
  const items = row.locator(".session-tabs button.session-tab");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-view-tab", String(second)); // active first
  await expect(items.nth(0)).toContainText("Article");
  await expect(items.nth(1)).toContainText("Fixtures home");

  await activateOther(h, panel);
  await items.nth(1).click();
  await expect.poll(() => isActive(h, first)).toBe(true);
  expect(await isActive(h, second)).toBe(false);

  // collapse the group, then viewing the second tab expands it again
  const groupId = await h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, second);
  await activateOther(h, panel);
  await h.sw.evaluate(async (g) => chrome.tabGroups.update(g, { collapsed: true }), groupId);
  await row.locator(`.session-tabs button[data-view-tab="${second}"]`).click();
  await expect.poll(() => isActive(h, second)).toBe(true);
  await expect.poll(() => h.sw.evaluate(async (g) => (await chrome.tabGroups.get(g)).collapsed, groupId)).toBe(false);

  // the row's own button goes to the session's active tab
  await activateOther(h, panel);
  await row.locator("button.session-view").click();
  await expect.poll(() => isActive(h, second)).toBe(true);
  await c.close();
  await panel.close();
});

test("ui.focusTab refuses a tab no session owns, and the panel says so", async ({ h }) => {
  const userTab = await h.ctx.newPage();
  const userUrl = `${h.A}/article.html?user-focus=${Date.now()}`;
  await userTab.goto(userUrl);
  const tabId = await h.sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, userUrl);
  const panel = await h.openPanel();
  const res = await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "ui.focusTab", tabId: id }), tabId);
  expect(res.error).toContain("not a TabAgent session tab");
  // a stale row pointing at that tab shows the refusal briefly
  await panel.evaluate((id) => {
    document.getElementById("sessions")!.insertAdjacentHTML("beforeend", `<li class="session"><div class="session-head"><button class="session-view" data-view-tab="${id}">stale</button></div></li>`);
  }, tabId);
  await panel.locator(`button[data-view-tab="${tabId}"]`).click();
  await expect(panel.locator("#sessionsNotice")).toContainText("not a TabAgent session tab");
  await expect(panel.locator("#sessionsNotice")).toBeHidden({ timeout: 8000 });
  await userTab.close();
  await panel.close();
});

test("session rows with long labels and tab titles do not overflow at 320px", async ({ h }) => {
  const panel = await h.openPanel();
  await panel.setViewportSize({ width: 320, height: 900 });
  const long = `A very long tab title https://www.example-really-long-subdomain-name.co.uk/${"x".repeat(120)}`;
  const html = sessionRowHtml(sessionView({ id: "s", label: `label-${"y".repeat(80)}`, color: "purple", cap: "full", lastUsed: 0, tabs: 3, tabIds: [1, 2, 3], active: 3 }, { 1: long, 2: long, 3: long }));
  await panel.evaluate((html) => (document.getElementById("sessions")!.innerHTML = html), html);
  const { scrollWidth, clientWidth } = await panel.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await panel.close();
});
