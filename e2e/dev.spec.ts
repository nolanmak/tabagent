import { test, expect, Harness } from "./fixture";
import { payload } from "./payload";

test.describe.configure({ mode: "default" });

/** Dialogs reported by an action: envelope `dialogs` (D14), or the pre-D14 `dialog` field. */
const dialogsOf = (p: any) => p.dialogs ?? (p.dialog ? [p.dialog] : []);

test("network + console capture (#17)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/network.html` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  // a request made before the first network.* call is still listed
  const early = payload(await h.ok(c, "network.list", { url: "onload=1" }));
  expect(early.requests).toHaveLength(1);
  expect(Object.keys(early.requests[0]).sort()).toEqual(["id", "method", "ms", "size", "status", "type", "url"]);
  expect(early.requests[0].status).toBe(200);

  const s = (await h.ok(c, "page.snapshot")).text;
  const wait = h.ok(c, "network.waitFor", { url: "late=1", method: "POST", timeout: 10000 });
  await h.ok(c, "act.click", { ref: Harness.ref(s, /Post later/) });
  const w = payload(await wait);
  expect(w.request.method).toBe("POST");
  expect(w.request.status).toBe(200);

  await h.ok(c, "act.click", { ref: Harness.ref(s, /Load data/) });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  const list = payload(await h.ok(c, "network.list", { url: "/api/data.json", method: "GET", status: 200 }));
  expect(list.requests.length).toBeGreaterThanOrEqual(2);
  const plain = list.requests.find((r: any) => r.url.endsWith("/api/data.json"));
  const got = await h.answerPrompt("once", () => h.ok(c, "network.get", { id: plain.id }));
  const g = payload(got.result as any);
  expect(JSON.stringify(g.body)).toContain("alpha");
  expect(g.response.status).toBe(200);
  expect(Object.keys(g.request.headers).length).toBeGreaterThan(0);
  expect((await h.call(c, "network.get", { id: "n999999" })).text).toContain("NOT_FOUND");
  expect((await h.call(c, "network.waitFor", { url: "never-requested", timeout: 300 })).text).toContain("TIMEOUT");

  await h.ok(c, "act.click", { ref: Harness.ref(s, /Log error/) });
  const errs = payload(await h.ok(c, "console.list", { level: "error" }));
  expect(errs.messages.map((m: any) => m.text)).toContain("boom happened");
  const all = payload(await h.ok(c, "console.list"));
  expect(all.messages.map((m: any) => m.text)).toEqual(expect.arrayContaining(["page ready", "loaded 3"]));
  for (const m of all.messages) expect(Object.keys(m).sort()).toEqual(["level", "text", "ts"]);
  // kept across navigations, with a marker
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const after = payload(await h.ok(c, "console.list"));
  expect(after.messages.map((m: any) => m.text)).toContain("boom happened");
  expect(after.messages.some((m: any) => m.level === "marker")).toBe(true);
});

test("dialogs with the core profile (#27)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ profile: "core" });
  await h.ok(c, "nav.goto", { url: `${h.A}/dialog.html` });
  const s = (await h.ok(c, "page.snapshot")).text;

  const a = payload(await h.ok(c, "act.click", { ref: Harness.ref(s, /Show alert/) }));
  expect(dialogsOf(a)).toEqual([expect.objectContaining({ type: "alert", message: "Heads up" })]);
  expect(a.snapshotDiff).toBeUndefined();
  const blocked = await h.call(c, "page.snapshot");
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain("DIALOG_OPEN");
  expect(blocked.text).toContain("Heads up");
  await h.ok(c, "dialog.handle", { action: "accept" });

  await h.ok(c, "act.click", { ref: Harness.ref(s, /Ask confirm/) });
  const acc = payload(await h.ok(c, "dialog.handle", { action: "accept" }));
  expect(acc.dialog).toMatchObject({ type: "confirm", message: "Really do it?" });
  expect(payload(await h.ok(c, "page.markdown")).markdown).toContain("confirmed");
  await h.ok(c, "act.click", { ref: Harness.ref(s, /Ask confirm/) });
  await h.ok(c, "dialog.handle", { action: "dismiss" });
  expect(payload(await h.ok(c, "page.markdown")).markdown).toContain("cancelled");
  await h.ok(c, "act.click", { ref: Harness.ref(s, /Ask prompt/) });
  await h.ok(c, "dialog.handle", { action: "accept", promptText: "Ada" });
  expect(payload(await h.ok(c, "page.markdown")).markdown).toContain("name=Ada");

  const none = await h.call(c, "dialog.handle", { action: "accept" });
  expect(none.text).toContain("NOT_FOUND");

  // a dialog that opens with no command in flight is reported by the next command
  await h.ok(c, "act.click", { ref: Harness.ref(s, /Alert later/) });
  await new Promise((r) => setTimeout(r, 800));
  const next = await h.call(c, "page.snapshot");
  expect(next.text).toContain("DIALOG_OPEN");
  expect(next.text).toContain("Timer fired");
  await h.ok(c, "dialog.handle", { action: "dismiss" });
  await h.ok(c, "page.snapshot");
});

