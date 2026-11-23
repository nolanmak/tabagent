import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture";
import { refIn, tokens, view } from "./view";

test.describe.configure({ mode: "serial" });

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), "../packages/extension/test/goldens");
const normRefs = (s: string) => s.replace(/\[ref=e\d+\]/g, "[ref=e]").replace(/root=e\d+/g, "root=e");

function imageOf(r: { image?: { data: string; mimeType: string }; text: string }) {
  if (r.image) return r.image;
  const j = view(r as any).json;
  return { data: j.dataBase64 as string, mimeType: j.mime as string };
}
function pngSize(b64: string) {
  const b = Buffer.from(b64, "base64");
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("tabs: new, list, select, close", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "tabs-agent" });
  const t1 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` });
  const t2 = await h.ok(c, "tabs", { action: "new", url: `${h.A}/article.html` });
  const id1 = view(t1).json.tabId;
  const id2 = view(t2).json.tabId;
  expect(id1).toBeTruthy();
  const list = view(await h.ok(c, "tabs", { action: "list" })).json;
  expect(list.tabs.map((t: any) => t.tabId)).toEqual([id1, id2]);
  expect(list.tabs.find((t: any) => t.active).tabId).toBe(id2);
  await h.ok(c, "tabs", { action: "select", tabId: id1 });
  const snap = await h.ok(c, "page.snapshot");
  expect(view(snap).all).toContain("Fixtures home");
  await h.ok(c, "tabs", { action: "close", tabId: id2 });
  expect(view(await h.ok(c, "tabs", { action: "list" })).json.tabs).toHaveLength(1);
  const groups = await h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
  expect(groups.some((g) => (g ?? "").includes("tabs-agent"))).toBe(true);
});

test("navigation: goto, back, forward, reload report navigation", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const g = view(await h.ok(c, "nav.goto", { url: `${h.A}/article.html` }));
  expect(g.json.navigation?.url ?? g.json.url).toContain("/article.html");
  expect(view(await h.ok(c, "nav.back")).all).toContain("/index.html");
  expect(view(await h.ok(c, "nav.forward")).all).toContain("/article.html");
  expect(view(await h.ok(c, "nav.reload")).all).toContain("Article");
  const ni = await h.ok(c, "nav.goto", { url: `${h.A}/network.html`, waitUntil: "networkidle" });
  expect(view(ni).all).toContain("Network");
});

test("nav.wait: selector, text, url substring and /regex/, networkidle, fn, TIMEOUT, BAD_REQUEST", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: true });
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/wait.html` });
  await h.ok(c, "nav.wait", { for: "selector", value: "#late" });
  await h.ok(c, "nav.wait", { for: "text", value: "Content arrived" });
  await h.ok(c, "nav.wait", { for: "url", value: "step=2" });
  await h.ok(c, "nav.wait", { for: "url", value: "/wait\\.html\\?step=\\d$/" });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await h.ok(c, "nav.wait", { for: "load" });
  await h.ok(c, "nav.wait", { for: "fn", value: "document.querySelectorAll('button').length === 1" });
  const to = await h.call(c, "nav.wait", { for: "text", value: "never appears", timeout: 400 });
  expect(to.isError).toBe(true);
  expect(to.text).toContain("TIMEOUT");
  expect(to.text).toContain("never appears");
  const bad = await h.call(c, "nav.wait", { for: "url", value: "/([a-/" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("BAD_REQUEST");
});

