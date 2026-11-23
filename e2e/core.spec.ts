import { test, expect } from "./fixture";

test.describe.configure({ mode: "serial" });

test("tabs: new, list, select, close", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "tabs-agent" });
  const userActive = await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  const t1 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` });
  const t2 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/p/second` });
  const id1 = t1.json.tabId;
  const id2 = t2.json.tabId;
  expect(id1).toBeTruthy();
  expect(t1.json.title).toBe("Fixtures home");
  const list = (await h.ok(c, "tabs", { action: "list" })).json;
  expect(list.tabs.map((t: any) => t.tabId)).toEqual([id1, id2]);
  expect(list.tabs.find((t: any) => t.active).tabId).toBe(id2);
  const sel = await h.ok(c, "tabs", { action: "select", tabId: id1 });
  expect(sel.json).toMatchObject({ tabId: id1, title: "Fixtures home" });
  expect((await h.ok(c, "tabs", { action: "list" })).json.tabs.find((t: any) => t.active).tabId).toBe(id1);
  // D10: TabAgent never brings a tab to the front
  expect(await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id)).toBe(userActive);
  // nav.reload without tabId acts on the selected tab
  expect((await h.ok(c, "nav.reload")).json.url).toBe(`${h.A}/index.html`);
  const closed = await h.ok(c, "tabs", { action: "close", tabId: id2 });
  expect(closed.json).toEqual({ closed: id2 });
  expect((await h.ok(c, "tabs", { action: "list" })).json.tabs).toHaveLength(1);
});

test("navigation: goto, back, forward, reload report navigation", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const first = await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  expect(first.json.navigation).toEqual({ url: `${h.A}/index.html`, title: "Fixtures home", kind: "navigate" });
  const g = await h.ok(c, "nav.goto", { url: `${h.A}/p/next` });
  expect(g.json).toMatchObject({ url: `${h.A}/p/next`, title: "/p/next" });
  const back = await h.ok(c, "nav.back");
  expect(back.json).toMatchObject({ url: `${h.A}/index.html`, navigation: { kind: "back" } });
  const fwd = await h.ok(c, "nav.forward");
  expect(fwd.json).toMatchObject({ url: `${h.A}/p/next`, navigation: { kind: "forward" } });
  const rl = await h.ok(c, "nav.reload");
  expect(rl.json).toMatchObject({ url: `${h.A}/p/next`, title: "/p/next", navigation: { kind: "reload" } });
  const none = await h.call(c, "nav.forward");
  expect(none.isError).toBe(true);
  expect(none.text).toMatch(/^BAD_REQUEST: No forward history entry/);
});