test("beforeunload: accept by default, ask-agent surfaces it", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp({ profile: "core" });
  await h.ok(c, "nav.goto", { url: `${h.A}/beforeunload.html` });
  let s = (await h.ok(c, "page.snapshot")).text;
  await h.ok(c, "act.type", { ref: Harness.ref(s, /textbox "Draft"/), text: "unsaved" });
  await h.ok(c, "act.click", { ref: Harness.ref(s, /link "Leave page"/) });
  await h.ok(c, "nav.wait", { for: "url", value: "/p/left" });

  await h.trustFixtures({ beforeUnload: "ask-agent", autoAcceptBeforeUnload: false });
  await h.ok(c, "nav.goto", { url: `${h.A}/beforeunload.html` });
  s = (await h.ok(c, "page.snapshot")).text;
  await h.ok(c, "act.type", { ref: Harness.ref(s, /textbox "Draft"/), text: "unsaved" });
  const r = payload(await h.ok(c, "act.click", { ref: Harness.ref(s, /link "Leave page"/) }));
  expect(dialogsOf(r)[0]?.type).toBe("beforeunload");
  await h.ok(c, "dialog.handle", { action: "accept" });
  await h.ok(c, "nav.wait", { for: "url", value: "/p/left" });
  await h.trustFixtures();
});

test("js.eval, cookies.get, storage.get ask the user first (#18)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/storage.html` });
  const ev = await h.answerPrompt("once", () => h.ok(c, "js.eval", { expression: "document.title + ':' + (1+2) + ':' + window.knownGlobal" }));
  expect(ev.title).toContain("run JavaScript");
  expect(payload(ev.result as any).value).toBe("Storage:3:page-world-value");

  // the rest of this session's calls on this origin are pre-approved per category
  await h.trustFixtures({ devAllowSensitive: true, sensitiveAllowed: { [h.A]: true } });
  expect(payload(await h.ok(c, "js.eval", { expression: "typeof window.knownGlobal", world: "isolated" })).value).toBe("undefined");
  expect(payload(await h.ok(c, "js.eval", { expression: "new Promise(r => setTimeout(() => r(42), 50))" })).value).toBe(42);
  const thrown = await h.call(c, "js.eval", { expression: "throw new Error('nope from page')" });
  expect(thrown.isError).toBe(true);
  expect(thrown.text).toContain("nope from page");
  expect(thrown.text).toContain("<<<PAGE_DATA");
  expect((await h.call(c, "js.eval", { expression: "'x'.repeat(200000)" })).text).toContain("TOO_LARGE");
  expect((await h.call(c, "js.eval", { expression: "new Promise(() => {})", timeout: 300 })).text).toContain("TIMEOUT");

  const ck = payload(await h.ok(c, "cookies.get"));
  expect(ck.cookies.find((k: any) => k.name === "sid").value).toBe("abc123");
  expect((await h.call(c, "cookies.get", { url: `${h.B}/` })).text).toContain("PERMISSION_DENIED");
  expect(payload(await h.ok(c, "storage.get", { kind: "local" })).entries).toEqual({ theme: "dark" });
  expect(payload(await h.ok(c, "storage.get", { kind: "session" })).entries).toEqual({ tab: "one" });

  await h.trustFixtures();
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
