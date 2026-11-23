// #21 lite mode: no chrome.debugger.
import { test, expect } from "./fixture";
import { refIn, view } from "./view";

test.describe.configure({ mode: "serial" });

test("lite: React form filled and submitted without the debugger; unsupported tools return UNSUPPORTED", async ({ h }) => {
  await h.setPolicies({ [h.A]: "full", [h.B]: "full" }, { devAllowSensitive: true, sites: { [h.A]: { lite: true } } });
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/react-form.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  expect(s).toMatch(/textbox "Name" \[ref=e\d+\] value=""/);
  await h.ok(c, "act.fill", { ref: refIn(s, /textbox "Name"/), value: "Ada" });
  await h.ok(c, "act.fill", { ref: refIn(s, /textbox "City"/), value: "London" });
  const after = view(await h.ok(c, "page.snapshot")).snap;
  expect(after).toMatch(/textbox "Name" \[ref=e\d+\] value="Ada"/);
  await h.ok(c, "act.click", { ref: refIn(after, /button "Save"/) });
  expect(view(await h.ok(c, "page.text")).all).toContain('submitted {"name":"Ada","city":"London"}');

  const shot = await h.call(c, "page.screenshot", { target: "ref", ref: refIn(after, /button "Save"/) });
  expect(shot.isError).toBe(true);
  expect(shot.text).toContain("UNSUPPORTED");
  const ev = await h.call(c, "js.eval", { expression: "1" });
  expect(ev.text).toContain("UNSUPPORTED");

  // refs are stale after a navigation in lite mode too
  const save = refIn(after, /button "Save"/);
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  expect((await h.call(c, "act.click", { ref: save })).text).toContain("REF_STALE");

  const tabId = view(await h.ok(c, "tabs", { action: "list" })).json.tabs.find((t: any) => t.active).tabId;
  const attached: number[] = await h.sw.evaluate(() => (globalThis as any).__tabagent.attachedTabs());
  expect(attached).not.toContain(tabId);
  await h.trustFixtures({ sites: { [h.A]: { lite: false } } });
});
