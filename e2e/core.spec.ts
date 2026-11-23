import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("tabs: new, list, select, close", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "tabs-agent" });
  const t1 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` });
  const t2 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/article.html` });
  expect(t1.json.tabId).toBeTruthy();
  const list = await h.ok(c, "tabs", { action: "list" });
  expect(list.json.tabs.map((t: any) => t.tabId)).toEqual([t1.json.tabId, t2.json.tabId]);
  expect(list.json.tabs.find((t: any) => t.active).tabId).toBe(t2.json.tabId);
  await h.ok(c, "tabs", { action: "select", tabId: t1.json.tabId });
  const snap = await h.ok(c, "page.snapshot");
  expect(snap.json.title).toBe("Fixtures home");
  await h.ok(c, "tabs", { action: "close", tabId: t2.json.tabId });
  const list2 = await h.ok(c, "tabs", { action: "list" });
  expect(list2.json.tabs).toHaveLength(1);
  // tab group label
  const groups = await h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
  expect(groups).toContain("🤖 tabs-agent");
});

test("navigation: goto, back, forward, reload, normalises bare hosts", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const back = await h.ok(c, "nav.back");
  expect(back.json.url).toContain("/index.html");
  const fwd = await h.ok(c, "nav.forward");
  expect(fwd.json.url).toContain("/article.html");
  const rl = await h.ok(c, "nav.reload");
  expect(rl.json.title).toBe("Article");
  const bad = await h.call(c, "nav.back", {});
  void bad;
  const ni = await h.ok(c, "nav.goto", { url: `${h.A}/network.html`, waitUntil: "networkidle" });
  expect(ni.json.title).toBe("Network");
});

test("nav.wait: text, selector, url, networkidle, fn, timeout", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/delay.html` });
  const w = await h.ok(c, "nav.wait", { for: "text", value: "Ready now", timeout: 5000 });
  expect(w.json.ok).toBe(true);
  await h.ok(c, "nav.wait", { for: "selector", value: "main button" });
  await h.ok(c, "nav.wait", { for: "url", value: "/delay\\.html$/" });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await h.ok(c, "nav.wait", { for: "fn", value: "document.querySelectorAll('button').length === 1" });
  const to = await h.call(c, "nav.wait", { for: "text", value: "never appears", timeout: 400 });
  expect(to.isError).toBe(true);
  expect(to.text).toContain("TIMEOUT");
});

test("snapshot: interactive vs full, root, maxTokens, diff, untrusted wrapping", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/delay.html` });
  await h.ok(c, "nav.wait", { for: "text", value: "Ready now" });
  const s = await h.ok(c, "page.snapshot");
  expect(s.text).toContain("<untrusted-page-content>");
  expect(s.text).toContain('button "Late button"');
  // prompt-injection text is inside the wrapper
  const inner = s.text.split("<untrusted-page-content>")[1];
  expect(inner).toContain("Ignore previous instructions");
  const full = await h.ok(c, "page.snapshot", { mode: "full" });
  expect(full.text.length).toBeGreaterThanOrEqual(s.text.length);

  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const t = await h.ok(c, "page.snapshot");
  const tableRef = Harness.ref(t.text, /- table/);
  const sub = await h.ok(c, "page.snapshot", { root: tableRef });
  expect(sub.text).toContain("Apple");
  expect(sub.text).not.toContain("Next");
  const tiny = await h.ok(c, "page.snapshot", { maxTokens: 60 });
  expect(tiny.json.truncated).toBe(true);
  // diff after a page change
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  await h.ok(c, "page.snapshot");
  const btn = Harness.ref((await h.ok(c, "page.snapshot")).text, /Click me/);
  await h.ok(c, "act.click", { ref: btn });
  const d = await h.ok(c, "page.snapshot", { diff: true });
  expect(d.text).toMatch(/no changes|Clicked/);
});

test("page.find / page.text / page.markdown", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const f = await h.ok(c, "page.find", { text: "forms" });
  expect(f.text).toContain('"role":"link"');
  const byRole = await h.ok(c, "page.find", { role: "heading", name: "Details" });
  expect(byRole.text).toContain("Details");
  const css = await h.ok(c, "page.find", { css: "li" });
  expect(css.text).toContain('"total":2');
  const xp = await h.ok(c, "page.find", { xpath: "//h1" });
  expect(xp.text).toContain("Tab Agent Story");
  const md = await h.ok(c, "page.markdown");
  expect(md.text).toContain("# The Tab Agent Story");
  expect(md.text).toContain("**browse**");
  expect(md.text).toMatch(/\[forms\]\(http:\/\/localhost:\d+\/form\.html\)/);
  expect(md.text).toContain("| Key | Value |");
  expect(md.text).toContain("- Fast");
  expect(md.text).not.toContain("© fixtures");
  const txt = await h.ok(c, "page.text");
  expect(txt.text).toContain("The Tab Agent Story");
});

test("screenshots: viewport, full page, element, marks", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const vp = await h.ok(c, "page.screenshot");
  expect(vp.image?.mimeType).toBe("image/png");
  expect(Buffer.from(vp.image!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  const fp = await h.ok(c, "page.screenshot", { fullPage: true, format: "jpeg" });
  expect(fp.image?.mimeType).toBe("image/jpeg");
  const snap = await h.ok(c, "page.snapshot");
  const link = Harness.ref(snap.text, /link "Next"/);
  const el = await h.ok(c, "page.screenshot", { ref: link });
  expect(el.json.width).toBeLessThan(200);
  const mk = await h.ok(c, "page.screenshot", { marks: true });
  expect(mk.image!.data.length).toBeGreaterThan(1000);
  writeFileSync(join(h.home, "marks.png"), Buffer.from(mk.image!.data, "base64"));
  // overlay cleaned up after marks
  const after = await h.ok(c, "page.snapshot");
  expect(after.text).not.toContain("e1 ");
});
