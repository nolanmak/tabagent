import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("unknown site asks: deny, allow once, always", async ({ h }) => {
  await h.setPolicies({}, { sensitiveAllowed: {}, paused: false });
  const c = await h.mcp({ label: "asker" });
  const d = await h.answerPrompt("deny", () => h.call(c, "nav.goto", { url: `${h.A}/index.html` }));
  expect(d.title).toContain(`asker wants to read ${h.A}`);
  expect((d.result as any).text).toContain("PERMISSION_DENIED");
  const o = await h.answerPrompt("once", () => h.ok(c, "nav.goto", { url: `${h.A}/index.html` }));
  expect((o.result as any).json.title).toBe("Fixtures home");
  // once = this session: no second prompt for read
  await h.ok(c, "page.snapshot");
  // acting needs a higher level -> asks again; choose always
  const s = await h.ok(c, "page.snapshot");
  const a = await h.answerPrompt("always", () => h.ok(c, "act.click", { ref: Harness.ref(s.text, /Click me/) }));
  expect(a.title).toContain("act on");
  const pol = await h.sw.evaluate(async () => (await (globalThis as any).__tabagent.getSettings()).policies);
  expect(pol[h.A]).toBe("act");
  // a different session still has no grant for B
  const c2 = await h.mcp({ label: "other" });
  const d2 = await h.answerPrompt("deny", () => h.call(c2, "nav.goto", { url: `${h.B}/index.html` }));
  expect((d2.result as any).text).toContain("PERMISSION_DENIED");
});

test("sensitive actions: payment + delete need confirmation", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ label: "shopper" });
  await h.ok(c, "nav.goto", { url: `${h.A}/checkout.html` });
  await h.ok(c, "form.fill", { fields: { "Card number": "4242 4242 4242 4242", "Name on card": "Neo" } });
  const s = await h.ok(c, "page.snapshot");
  const pay = Harness.ref(s.text, /button "Pay \$42\.00"/);
  const denied = await h.answerPrompt("deny", () => h.call(c, "act.click", { ref: pay }));
  expect(denied.title).toContain('click "Pay $42.00"');
  expect(denied.reasons).toContain("payment card");
  expect((denied.result as any).text).toContain("PERMISSION_DENIED");
  expect((await h.ok(c, "page.text", {})).text).toContain("UNPAID");
  const sub = await h.answerPrompt("deny", () => h.call(c, "form.submit", {}));
  expect((sub.result as any).text).toContain("PERMISSION_DENIED");
  const ok = await h.answerPrompt("once", () => h.ok(c, "act.click", { ref: pay }));
  void ok;
  expect((await h.ok(c, "page.text", {})).text).toContain("PAID");
  const del = Harness.ref(s.text, /Delete account/);
  const alw = await h.answerPrompt("always", () => h.ok(c, "act.click", { ref: del }));
  expect(alw.title).toContain("Delete account");
  // pre-approved now: no prompt
  await h.ok(c, "act.click", { ref: del });
  // Enter in a card form is also sensitive -> but site is pre-approved now
  const pre = await h.sw.evaluate(async () => (await (globalThis as any).__tabagent.getSettings()).sensitiveAllowed);
  expect(pre[h.A]).toBe(true);
});

test("denylist + restricted pages", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const r = await h.call(c, "nav.goto", { url: "https://accounts.google.com/" });
  expect(r.text).toContain("PERMISSION_DENIED");
  expect(r.text).toContain("denylist");
  const ch = await h.call(c, "nav.goto", { url: "chrome://settings" });
  expect(ch.text).toContain("PERMISSION_DENIED");
});

test("kill switch stops everything until resume", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const panel = await h.openPanel();
  await panel.click("#killBtn");
  await panel.waitForSelector("#resumeBtn:not([hidden])");
  const r = await h.call(c, "page.snapshot");
  expect(r.text).toContain("kill switch");
  await panel.click("#resumeBtn");
  await panel.waitForSelector("#killBtn:not([hidden])");
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  // activity feed shows calls
  await panel.reload();
  await panel.waitForSelector("#feed li");
  expect(await panel.textContent("#feed")).toContain("nav.goto");
  await panel.close();
});

test("scoped tokens: cap and site limits; audit log redacts", async ({ h }) => {
  await h.trustFixtures();
  const { execFileSync } = await import("node:child_process");
  const cli = join(process.cwd(), "packages/bridge/dist/cli.js");
  const env = { ...process.env, TABAGENT_HOME: h.home };
  const readTok = execFileSync(process.execPath, [cli, "token", "create", "--name", "reader", "--cap", "read"], { env }).toString().trim();
  const siteTok = execFileSync(process.execPath, [cli, "token", "create", "--name", "bonly", "--cap", "act", "--sites", "127.0.0.1"], { env }).toString().trim();
  // daemon reads tokens at start; restart not needed because the daemon shares the file? It loaded config at boot, so reload by REST call failing first.
  const call = (tok: string, tool: string, params: unknown) =>
    fetch(`http://127.0.0.1:${h.port}/v1/call/${tool}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ params }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  let r = await call(readTok, "nav.goto", { url: `${h.A}/index.html` });
  expect(r.status).toBe(200);
  const snap = await call(readTok, "page.snapshot", {});
  const ref = (snap.body.result.snapshot as string).match(/Click me" \[ref=(e\d+)/)![1];
  r = await call(readTok, "act.click", { ref });
  expect(r.status).toBe(403);
  expect(r.body.error.message).toContain('limited to "read"');
  r = await call(siteTok, "nav.goto", { url: `${h.A}/index.html` });
  expect(r.status).toBe(403);
  expect(r.body.error.message).toContain("not allowed on localhost");
  r = await call(siteTok, "nav.goto", { url: `${h.B}/index.html` });
  expect(r.status).toBe(200);
  r = await call("bogus", "nav.goto", { url: `${h.B}/index.html` });
  expect(r.status).toBe(401);
  // audit log
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/checkout.html` });
  await h.ok(c, "form.fill", { fields: { "Card number": "4242424242424242" } });
  const log = readFileSync(join(h.home, "audit.jsonl"), "utf8");
  expect(log).toContain('"tool":"form.fill"');
  expect(log).not.toContain("4242424242424242");
  expect(log).toContain("[redacted]");
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
  // an extension origin with a wrong secret gets UNAUTHORIZED
  const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  const msg = await new Promise<string>((res) => {
    ws2.on("open", () => ws2.send(JSON.stringify({ type: "hello", secret: "wrong", version: "x", extensionId: "x" })));
    ws2.on("message", (d) => res(String(d)));
    ws2.on("error", (e) => res("error:" + e.message));
  });
  expect(msg).toContain("UNAUTHORIZED");
  // DNS-rebinding defence: wrong Host header is refused
  const { request } = await import("node:http");
  const status = await new Promise<number>((res) => {
    const rq = request({ host: "127.0.0.1", port: h.port, path: "/health", headers: { host: "evil.example" } }, (resp) => res(resp.statusCode ?? 0));
    rq.end();
  });
  expect(status).toBe(403);
});
