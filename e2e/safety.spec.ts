// D17 interim policy (#3), D2 HTTP checks and D7 secret storage, through a real MCP client.
import WebSocket from "ws";
import { test, expect } from "./fixture";

test.describe.configure({ mode: "serial" });

test("D17: hard-denied pages are refused and cannot be unlocked", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  for (const url of ["chrome://settings", "https://chromewebstore.google.com/"]) {
    const r = await h.call(c, "nav.goto", { url });
    expect(r.text, url).toContain("PERMISSION_DENIED");
  }
  expect((await h.ok(c, "session.permissions", { url: "chrome://settings" })).json.level).toBe("deny");
  // an ordinary fixture page needs no grant
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  expect((await h.ok(c, "session.permissions")).json).toMatchObject({ level: "full", sensitiveAllowed: true });
  await h.ok(c, "session.end");
});

test("D17: static gated effects are refused in the router unless devAllowSensitive (nav.wait fn)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const fn = await h.withGatesOn(() => h.call(c, "nav.wait", { for: "fn", value: "true", timeout: 2000 }));
  expect(fn.isError).toBe(true);
  expect(fn.text).toContain("PERMISSION_DENIED");
  expect(fn.text).toContain("devAllowSensitive");
  expect((await h.ok(c, "nav.wait", { for: "fn", value: "true", timeout: 2000 })).json.ok).toBe(true);
  await h.ok(c, "session.end");
});

test("bridge rejects web pages: HTTP Origin, WebSocket origin, Host header", async ({ h }) => {
  await h.trustFixtures();
  const r = await fetch(`http://127.0.0.1:${h.port}/v1/status`, { headers: { origin: "http://evil.example", authorization: "Bearer x" } });
  expect(r.status).toBe(403);
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: "http://evil.example" });
  const code = await new Promise<string>((res) => {
    ws.on("unexpected-response", (_q, resp) => res(String(resp.statusCode)));
    ws.on("error", (e) => res("error:" + e.message));
    ws.on("open", () => res("open"));
  });
  expect(code).not.toBe("open");
  const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  const msg = await new Promise<string>((res) => {
    ws2.on("open", () => ws2.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "x", secret: "wrong", version: "x", extensionId: "x" })));
    ws2.on("message", (d) => res(String(d)));
    ws2.on("error", (e) => res("error:" + e.message));
  });
  expect(msg).toContain("UNAUTHORIZED");
  const { request } = await import("node:http");
  const status = await new Promise<number>((res) => {
    const rq = request({ host: "127.0.0.1", port: h.port, path: "/health", headers: { host: "evil.example" } }, (resp) => res(resp.statusCode ?? 0));
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
});
