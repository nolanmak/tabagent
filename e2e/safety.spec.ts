import WebSocket from "ws";
import { test, expect } from "./fixture";

test.describe.configure({ mode: "serial" });

test("D17 interim policy: own tabs only, browser pages and the Web Store refused", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const a = await h.mcp({ label: "agent-a" });
  const b = await h.mcp({ label: "agent-b" });
  const ta = (await h.ok(a, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  // another session's tab
  for (const [tool, args] of [
    ["nav.reload", { tabId: ta }],
    ["nav.goto", { tabId: ta, url: `${h.A}/p/x` }],
    ["tabs", { action: "select", tabId: ta }],
    ["tabs", { action: "close", tabId: ta }],
  ] as const) {
    const r = await h.call(b, tool, args);
    expect(r.text, `${tool} ${JSON.stringify(args)}`).toMatch(/^TAB_BUSY/);
  }
  // a tab nobody owns (the user's own tab)
  const user = await h.ctx.newPage();
  await user.goto(`${h.A}/p/user`);
  const userTab = await h.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${h.A}/p/user`);
  const r = await h.call(a, "nav.reload", { tabId: userTab });
  expect(r.text).toMatch(/^NOT_FOUND/);
  expect(user.url()).toBe(`${h.A}/p/user`);
  // no tabs yet -> NOT_FOUND with the hint
  const fresh = await h.mcp({ label: "agent-c" });
  expect((await h.call(fresh, "nav.back")).text).toMatch(/^NOT_FOUND: This session has no tabs yet\nHint: call tabs new/);
  // hard denylist, even with devAllowSensitive on
  await h.trustFixtures();
  for (const url of ["chrome://settings", "chrome-extension://pjpcgiijlaafoafgibplighdenoandid/sidepanel.html", "https://chromewebstore.google.com/"]) {
    const d = await h.call(a, "nav.goto", { url });
    expect(d.text, url).toMatch(/^PERMISSION_DENIED: TabAgent cannot act on browser pages/);
    const n = await h.call(a, "tabs", { action: "new", url });
    expect(n.text, url).toMatch(/^PERMISSION_DENIED/);
  }
  expect((await h.ok(a, "tabs", { action: "list" })).json.tabs.map((t: any) => t.url)).toEqual([`${h.A}/index.html`]);
  await user.close();
});

test("bridge rejects web pages: HTTP Origin, page-origin WebSocket, Host header", async ({ h }) => {
  await h.trustFixtures();
  const r = await fetch(`http://127.0.0.1:${h.port}/v1/status`, { headers: { origin: "http://evil.example", authorization: "Bearer x" } });
  expect(r.status).toBe(403);
  // a real page-origin WebSocket from the fixture page fails
  const page = await h.ctx.newPage();
  await page.goto(`${h.A}/index.html`);
  const fromPage = await page.evaluate(
    (port) =>
      new Promise<string>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
        ws.onopen = () => res("open");
        ws.onerror = () => res("error");
        ws.onclose = () => res("closed");
      }),
    h.port,
  );
  expect(fromPage).not.toBe("open");
  await page.close();
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: "http://evil.example" });
  const code = await new Promise<string>((res) => {
    ws.on("unexpected-response", (_q, resp) => res(String(resp.statusCode)));
    ws.on("error", (e) => res("error:" + e.message));
    ws.on("open", () => res("open"));
  });
  expect(code).not.toBe("open");
  const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  const msg = await new Promise<string>((res) => {
    ws2.on("open", () => ws2.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "x", secret: "wrong" })));
    ws2.on("message", (d) => res(String(d)));
    ws2.on("error", (e) => res("error:" + e.message));
  });
  expect(msg).toContain("UNAUTHORIZED");
  const { request } = await import("node:http");
  const status = await new Promise<number>((res) => {
    const rq = request({ host: "127.0.0.1", port: h.port, path: "/v1/health", headers: { host: "evil.example" } }, (resp) => res(resp.statusCode ?? 0));
    rq.end();
  });
  expect(status).toBe(403);
});

test("D7: content scripts cannot read the secret from storage.local", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const t = await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` });
  const res = await h.sw.evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const v = await chrome.storage.local.get(null);
          return JSON.stringify(v);
        } catch (e) {
          return "error:" + String((e as Error).message);
        }
      },
    });
    return r.result as string;
  }, t.json.tabId);
  expect(res).not.toContain('"secret"');
  expect((await h.sw.evaluate(() => (globalThis as any).__tabagent.getSettings())).secret).toBeTruthy();
});

test("the service worker restarts and reconnects without re-pairing", async ({ h }) => {
  const c = await h.mcp();
  const t = (await h.ok(c, "tabs", { action: "new", url: `${h.A}/index.html` })).json.tabId;
  const count = (re: RegExp) => h.bridgeLog.match(re)?.length ?? 0;
  const paired = count(/Paired with extension/g);
  const connects = count(/Extension connected/g);
  // Stop the extension's service worker (as Chrome does when it idles), then wake it from an extension page.
  const internals = await h.ctx.newPage();
  await internals.goto("chrome://serviceworker-internals/");
  await internals.getByText("Stop", { exact: true }).first().click();
  await expect.poll(() => internals.evaluate(() => document.body.innerText.includes("Running Status: STOPPED")), { timeout: 10000 }).toBe(true);
  await expect.poll(() => count(/Extension disconnected/g), { timeout: 10000 }).toBeGreaterThan(0);
  await internals.close();
  const panel = await h.openPanel();
  await panel.waitForFunction(() => document.getElementById("status")?.textContent === "Connected", null, { timeout: 30000 });
  await panel.close();
  expect(count(/Extension connected/g)).toBe(connects + 1);
  expect(count(/Paired with extension/g)).toBe(paired);
  // tab ownership came back from chrome.storage.session (D11)
  const list = (await h.ok(c, "tabs", { action: "list" })).json.tabs;
  expect(list.map((x: any) => x.tabId)).toContain(t);
  expect((await h.ok(c, "nav.reload", { tabId: t })).json.url).toBe(`${h.A}/index.html`);
});
