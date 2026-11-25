// nolanmak/Jarvis#2522: custom checkboxes and radios (hidden native input plus a
// styled label, React-controlled) in a background tab, the way agents use TabAgent.
import { test, expect } from "./fixture";
import { payload } from "./payload";
import { refIn, view } from "./view";

test.describe.configure({ mode: "default" });

/** A fresh tab on the fixture, left in the background behind another tab. */
async function bgFixture(h: any, c: any) {
  const bg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/custom-checks.html` })).json.tabId;
  const fg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  await h.sw.evaluate(async (id: number) => chrome.tabs.update(id, { active: true }), fg);
  return bg as number;
}
const stateOf = async (h: any, c: any, tabId: number) => (view(await h.ok(c, "page.text", { tabId })).all.match(/State: ([^\n]+)/) ?? [])[1];
const findRef = async (h: any, c: any, tabId: number, css: string) => view(await h.ok(c, "page.find", { tabId, by: "css", value: css })).json.matches[0].ref as string;

test("act.check sets hidden-input checkboxes and radios in a background tab, before any typing", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const s = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  // The very first input in this tab is a mouse click (no act.type/press has woken it).
  expect(view(await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /radio "Yes"/), checked: true })).json.result).toEqual({ checked: true, changed: true, verified: true });
  expect(await stateOf(h, c, bg)).toBe("loc-0");
  await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /checkbox "AI-powered research/), checked: true });
  await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /checkbox "Workflow automation/), checked: true });
  await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /checkbox "AI-powered research/), checked: false });
  expect(await stateOf(h, c, bg)).toBe("loc-0,area-1");
  // a fresh snapshot agrees with the page's own state
  const s2 = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  expect(s2).toMatch(/radio "Yes"[^\n]*checked=true/);
  expect(s2).toMatch(/checkbox "Workflow automation"[^\n]*checked=true/);
  expect(s2).toMatch(/checkbox "AI-powered research and analysis"[^\n]*checked=false/);
  const active = await h.sw.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, bg);
  expect(active).toBe(false);
});

test("act.click on a hidden radio/checkbox input clicks its label instead of failing 'hidden'", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const s = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  const r = await h.call(c, "act.click", { tabId: bg, ref: refIn(s, /radio "No"/), timeout: 1000 });
  expect(r.text).not.toContain("NOT_ACTIONABLE");
  expect(await stateOf(h, c, bg)).toBe("loc-1");
  // and clicking the label itself works too
  await h.ok(c, "act.click", { tabId: bg, ref: await findRef(h, c, bg, "label[for=area-0]") });
  expect(await stateOf(h, c, bg)).toBe("loc-1,area-0");
});

test("act.check: display:none input with a sibling label, sr-only wrapped input, aria-labelledby, ARIA role widgets", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  for (const css of ["#terms", "#news", "#beta"]) {
    const r = view(await h.ok(c, "act.check", { tabId: bg, ref: await findRef(h, c, bg, css), checked: true }));
    expect(r.json.result.checked).toBe(true);
  }
  expect(await stateOf(h, c, bg)).toBe("terms,news,beta");
  const s = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /checkbox "Remember me"/), checked: true });
  await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /radio "Large"/), checked: true });
  expect(await stateOf(h, c, bg)).toBe("terms,news,beta,Remember me,Large");
  // already in the asked state: no click, changed=false
  expect(view(await h.ok(c, "act.check", { tabId: bg, ref: refIn(s, /checkbox "Remember me"/), checked: true })).json.result.changed).toBe(false);
});

test("form.fill sets custom radios and checkboxes by label in a background tab", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = await bgFixture(h, c);
  const r = payload(await h.ok(c, "form.fill", { tabId: bg, fields: { "Can you help in the same location?": "No", "Workflow automation": true, "I agree to the terms": true } }));
  expect(r.failed).toEqual([]);
  expect(await stateOf(h, c, bg)).toBe("loc-1,area-1,terms");
});
