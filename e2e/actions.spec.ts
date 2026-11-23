import { test, expect } from "./fixture";
import { refIn, view } from "./view";

test.describe.configure({ mode: "serial" });

const text = async (h: any, c: any) => view(await h.ok(c, "page.text", {})).all;

test("modal overlay: NOT_ACTIONABLE reason covered naming the modal, then success after closing it", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/modal.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const target = refIn(s, /button "Target"/);
  const blocked = await h.call(c, "act.click", { ref: target, timeout: 600 });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain("NOT_ACTIONABLE");
  expect(blocked.text).toContain("reason: covered");
  expect(view(blocked).all).toMatch(/covered by <div#overlay\.cookie-banner>|Cookies/);
  const r = view(await h.ok(c, "act.click", { ref: refIn(s, /Accept cookies/) }));
  // D24 diff: the dialog and its button went away
  expect(r.json.snapshotDiff).toMatch(/^- - dialog "Cookies"/m);
  expect(r.json.snapshotDiff).toMatch(/^- - button "Accept cookies"/m);
  await h.ok(c, "act.click", { ref: target });
  expect(await text(h, c)).toContain("target clicked");
});

test("type (insertText), press, fill on a controlled input; stale and malformed refs", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const nick = refIn(s, /textbox "Controlled"/);
  const typed = view(await h.ok(c, "act.type", { ref: nick, text: "Neo" }));
  expect(typed.json.snapshotDiff).toMatch(/^~ - textbox "Controlled" \[ref=e\d+\] value="Neo"/m);
  expect(await text(h, c)).toContain("Nickname preview: Neo");
  await h.ok(c, "act.fill", { ref: nick, value: "Trinity" });
  expect(await text(h, c)).toContain("Nickname preview: Trinity");
  await h.ok(c, "act.press", { ref: nick, key: "Meta+a" });
  await h.ok(c, "act.press", { key: "Backspace" });
  expect(await text(h, c)).not.toContain("Nickname preview: Trinity");
  const bad = await h.call(c, "act.press", { key: "Hyper+q" });
  expect(bad.text).toContain("BAD_REQUEST");
  await h.ok(c, "act.type", { ref: nick, text: "Morpheus", clear: true });
  expect(await text(h, c)).toContain("Nickname preview: Morpheus");
  expect((await h.call(c, "act.click", { ref: "e99999999" })).text).toContain("REF_STALE");
  expect((await h.call(c, "act.click", { ref: "l3" })).text).toContain("REF_STALE");
  // not a text field
  const nf = await h.call(c, "act.fill", { ref: refIn(s, /button "Create account"/), value: "x" });
  expect(nf.text).toContain("NOT_ACTIONABLE");
});

test("React-style controlled form: act.fill value survives a re-render and submits", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/react-form.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  await h.ok(c, "act.fill", { ref: refIn(s, /textbox "Name"/), value: "Ada" });
  await h.ok(c, "act.fill", { ref: refIn(s, /textbox "City"/), value: "London" });
  const after = view(await h.ok(c, "page.snapshot")).snap;
  expect(after).toContain('textbox "Name"');
  expect(after).toMatch(/textbox "Name" \[ref=e\d+\] value="Ada"/);
  await h.ok(c, "act.click", { ref: refIn(after, /button "Save"/) });
  expect(await text(h, c)).toContain('submitted {"name":"Ada","city":"London"}');
});

test("select: native select and custom ARIA combobox", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const country = refIn(s, /combobox "Country"/);
  expect(view(await h.ok(c, "act.select", { ref: country, values: ["Canada"] })).json.selected).toEqual(["Canada"]);
  const miss = await h.call(c, "act.select", { ref: country, values: ["Atlantis"] });
  expect(miss.isError).toBe(true);
  expect(view(miss).all).toContain("Options:");

  await h.ok(c, "nav.goto", { url: `${h.A}/custom-select.html` });
  const s2 = view(await h.ok(c, "page.snapshot")).snap;
  await h.ok(c, "act.select", { ref: refIn(s2, /combobox "Fruit"/), values: ["Papaya"] });
  expect(await text(h, c)).toContain("chose Papaya");
});

test("check: visually hidden custom checkbox and radio", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const sub = refIn(s, /checkbox "Subscribe/);
  expect(view(await h.ok(c, "act.check", { ref: sub, checked: true })).json.result.checked).toBe(true);
  expect(view(await h.ok(c, "act.check", { ref: sub, checked: true })).json.result.changed).toBe(false);
  await h.ok(c, "act.check", { ref: sub, checked: false });
  expect(view(await h.ok(c, "act.check", { ref: refIn(s, /radio "Pro"/) })).json.result.checked).toBe(true);
});

