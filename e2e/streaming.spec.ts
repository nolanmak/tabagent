// nolanmak/Jarvis#2524: a React 19 streaming-SSR page (portal.anthropic.com/login) in a
// background tab. The real controls sit in <div hidden id="S:0"> until an animation
// frame runs React's reveal, and background tabs run none.
import { test, expect } from "./fixture";
import { refIn, view } from "./view";

test.describe.configure({ mode: "default" });

/** A tab sent to the background, then navigated to the fixture: it loads while hidden, like the live repro. */
async function bgFixture(h: any, c: any) {
  const bg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  const fg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  await h.sw.evaluate(async (id: number) => chrome.tabs.update(id, { active: true }), fg);
  await h.ok(c, "nav.goto", { tabId: bg, url: `${h.A}/streaming-login.html` });
  return bg as number;
}
const stateOf = async (h: any, c: any, tabId: number) => (view(await h.ok(c, "page.text", { tabId })).all.match(/State: ([^\n]+)/) ?? [])[1];
const find = async (h: any, c: any, tabId: number, p: Record<string, unknown>) => view(await h.ok(c, "page.find", { tabId, ...p })).json.matches as { ref: string; name: string; hidden?: string }[];

test("a streamed login card in a background tab: snapshot and find agree, click and scroll act on the rendered button", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const s = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  const google = refIn(s, /button "Continue with Google"/);
  expect(s).toMatch(/button "Continue with email" \[ref=e\d+\]/);
  const m = await find(h, c, bg, { by: "role", value: "button", name: "Continue with Google" });
  expect(m[0].ref).toBe(google);
  expect(m[0].hidden).toBeUndefined();
  const box = view(await h.ok(c, "act.scroll", { tabId: bg, ref: google })).json.position;
  expect(box.w).toBeGreaterThan(0);
  expect(box.h).toBeGreaterThan(0);
  await h.ok(c, "act.click", { tabId: bg, ref: google, timeout: 2000 });
  expect(await stateOf(h, c, bg)).toBe("google");
  const active = await h.sw.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, bg);
  expect(active).toBe(false);
});

test("page.find returns the rendered duplicate first, pierces open shadow roots, and flags hidden copies", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const dup = await find(h, c, bg, { by: "text", value: "Open settings" });
  expect(dup.length).toBe(2);
  expect(dup[0].hidden).toBeUndefined();
  expect(dup[1].hidden).toMatch(/display:none/);
  await h.ok(c, "act.click", { tabId: bg, ref: dup[0].ref, timeout: 2000 });
  expect(await stateOf(h, c, bg)).toBe("settings");

  const sh = await find(h, c, bg, { by: "role", value: "button", name: "Shadow action" });
  expect(sh.length).toBe(2);
  expect(sh[0].hidden).toBeUndefined();
  await h.ok(c, "act.click", { tabId: bg, ref: sh[0].ref, timeout: 2000 });
  expect(await stateOf(h, c, bg)).toBe("shadow");
});

test("acting on a hidden copy says why it has no box", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const dup = await find(h, c, bg, { by: "text", value: "Open settings" });
  const r = await h.call(c, "act.click", { tabId: bg, ref: dup[1].ref, timeout: 500 });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("NOT_ACTIONABLE");
  expect(r.text).toMatch(/reason: hidden\): inside <div> which is display:none/);
  expect(await stateOf(h, c, bg)).toBe("idle");
});
