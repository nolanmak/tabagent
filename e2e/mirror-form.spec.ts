// nolanmak/Jarvis#2524 (second repro, openai.com "Request Daybreak Access"): a React form
// that reveals fields step by step and keeps its submit button `disabled hidden` until it
// is complete, followed by a display:none Marketo form mirroring every field.
import { test, expect } from "./fixture";
import { view } from "./view";

test.describe.configure({ mode: "default" });

const stateOf = async (h: any, c: any) => (view(await h.ok(c, "page.text", {})).all.match(/State: ([^\n]+)/) ?? [])[1];
const find = async (h: any, c: any, p: Record<string, unknown>) => view(await h.ok(c, "page.find", p)).json.matches as { ref: string; name: string; hidden?: string }[];

test("before step 2 renders, find flags the mirror's copies and the hidden submit with the reason", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/mirror-form.html` });
  const email = await find(h, c, { by: "label", value: "Work email" });
  expect(email.length).toBe(1);
  expect(email[0].hidden).toBe("inside <form#mktoForm_1377.hidden.mktoForm> which is display:none");
  const go = await find(h, c, { by: "role", value: "button", name: "Submit and start verification" });
  expect(go[0].hidden).toBe("display:none (hidden attribute)");
  const r = await h.call(c, "act.click", { ref: go[0].ref, timeout: 500 });
  expect(r.text).toContain("reason: hidden): display:none (hidden attribute)");
});

test("form.submit on an incomplete form fails with why instead of returning ok", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/mirror-form.html` });
  const r = await h.call(c, "form.submit", {});
  expect(r.isError).toBe(true);
  expect(r.text).toContain("NOT_ACTIONABLE");
  expect(r.text).toMatch(/"Submit and start verification" is disabled and hidden/);
  expect(await stateOf(h, c)).toBe("idle");
});

test("filling step 1 reveals step 2; find returns the rendered field first and the form submits", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/mirror-form.html` });
  await h.ok(c, "act.fill", { ref: (await find(h, c, { by: "label", value: "Legal entity name" }))[0].ref, value: "Example Co" });
  await h.ok(c, "act.fill", { ref: (await find(h, c, { by: "label", value: "Public website" }))[0].ref, value: "https://example.com" });
  await h.ok(c, "act.check", { ref: (await find(h, c, { by: "role", value: "radio", name: "No" }))[0].ref, checked: true });
  const email = await find(h, c, { by: "label", value: "Work email" });
  expect(email.length).toBe(2);
  expect(email[0].hidden).toBeUndefined();
  expect(email[1].hidden).toMatch(/mktoForm_1377/);
  const org = await find(h, c, { by: "css", value: "[name=What_is_your_org_ID__c]" });
  expect(org[0].hidden).toBeUndefined();
  await h.ok(c, "act.fill", { ref: email[0].ref, value: "a@example.com" });
  await h.ok(c, "form.submit", {});
  expect(await stateOf(h, c)).toBe("submitted a@example.com");
});