test("long page: click scrolls into view; act.scroll", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/long.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const r = view(await h.ok(c, "act.click", { ref: refIn(s, /button "Bottom button"/) }));
  expect(r.json.snapshotDiff).toContain('button "bottom clicked"');
  const sc = view(await h.ok(c, "act.scroll", { dy: -300 })).json;
  expect(sc.ok).toBe(true);
});

test("hover menu, drag and drop, double-click", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/hover.html` });
  const s0 = view(await h.ok(c, "page.snapshot")).snap;
  expect(s0).not.toContain("Laptops");
  const hv = view(await h.ok(c, "act.hover", { ref: refIn(s0, /button "Products"/) }));
  expect(hv.json.snapshotDiff).toMatch(/^\+ - link "Laptops" \[ref=e\d+\]/m);
  await h.ok(c, "act.click", { ref: refIn(hv.json.snapshotDiff, /link "Laptops"/) });
  expect(await text(h, c)).toContain("laptops chosen");

  await h.ok(c, "nav.goto", { url: `${h.A}/drag.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  // the drop zone is a landmark (no ref in interactive mode, D23): page.find mints one
  const zone = view(await h.ok(c, "page.find", { by: "role", value: "region", name: "Drop zone" })).json.matches[0].ref;
  await h.ok(c, "act.drag", { from: refIn(s, /Drag source/), to: zone });
  expect(await text(h, c)).toContain("dropped payload-1");

  await h.ok(c, "nav.goto", { url: `${h.A}/dblclick.html` });
  const s2 = view(await h.ok(c, "page.snapshot")).snap;
  await h.ok(c, "act.dblclick", { ref: refIn(s2, /Double-click target/) });
  expect(await text(h, c)).toContain("double clicked");
});

test("an action that navigates reports navigation and no snapshotDiff", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const r = view(await h.ok(c, "act.click", { ref: refIn(s, /link "Form"/) }));
  expect(r.json.navigation.url).toContain("/form.html");
  expect(r.json.navigation.title).toBe("Sign up");
  expect(r.json.snapshotDiff).toBeUndefined();
  // the baseline was cleared: the next diff=true snapshot is a full one
  expect(view(await h.ok(c, "page.snapshot", { diff: true })).json.full).toBe(true);
});

test("D28: an action that opens a dialog returns dialogs; other commands get DIALOG_OPEN", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/dialog.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const r = view(await h.ok(c, "act.click", { ref: refIn(s, /Ask confirm/) }));
  expect(r.json.dialogs?.[0]?.type).toBe("confirm");
  expect(r.json.dialogs?.[0]?.message).toBe("Really do it?");
  expect(r.json.snapshotDiff).toBeUndefined();
  for (const [tool, args] of [["page.snapshot", {}], ["act.click", { ref: refIn(s, /Ask prompt/) }], ["page.find", { by: "text", value: "x" }]] as const) {
    const blocked = await h.call(c, tool, args);
    expect(blocked.text, tool).toContain("DIALOG_OPEN");
  }
  await h.ok(c, "dialog.handle", { action: "accept" });
  // the dialog is gone: commands work again (accept vs dismiss is dialog.handle's own test)
  expect(await text(h, c)).toMatch(/confirmed|cancelled/);
});

test("background tab: type/press/click work without focusing the tab (headless too)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const bg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/form.html` })).json.tabId;
  const fg = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  // bring the second tab to the front the way a user would
  await h.sw.evaluate(async (id) => chrome.tabs.update(id, { active: true }), fg);
  const s = view(await h.ok(c, "page.snapshot", { tabId: bg })).snap;
  const nick = refIn(s, /textbox "Controlled"/);
  const t0 = Date.now();
  await h.ok(c, "act.type", { tabId: bg, ref: nick, text: "bg typing", timeout: 3000 });
  await h.ok(c, "act.press", { tabId: bg, key: "End" });
  await h.ok(c, "act.click", { tabId: bg, ref: refIn(s, /checkbox "Subscribe/) });
  expect(Date.now() - t0).toBeLessThan(15000);
  expect(view(await h.ok(c, "page.text", { tabId: bg })).all).toContain("Nickname preview: bg typing");
  const active = await h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, bg);
  expect(active).toBe(false);
});
