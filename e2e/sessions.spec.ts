import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("two agents at once: separate tab groups, TAB_BUSY on each other's tabs", async ({ h }) => {
  await h.trustFixtures();
  const a = await h.mcp({ label: "alpha" });
  const b = await h.mcp({ label: "beta" });
  const [ra, rb] = await Promise.all([h.ok(a, "tabs", { action: "new", url: `${h.A}/index.html` }), h.ok(b, "tabs", { action: "new", url: `${h.A}/article.html` })]);
  // concurrent work
  const [sa, sb] = await Promise.all([h.ok(a, "page.snapshot"), h.ok(b, "page.snapshot")]);
  expect(sa.json.title).toBe("Fixtures home");
  expect(sb.json.title).toBe("Article");
  const busy = await h.call(a, "page.snapshot", { tabId: rb.json.tabId });
  expect(busy.text).toContain("TAB_BUSY");
  const groups = await h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
  expect(groups).toEqual(expect.arrayContaining(["🤖 alpha", "🤖 beta"]));
  const info = await h.ok(a, "session.info");
  expect(info.json.label).toBe("alpha");
  expect(info.json.tabs.some((t: any) => t.tabId === ra.json.tabId)).toBe(true);
  // ending a session collapses its group
  await h.ok(b, "session.end");
  const g2 = await h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => ({ t: g.title, c: g.collapsed })));
  expect(g2.find((g) => g.t === "✓ beta")?.c).toBe(true);
  // closing the MCP client ends its session too
  await a.close();
  await expect.poll(async () => h.sw.evaluate(() => (globalThis as any).__tabagent.listSessions().map((s: any) => s.label)), { timeout: 5000 }).not.toContain("alpha");
});

test("tabs attach adopts a user tab only after the user agrees; session end ungroups it and leaves it open", async ({ h }) => {
  await h.trustFixtures();
  const userTab = await h.ctx.newPage();
  await userTab.goto(`${h.A}/article.html`);
  const tabId = await h.sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, `${h.A}/article.html`);
  const c = await h.mcp({ label: "adopter" });
  const notMine = await h.call(c, "page.snapshot", { tabId });
  expect(notMine.text).toContain("not in this session");
  const d = await h.answerPrompt("deny", () => h.call(c, "tabs", { action: "attach", tabId }));
  expect(d.title).toContain("take over your tab");
  expect(d.prompt.sensitive.category).toBe("f");
  expect((d.result as any).text).toContain("PERMISSION_DENIED");
  // f is never pre-approvable: devAllowSensitive (on via trustFixtures) does not skip it
  await h.answerPrompt("once", () => h.ok(c, "tabs", { action: "attach", tabId }));
  const s = await h.ok(c, "page.snapshot", { tabId });
  expect(s.json.title).toBe("Article");
  await expect.poll(() => h.sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabId)).toBeGreaterThan(-1);
  await h.ok(c, "session.end");
  await expect
    .poll(() =>
      h.sw.evaluate(async (id) => {
        const t = await chrome.tabs.get(id).catch(() => null);
        return t ? { open: true, groupId: t.groupId } : { open: false, groupId: -2 };
      }, tabId),
    )
    .toEqual({ open: true, groupId: -1 });
  await userTab.close();
});

test("tabs attach with no tabId adopts the active tab of the last-focused window", async ({ h }) => {
  await h.trustFixtures();
  const userTab = await h.ctx.newPage();
  await userTab.goto(`${h.A}/table.html`);
  await userTab.bringToFront();
  const c = await h.mcp({ label: "adopt-active" });
  const r = await h.answerPrompt("once", () => h.ok(c, "tabs", { action: "attach" }));
  expect((r.result as any).text).toContain("table.html");
  await h.ok(c, "session.end");
  await userTab.close();
});

