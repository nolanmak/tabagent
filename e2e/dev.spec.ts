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

test("iframes (same + cross origin) and shadow DOM", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/frames.html?cross=${encodeURIComponent(h.B)}` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await new Promise((r) => setTimeout(r, 500));
  const s = await h.ok(c, "page.snapshot");
  expect(s.text).toContain('iframe "Same origin frame"');
  expect(s.text).toContain("Frame button same");
  expect(s.text).toContain("Frame button cross");
  const crossBtn = Harness.ref(s.text, /button "Frame button cross"/);
  const r = await h.ok(c, "act.click", { ref: crossBtn });
  expect(r.text).toContain("pressed in cross");
  const sameBtn = Harness.ref(s.text, /button "Frame button same"/);
  const r2 = await h.ok(c, "act.click", { ref: sameBtn });
  expect(r2.text).toContain("pressed in same");
  const crossInput = s.text.split("\n").filter((l) => /textbox "Frame input"/.test(l))[1].match(/ref=(e\d+)/)![1];
  await h.ok(c, "act.fill", { ref: crossInput, value: "typed across origins" });
  const f = await h.ok(c, "page.find", { css: "#fi" });
  expect(f.text).toContain("frame");

  await h.ok(c, "nav.goto", { url: `${h.A}/shadow.html` });
  const sh = await h.ok(c, "page.snapshot");
  const si = Harness.ref(sh.text, /textbox "Shadow input"/);
  await h.ok(c, "act.fill", { ref: si, value: "deep" });
  await h.ok(c, "act.click", { ref: Harness.ref(sh.text, /button "Shadow button"/) });
  expect((await h.ok(c, "page.text", {})).text).toContain("shadow:deep");
  const fs = await h.ok(c, "page.find", { css: "#sb" });
  expect(fs.text).toContain("Shadow button");
});
