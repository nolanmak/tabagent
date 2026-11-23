import { test, expect, Harness } from "./fixture";
import { payload } from "./payload";

test.describe.configure({ mode: "default" });

/** Dialogs reported by an action: envelope `dialogs` (D14), or the pre-D14 `dialog` field. */
const dialogsOf = (p: any) => p.dialogs ?? (p.dialog ? [p.dialog] : []);

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