test("page.find: label ref is clickable, role+name, css, xpath, text, empty, truncated", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/wait.html` });
  const byLabel = view(await h.ok(c, "page.find", { by: "label", value: "Query" })).json;
  expect(byLabel.matches).toHaveLength(1);
  expect(byLabel.matches[0].ref).toMatch(/^e\d+$/);
  await h.ok(c, "act.click", { ref: byLabel.matches[0].ref });
  await h.ok(c, "act.type", { text: "hello" });
  expect(view(await h.ok(c, "page.snapshot")).snap).toContain('value="hello"');

  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const role = view(await h.ok(c, "page.find", { by: "role", value: "heading", name: "Details" })).json;
  expect(role.matches.map((m: any) => m.name)).toEqual(["Details"]);
  expect(view(await h.ok(c, "page.find", { by: "css", value: "li" })).json.matches).toHaveLength(2);
  expect(view(await h.ok(c, "page.find", { by: "xpath", value: "//h1" })).json.matches[0].name).toContain("Tab Agent Story");
  expect(view(await h.ok(c, "page.find", { by: "text", value: "forms" })).json.matches[0].role).toBe("link");
  const none = view(await h.ok(c, "page.find", { by: "text", value: "no such text anywhere" })).json;
  expect(none.matches).toEqual([]);

  await h.ok(c, "nav.goto", { url: `${h.A}/list500.html` });
  const many = view(await h.ok(c, "page.find", { by: "role", value: "link" })).json;
  expect(many.matches).toHaveLength(20);
  expect(many.truncated).toBe(true);
  // a found node keeps its ref in the next snapshot
  const btn = view(await h.ok(c, "page.find", { by: "role", value: "button", name: "After the list" })).json.matches[0].ref;
  expect(view(await h.ok(c, "page.snapshot")).snap).toContain(`button "After the list" [ref=${btn}]`);
});

test("page.text / page.markdown", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/article.html` });
  const md = view(await h.ok(c, "page.markdown")).all;
  expect(md).toContain("# The Tab Agent Story");
  expect(md).toContain("**browse**");
  expect(md).toContain("- Fast");
  expect(view(await h.ok(c, "page.text")).all).toContain("The Tab Agent Story");
});

test("snapshot goldens, masking, budgets, root, REF_STALE after navigation and across tabs", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  for (const page of ["index", "form", "login", "modal", "checkout"]) {
    await h.ok(c, "nav.goto", { url: `${h.A}/${page}.html` });
    const s = view(await h.ok(c, "page.snapshot")).snap;
    const golden = readFileSync(join(GOLDENS, `${page}.interactive.txt`), "utf8").trimEnd();
    expect(normRefs(s).trimEnd(), `golden ${page}`).toBe(normRefs(golden));
    expect(tokens(s)).toBeLessThanOrEqual(1500);
  }
  // D18 masking
  await h.ok(c, "nav.goto", { url: `${h.A}/login.html` });
  const login = view(await h.ok(c, "page.snapshot")).snap;
  expect(login).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
  expect(login).toMatch(/textbox "Card number" \[ref=e\d+\] value="••••"/);
  expect(login).not.toContain("hunter2");
  expect(login).not.toContain("4111");

  // prompt-injection text only appears in full mode, inside page data
  await h.ok(c, "nav.goto", { url: `${h.A}/delay.html` });
  await h.ok(c, "nav.wait", { for: "text", value: "Ready now" });
  const full = await h.ok(c, "page.snapshot", { mode: "full" });
  expect(view(full).snap).toContain("Ignore previous instructions");
  expect(full.text).toMatch(/<<<PAGE_DATA|<untrusted-page-content>/);

  // maxTokens hard stop
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const tiny = view(await h.ok(c, "page.snapshot", { maxTokens: 40 }));
  expect(tiny.json.truncated).toBe(true);
  expect(tokens(tiny.snap)).toBeLessThanOrEqual(40);
  expect(tiny.snap).toMatch(/… truncated, \d+ more nodes; narrow with root=<ref>/);

  // root= a ref minted by page.find (full mode shows the table text)
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const table = view(await h.ok(c, "page.find", { by: "css", value: "#t" })).json.matches[0].ref;
  const sub = view(await h.ok(c, "page.snapshot", { root: table, mode: "full" })).snap;
  expect(sub).toContain("Apple");
  expect(sub).not.toContain("Next");

  // a ref from before nav.goto is stale afterwards
  const next = refIn(view(await h.ok(c, "page.snapshot")).snap, /link "Next"/);
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const stale = await h.call(c, "act.click", { ref: next });
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("REF_STALE");

  // a ref used with another tab is stale
  const counter = refIn(view(await h.ok(c, "page.snapshot")).snap, /Click me/);
  const other = view(await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  const cross = await h.call(c, "act.click", { ref: counter, tabId: other });
  expect(cross.text).toContain("REF_STALE");
  await h.ok(c, "tabs", { action: "close", tabId: other });
});