test("tabs select changes the session's active tab without activating it; tabs list shows own tabs only", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "selector" });
  const t1 = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  const t2 = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/article.html` })).json.tabId;
  const activeBefore = await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  await h.ok(c, "tabs", { action: "select", tabId: t1 });
  const s = await h.ok(c, "page.snapshot");
  expect(s.json.title).toBe("Fixtures home");
  const activeAfter = await h.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  expect(activeAfter).toBe(activeBefore);
  expect(activeAfter).not.toBe(t1);
  const other = await h.mcp({ label: "other-lister" });
  await h.ok(other, "tabs", { action: "new" });
  const list = await h.ok(c, "tabs", { action: "list" });
  const ids = (list.json.tabs as any[]).map((t) => t.tabId).sort();
  expect(ids).toEqual([t1, t2].sort());
  await h.ok(c, "session.end");
  await h.ok(other, "session.end");
});

test("tabs opened by a session tab join the session; a tab dragged out of the group leaves", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "opener" });
  await h.ok(c, "nav.goto", { url: `${h.A}/popup.html` });
  const s = await h.ok(c, "page.snapshot");
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /link "Open child"/) });
  await expect.poll(async () => ((await h.ok(c, "tabs", { action: "list" })).json.tabs as any[]).length, { timeout: 10000 }).toBe(2);
  const tabs = (await h.ok(c, "tabs", { action: "list" })).json.tabs as any[];
  const child = tabs.find((t) => String(t.url).includes("/p/child"));
  expect(child).toBeTruthy();
  // the user drags it out of the group
  await h.sw.evaluate(async (id) => chrome.tabs.ungroup(id), child.tabId);
  await expect.poll(async () => ((await h.ok(c, "tabs", { action: "list" })).json.tabs as any[]).length, { timeout: 5000 }).toBe(1);
  const gone = await h.call(c, "page.snapshot", { tabId: child.tabId });
  expect(gone.text).toContain("not in this session");
  await h.ok(c, "session.end");
});

test("ownership is persisted in storage.session", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "survivor" });
  const t = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  const stored = await h.sw.evaluate(async () => (await chrome.storage.session.get("sessions")).sessions);
  expect(JSON.stringify(stored)).toContain("survivor");
  expect(JSON.stringify(stored)).toContain(String(t));
  await h.ok(c, "session.end");
});

test("MCP over Streamable HTTP with bearer auth + profiles", async ({ h }) => {
  await h.trustFixtures();
  const secret = JSON.parse(readFileSync(join(h.home, "config.json"), "utf8")).secret;
  const mk = async (profile: string) => {
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp?profile=${profile}`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } });
    const c = new Client({ name: "http-agent", version: "1" });
    await c.connect(t);
    return c;
  };
  const core = await mk("core");
  const tools = (await core.listTools()).tools.map((t) => t.name);
  expect(tools).toContain("nav_goto");
  expect(tools).not.toContain("js_eval");
  expect(tools.length).toBeLessThanOrEqual(15);
  const full = await mk("full");
  expect((await full.listTools()).tools.length).toBeGreaterThan(40);
  const r: any = await core.callTool({ name: "nav_goto", arguments: { url: `${h.A}/index.html` } });
  expect(r.content[0].text).toContain("Fixtures home");
  const groups = await h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
  expect(groups).toContain("🤖 http-agent");
  await core.close();
  await full.close();
  const unauth = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(unauth.status).toBe(401);
});

test("lite mode (no debugger): snapshot, click, fill, form.fill", async ({ h }) => {
  await h.trustFixtures({ sites: { [h.B]: { lite: true } } });
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.B}/form.html` });
  const info = await h.ok(c, "session.info");
  expect(info.json.tabs.find((t: any) => t.active).mode).toBe("lite");
  const s = await h.ok(c, "page.snapshot");
  // D22: lite refs come from the same table as CDP refs
  expect(s.text).toMatch(/\[ref=e\d+\]/);
  const email = Harness.ref(s.text, /textbox "Email address"/);
  await h.ok(c, "act.fill", { ref: email, value: "lite@example.com" });
  await h.ok(c, "form.fill", { fields: { Country: "Mexico", "Subscribe to newsletter": true, Plan: "Free" } });
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /button "Create account"/) });
  const txt = (await h.ok(c, "page.text", {})).text;
  expect(txt).toContain('"email":"lite@example.com"');
  expect(txt).toContain('"country":"mx"');
  expect(txt).toContain('"subscribe":true');
  // #21: registry lite=unsupported tools return UNSUPPORTED without touching the page
  const net = await h.call(c, "network.list");
  expect(net.text).toContain("UNSUPPORTED");
  // viewport capture needs the tab to be the visible one; TabAgent never focuses it (D10)
  const shot = await h.call(c, "page.screenshot");
  expect(!!shot.image || shot.text.includes("UNSUPPORTED")).toBe(true);
  // no debugger attached to the lite tab
  const liteTab = info.json.tabs.find((t: any) => t.active).tabId;
  const attached: number[] = await h.sw.evaluate(() => (globalThis as any).__tabagent.attachedTabs());
  expect(attached).not.toContain(liteTab);
  await h.trustFixtures();
});
