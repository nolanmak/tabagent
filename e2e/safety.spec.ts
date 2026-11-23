import WebSocket from "ws";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

/** M1 has no page.text (#10): page text is checked with nav.wait for=text. */
const hasText = async (h: Harness, c: any, t: string, timeout = 3000) => !(await h.call(c, "nav.wait", { for: "text", value: t, timeout })).isError;

test("D17 interim policy: browser pages and the Web Store are hard-denied; other sites need no prompt", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "interim" });
  // no site policies and no prompts before #12: any web page is allowed
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  await h.ok(c, "nav.goto", { url: `${h.B}/index.html` });
  for (const url of ["chrome://settings", "https://chromewebstore.google.com/"]) {
    const r = await h.call(c, "nav.goto", { url });
    expect(r.isError, url).toBe(true);
    expect(r.text, url).toContain("PERMISSION_DENIED");
  }
  // devAllowSensitive never unlocks a hard-denied page
  await h.trustFixtures({ devAllowSensitive: true });
  expect((await h.call(c, "nav.goto", { url: "chrome://settings" })).text).toContain("PERMISSION_DENIED");
  const perm = await h.ok(c, "session.permissions", { url: `${h.A}/index.html` });
  expect(perm.json.level).toBe("full");
  expect((await h.ok(c, "session.permissions", { url: "chrome://settings" })).json.level).toBe("deny");
  await h.ok(c, "session.end");
});

test("D17/D18 interim gates: a password-form submit, a risky click and nav.wait fn are refused unless devAllowSensitive", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "gated" });
  await h.ok(c, "nav.goto", { url: `${h.A}/login.html` });
  const s = await h.ok(c, "page.snapshot");
  await h.ok(c, "act.type", { ref: Harness.ref(s.text, /textbox "Username"/), text: "neo" });
  await h.ok(c, "act.type", { ref: Harness.ref(s.text, /textbox "Password"/), text: "hunter2-secret" });
  // (a) Enter inside the form and a click on its submit control
  const enter = await h.call(c, "act.press", { key: "Enter", ref: Harness.ref(s.text, /textbox "Password"/) });
  expect(enter.text).toContain("PERMISSION_DENIED");
  const click = await h.call(c, "act.click", { ref: Harness.ref(s.text, /button "Sign in"/) });
  expect(click.text).toContain("PERMISSION_DENIED");
  expect(click.text).toContain("password");
  expect(await hasText(h, c, "NOT SUBMITTED")).toBe(true);
  // the password never shows up in the snapshot
  expect((await h.ok(c, "page.snapshot")).text).not.toContain("hunter2-secret");
  // (c) nav.wait fn; nav.wait without fn is not gated
  await h.ok(c, "nav.wait", { for: "load", timeout: 5000 });
  const fn = await h.call(c, "nav.wait", { for: "fn", value: "true", timeout: 2000 });
  expect(fn.text).toContain("PERMISSION_DENIED");
  // (b) a delete click
  await h.ok(c, "nav.goto", { url: `${h.A}/checkout.html` });
  const s2 = await h.ok(c, "page.snapshot");
  const del = Harness.ref(s2.text, /Delete account/);
  const refused = await h.call(c, "act.click", { ref: del });
  expect(refused.text).toContain("PERMISSION_DENIED");
  expect(await hasText(h, c, "UNPAID")).toBe(true);
  // the developer setting lets gated effects through
  await h.trustFixtures({ devAllowSensitive: true });
  await h.ok(c, "act.click", { ref: del });
  expect(await hasText(h, c, "DELETED")).toBe(true);
  await h.ok(c, "nav.wait", { for: "fn", value: "true", timeout: 2000 });
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