test("snapshot diff: diff=true without and with a baseline; action diffs", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const first = view(await h.ok(c, "page.snapshot", { diff: true }));
  expect(first.json.full).toBe(true);
  expect(first.snap).toContain('button "Click me"');
  const btn = refIn(first.snap, /Click me/);
  const r = view(await h.ok(c, "act.click", { ref: btn }));
  expect(r.json.snapshotDiff).toMatch(/^~ - button "Clicked 1 times" \[ref=e\d+\]/m);
  const none = view(await h.ok(c, "page.snapshot", { diff: true }));
  expect(none.json.diff).toBe(true);
  expect(none.snap).toContain("(no changes)");
});

test("500-row list collapses under budget; root expands the container", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/list500.html` });
  const s = view(await h.ok(c, "page.snapshot"));
  expect(tokens(s.snap)).toBeLessThanOrEqual(6000);
  expect(s.snap).toContain('button "After the list"');
  const m = s.snap.match(/… (\d+) more listitem items, expand with root=(e\d+)/);
  expect(m).toBeTruthy();
  expect(s.snap).not.toContain("Row number 250");
  const sub = view(await h.ok(c, "page.snapshot", { root: m![2], maxTokens: 20000 })).snap;
  expect(sub).toContain('link "Row number 250"');
});

test("screenshots: viewport, full, ref, jpeg, 16000px cap, marks", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const vp = pngSize(imageOf(await h.ok(c, "page.screenshot")).data);
  expect(vp.w).toBeGreaterThan(500);
  const full = await h.ok(c, "page.screenshot", { target: "full" });
  expect(pngSize(imageOf(full).data).h).toBeGreaterThan(100);
  const jpg = imageOf(await h.ok(c, "page.screenshot", { target: "full", format: "jpeg", quality: 50 }));
  expect(jpg.mimeType).toBe("image/jpeg");
  expect(Buffer.from(jpg.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  const snap = view(await h.ok(c, "page.snapshot")).snap;
  const link = refIn(snap, /link "Next"/);
  const el = pngSize(imageOf(await h.ok(c, "page.screenshot", { target: "ref", ref: link })).data);
  expect(el.w).toBeLessThan(200);
  expect(el.h).toBeLessThan(60);

  await h.ok(c, "nav.goto", { url: `${h.A}/tall.html` });
  const tall = await h.ok(c, "page.screenshot", { target: "full" });
  expect(pngSize(imageOf(tall).data).h).toBeLessThanOrEqual(16000);
  expect(view(tall).all).toContain("capped at 16000px");

  // marks label only refs from the shared table: the snapshot's refs are unchanged
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const before = view(await h.ok(c, "page.snapshot")).snap;
  const mk = await h.ok(c, "page.screenshot", { marks: true });
  expect(imageOf(mk).data.length).toBeGreaterThan(1000);
  const after = view(await h.ok(c, "page.snapshot")).snap;
  expect(after).toBe(before);
  const clickMe = refIn(after, /Click me/);
  await h.ok(c, "act.click", { ref: clickMe });
  expect(view(await h.ok(c, "page.snapshot")).snap).toContain("Clicked 1 times");
  // the overlay never shows up in snapshots
  expect(after).not.toContain("tabagent");
});
