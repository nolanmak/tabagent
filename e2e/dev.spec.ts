import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("network + console capture", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/network.html` });
  const s = await h.ok(c, "page.snapshot");
  const wait = h.ok(c, "network.waitFor", { url: "/api/data.json", timeout: 10000 });
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /Load data/) });
  const w = await wait;
  expect(w.json.status).toBe(200);
  const list = await h.ok(c, "network.list", { url: "data.json" });
  expect(list.json.requests[0].status).toBe(200);
  const got = await h.ok(c, "network.get", { requestId: list.json.requests[0].requestId });
  expect(got.text).toContain("alpha");
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /Log error/) });
  const cons = await h.ok(c, "console.list", { level: "error" });
  expect(cons.text).toContain("boom happened");
  const all = await h.ok(c, "console.list");
  expect(all.text).toContain("loaded 3");
});

test("dialogs: confirm accept/dismiss and prompt text", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/dialog.html` });
  const s = await h.ok(c, "page.snapshot");
  const r = await h.ok(c, "act.click", { ref: Harness.ref(s.text, /Ask confirm/) });
  expect(r.json.dialog.type).toBe("confirm");
  expect(r.json.dialog.message).toBe("Really do it?");
  const blocked = await h.call(c, "page.snapshot");
  expect(blocked.text).toContain("dialog.handle");
  await h.ok(c, "dialog.handle", { accept: true });
  expect((await h.ok(c, "page.text", {})).text).toContain("confirmed");
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /Ask confirm/) });
  await h.ok(c, "dialog.handle", { accept: false });
  expect((await h.ok(c, "page.text", {})).text).toContain("cancelled");
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /Ask prompt/) });
  await h.ok(c, "dialog.handle", { accept: true, promptText: "Ada" });
  expect((await h.ok(c, "page.text", {})).text).toContain("name=Ada");
  const none = await h.call(c, "dialog.handle", { accept: true });
  expect(none.text).toContain("No dialog");
});

test("js.eval, cookies.get, storage.get ask the user first", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/storage.html` });
  const ev = await h.answerPrompt("once", () => h.ok(c, "js.eval", { expression: "document.title + ':' + (1+2)" }));
  expect(ev.title).toContain("run JavaScript");
  expect((ev.result as any).text).toContain("Storage:3");
  const iso = await h.answerPrompt("once", () => h.ok(c, "js.eval", { expression: "typeof window.n", world: "isolated" }));
  expect((iso.result as any).text).toContain("undefined");
  const ck = await h.answerPrompt("once", () => h.ok(c, "cookies.get"));
  expect((ck.result as any).text).toContain("abc123");
  const st = await h.answerPrompt("once", () => h.ok(c, "storage.get", { kind: "local" }));
  expect((st.result as any).text).toContain("dark");
  const denied = await h.answerPrompt("deny", () => h.call(c, "js.eval", { expression: "1" }));
  expect((denied.result as any).text).toContain("PERMISSION_DENIED");
});

// iframe + shadow DOM coverage moved to frames.spec.ts (#19)
