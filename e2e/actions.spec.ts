import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("click is blocked by an overlay with an actionable error", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/modal.html` });
  const s = await h.ok(c, "page.snapshot");
  const target = Harness.ref(s.text, /button "Target"/);
  const blocked = await h.call(c, "act.click", { ref: target, timeout: 600 });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain("NOT_ACTIONABLE");
  expect(blocked.text).toContain("covered by");
  expect(blocked.text).toContain("Hint:");
  const accept = Harness.ref(s.text, /Accept cookies/);
  const r = await h.ok(c, "act.click", { ref: accept });
  expect(r.text).toContain("snapshotDiff");
  const ok = await h.ok(c, "act.click", { ref: target });
  expect(ok.text).toContain("target clicked");
});

test("type, press, fill (React-style controlled input)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = await h.ok(c, "page.snapshot");
  const nick = Harness.ref(s.text, /textbox "Controlled"/);
  await h.ok(c, "act.type", { ref: nick, text: "Neo" });
  expect((await h.ok(c, "page.text", {})).text).toContain("Nickname preview: Neo");
  await h.ok(c, "act.fill", { ref: nick, value: "Trinity" });
  const prev = await h.ok(c, "page.text", {});
  expect(prev.text).toContain("Nickname preview: Trinity");
  await h.ok(c, "act.press", { ref: nick, key: "Meta+a" });
  await h.ok(c, "act.press", { key: "Backspace" });
  const t3 = await h.ok(c, "page.text", {});
  expect(t3.text).not.toContain("Nickname preview: Trinity");
  const bad = await h.call(c, "act.press", { key: "Hyper+q" });
  expect(bad.isError).toBe(true);
  // type with clear
  await h.ok(c, "act.type", { ref: nick, text: "Morpheus", clear: true });
  expect((await h.ok(c, "page.text", {})).text).toContain("Nickname preview: Morpheus");
  // stale ref
  const stale = await h.call(c, "act.click", { ref: "e99999" });
  expect(stale.text).toContain("REF_STALE");
});

test("select: native select and ARIA combobox", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = await h.ok(c, "page.snapshot");
  const country = Harness.ref(s.text, /combobox "Country"/);
  const r = await h.ok(c, "act.select", { ref: country, values: ["Canada"] });
  expect(r.json.selected).toEqual(["Canada"]);
  const miss = await h.call(c, "act.select", { ref: country, values: ["Atlantis"] });
  expect(miss.isError).toBe(true);
  expect(miss.text).toContain("Options:");

  await h.ok(c, "nav.goto", { url: `${h.A}/custom-select.html` });
  const s2 = await h.ok(c, "page.snapshot");
  const cb = Harness.ref(s2.text, /combobox "Fruit"/);
  await h.ok(c, "act.select", { ref: cb, values: ["Papaya"] });
  expect((await h.ok(c, "page.text", {})).text).toContain("chose Papaya");
});

test("check: visually hidden custom checkbox and radio", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const s = await h.ok(c, "page.snapshot");
  const sub = Harness.ref(s.text, /checkbox "Subscribe/);
  const r = await h.ok(c, "act.check", { ref: sub, checked: true });
  expect(r.json.result.checked).toBe(true);
  const again = await h.ok(c, "act.check", { ref: sub, checked: true });
  expect(again.json.result.changed).toBe(false);
  await h.ok(c, "act.check", { ref: sub, checked: false });
  const pro = Harness.ref(s.text, /radio "Pro"/);
  const rr = await h.ok(c, "act.check", { ref: pro });
  expect(rr.json.result.checked).toBe(true);
});

test("scroll, hover, dblclick, drag and drop", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const sc = await h.ok(c, "act.scroll", { dy: 300 });
  expect(sc.json.ok).toBe(true);
  await h.ok(c, "nav.goto", { url: `${h.A}/drag.html` });
  const s = await h.ok(c, "page.snapshot");
  const src = Harness.ref(s.text, /Drag source/);
  const dst = Harness.ref(s.text, /Drop zone/);
  await h.ok(c, "act.hover", { ref: src });
  await h.ok(c, "act.drag", { from: src, to: dst });
  expect((await h.ok(c, "page.text", {})).text).toContain("dropped payload-1");
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const s2 = await h.ok(c, "page.snapshot");
  await h.ok(c, "act.dblclick", { ref: Harness.ref(s2.text, /Click me/) });
  expect((await h.ok(c, "page.text", {})).text).toContain("Clicked 2 times");
});

test("action results report navigation", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const s = await h.ok(c, "page.snapshot");
  const r = await h.ok(c, "act.click", { ref: Harness.ref(s.text, /link "Form"/) });
  expect(r.json.navigated).toBe(true);
  expect(r.json.title).toBe("Sign up");
  expect(r.json.hint).toContain("snapshot");
});
