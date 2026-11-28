import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

const settings = (h: Harness) => h.sw.evaluate(async () => (globalThis as any).__tabagent.getSettings());

test("#12 unknown site asks: deny sticks for the session, once, always", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const c = await h.mcp({ label: "asker" });
  const d = await h.answerPrompt("deny", () => h.call(c, "nav.goto", { url: `${h.A}/index.html` }));
  expect(d.title).toContain(`asker wants to act on ${h.A}`);
  expect((d.result as any).text).toContain("PERMISSION_DENIED");
  // Deny = this session + origin: no second prompt
  const again = await h.call(c, "nav.goto", { url: `${h.A}/index.html` });
  expect(again.text).toContain("PERMISSION_DENIED");
  expect(await h.pendingPrompts()).toHaveLength(0);

  const c2 = await h.mcp({ label: "onceer" });
  const o = await h.answerPrompt("once", () => h.ok(c2, "nav.goto", { url: `${h.A}/index.html` }));
  expect((o.result as any).json.title).toBe("Fixtures home");
  // once covers lower levels for this session: no prompt for read
  await h.ok(c2, "page.snapshot");
  expect((await settings(h)).sites[h.A]).toBeUndefined();
  // a higher level asks again; Always stores exactly the requested level
  await h.setPolicies({}, { sites: { [h.A]: { preapproved: { c: true } } }, devAllowSensitive: false });
  const a = await h.answerPrompt("always", () => h.ok(c2, "js.eval", { expression: "1+1" }));
  expect(a.title).toContain(`full access to ${h.A}`);
  expect((await settings(h)).sites[h.A].policy).toBe("full");
  // another session now needs no prompt on A
  const c3 = await h.mcp({ label: "third" });
  await h.ok(c3, "nav.goto", { url: `${h.A}/index.html` });
  // ...but still has no grant for B
  const d3 = await h.answerPrompt("deny", () => h.call(c3, "nav.goto", { url: `${h.B}/index.html` }));
  expect((d3.result as any).text).toContain("PERMISSION_DENIED");
});

test("#12 identical pending requests share one prompt (FIFO)", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const c = await h.mcp({ label: "dup" });
  await h.answerPrompt("once", () => h.ok(c, "tabs", { action: "new" }).then(() => h.ok(c, "nav.goto", { url: `${h.B}/index.html` })));
  // two snapshots on the same origin + level from one session while nothing is granted for A
  const t = (await h.ok(c, "tabs", { action: "new" })).json.tabId;
  const p1 = h.call(c, "nav.goto", { url: `${h.A}/index.html`, tabId: t });
  const p2 = h.call(c, "nav.goto", { url: `${h.A}/article.html` });
  await expect.poll(async () => (await h.pendingPrompts()).length, { timeout: 10000 }).toBe(1);
  const [p] = await h.pendingPrompts();
  expect(p.origin).toBe(h.A);
  await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "once"), p.promptId);
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1.isError).toBe(false);
  expect(r2.isError).toBe(false);
  // a late answer for a settled prompt does nothing
  expect(await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "always"), p.promptId)).toBe(false);
  expect((await settings(h)).sites[h.A]).toBeUndefined();
});

test("#12/#14 prompt sets the badge to ! and an informational banner without buttons", async ({ h }) => {
  await h.setPolicies({ [h.A]: "read" }, { paused: false, devAllowSensitive: false });
  const c = await h.mcp({ label: "badger" });
  await h.ok(c, "tabs", { action: "new" });
  const pend = h.call(c, "nav.goto", { url: `${h.A}/index.html` });
  await expect.poll(async () => (await h.pendingPrompts()).length, { timeout: 10000 }).toBe(1);
  await expect.poll(async () => (await h.sw.evaluate(() => (globalThis as any).__tabagent.badge())).text).toBe("!");
  const [p] = await h.pendingPrompts();
  expect(p.reasons.join(" ")).toContain('Site is set to "read"');
  await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "deny"), p.promptId);
  expect((await pend).text).toContain("PERMISSION_DENIED");
  await expect.poll(async () => (await h.sw.evaluate(() => (globalThis as any).__tabagent.badge())).text).not.toBe("!");
});

test("#12 denylist (editable) and hard-denied pages (not unlockable)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const r = await h.call(c, "nav.goto", { url: "https://accounts.google.com/" });
  expect(r.text).toContain("PERMISSION_DENIED");
  expect(r.text).toContain("denylist");
  const ch = await h.call(c, "nav.goto", { url: "chrome://settings" });
  expect(ch.text).toContain("PERMISSION_DENIED");
  // Always on a hard-denied origin never unlocks it
  await h.setPolicies({ [h.A]: "full", "https://chromewebstore.google.com": "full" }, { devAllowSensitive: true });
  const ws = await h.call(c, "nav.goto", { url: "https://chromewebstore.google.com/" });
  expect(ws.text).toContain("PERMISSION_DENIED");
  // removing a denylist entry returns the origin to ask
  const perm = await h.ok(c, "session.permissions", { url: "https://accounts.google.com/" });
  expect(perm.json.level).toBe("deny");
  const s = await settings(h);
  await h.sw.evaluate((list) => (globalThis as any).__tabagent.updateSettings({ denylist: list }), s.denylist.filter((g: string) => g !== "accounts.google.com"));
  const perm2 = await h.ok(c, "session.permissions", { url: "https://accounts.google.com/" });
  expect(perm2.json.level).toBe("ask");
  await h.sw.evaluate((list) => (globalThis as any).__tabagent.updateSettings({ denylist: list }), s.denylist);
});

test("#67 policy.denylist_change shows the exact diff and cannot weaken hard sign-in blocks", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "policy-e2e", profile: "full,auth" });
  const change = await h.answerPrompt("once", () => h.ok(c, "policy.denylist_change", {
    changes: [{ op: "remove", glob: "*.chase.com" }],
    reason: "test a reviewed statement workflow",
  }));
  expect(change.prompt.sensitive.category).toBe("p");
  // The prompt UI rendered the exact summary; this is not a semantic/fuzzy approval.
  expect(change.summary).toContain("remove *.chase.com");
  expect(change.summary).toContain("test a reviewed statement workflow");
  expect((change.result as any).json.status).toBe("applied");
  expect((await settings(h)).denylist).not.toContain("*.chase.com");
  // Removing an editable rule never unlocks the hard automated-auth boundary.
  await h.setPolicies({ [h.A]: "full", [h.B]: "full", "https://www.chase.com": "full" }, { devAllowSensitive: false });
  const login = await h.call(c, "auth.login", { tabId: (await h.ok(c, "tabs", { action: "new", url: "https://www.chase.com/" })).json.tabId });
  expect(login.text).toContain("never signs in");
});

test("#67 rejecting a denylist change leaves extension policy unchanged", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "policy-deny-e2e", profile: "full" });
  const before = await settings(h);
  const denied = await h.answerPrompt("deny", () => h.call(c, "policy.denylist_change", {
    changes: [{ op: "remove", glob: "*.chase.com" }],
    reason: "this must not apply when denied",
  }));
  expect((denied.result as any).text).toContain("PERMISSION_DENIED");
  expect((await settings(h)).denylist).toEqual(before.denylist);
});

test("#104 policy.site_change shows origin, changes and reason; approval applies, turning off goes through the same prompt", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "site-change-e2e", profile: "full" });
  const on = await h.answerPrompt("once", () => h.ok(c, "policy.site_change", { origin: `${h.A}/`, changes: { auth: true, lite: true }, reason: "sign in to download statements" }));
  expect(on.prompt.sensitive.category).toBe("p");
  expect(on.summary).toContain(h.A);
  expect(on.summary).toContain("turn sign-in on");
  expect(on.summary).toContain("turn lite mode on");
  expect(on.summary).toContain("sign in to download statements");
  const applied = (on.result as any).json;
  expect(applied).toMatchObject({ status: "applied", origin: h.A, site: { policy: "full", auth: true, lite: true } });
  expect(applied.applied).toEqual([
    { field: "auth", from: false, to: true },
    { field: "lite", from: false, to: true },
  ]);
  expect((await settings(h)).sites[h.A]).toMatchObject({ policy: "full", auth: true, lite: true });

  await h.setPolicies({ [h.A]: "full", [h.B]: "full" }, { devAllowSensitive: false, sites: { [h.A]: { auth: true, authAlways: ["acct-1"], lite: true } } });
  const off = await h.answerPrompt("once", () => h.ok(c, "policy.site_change", { origin: h.A, changes: { auth: false, policy: "ask" }, reason: "done with statements" }));
  expect(off.summary).toContain("turn sign-in off");
  expect(off.summary).toContain("set policy to ask");
  expect((await settings(h)).sites[h.A]).toEqual({ lite: true });
  await h.trustFixtures();
});

test("#131 policy.site_change can turn on sign-in without asking, with the payment risk in the approval", async ({ h }) => {
  await h.setPolicies({ [h.A]: "full", [h.B]: "full" }, { devAllowSensitive: false, sites: { [h.A]: { auth: true } } });
  const c = await h.mcp({ label: "site-change-auto-e2e", profile: "full" });
  const on = await h.answerPrompt("once", () => h.ok(c, "policy.site_change", { origin: h.A, changes: { authAuto: true }, reason: "enter texted codes without asking" }));
  expect(on.prompt.sensitive.category).toBe("p");
  expect(on.summary).toContain("turn sign-in without asking on");
  expect(on.summary).toContain("payments or transfers");
  expect((on.result as any).json).toMatchObject({ status: "applied", site: { auth: true, authAuto: true }, applied: [{ field: "authAuto", from: false, to: true }] });
  expect((await settings(h)).sites[h.A]).toMatchObject({ auth: true, authAuto: true });
  const r = await h.call(c, "policy.site_change", { origin: "https://www.chase.com", changes: { authAuto: true }, reason: "x" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("PERMISSION_DENIED");
  expect(await h.pendingPrompts()).toHaveLength(0);
  await h.trustFixtures();
});

test("#104 a denied site change leaves settings unchanged, and YOLO does not skip the prompt", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false, yolo: true });
  try {
    const c = await h.mcp({ label: "site-change-deny", profile: "full" });
    const before = await settings(h);
    const denied = await h.answerPrompt("deny", () => h.call(c, "policy.site_change", { origin: h.A, changes: { auth: false, lite: true }, reason: "this must not apply when denied" }));
    expect(denied.prompt.sensitive.category).toBe("p");
    expect((denied.result as any).text).toContain("PERMISSION_DENIED");
    expect((await settings(h)).sites).toEqual(before.sites);
  } finally {
    await h.trustFixtures({ yolo: false });
  }
});

test("#104 site changes on password-manager, vault, denylisted or wildcard origins are refused without a prompt", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const s = await settings(h);
  await h.sw.evaluate((list) => (globalThis as any).__tabagent.updateSettings({ denylist: list }), [...s.denylist, "blocked.example"]);
  try {
    const c = await h.mcp({ label: "site-change-hard", profile: "full" });
    const cases: [string, string, string][] = [
      ["https://my.1password.com", "PERMISSION_DENIED", "passwords, account or mail"],
      ["https://www.chase.com", "PERMISSION_DENIED", "never signs in"],
      ["https://passwords.google.com", "PERMISSION_DENIED", "passwords, account or mail"],
      ["https://blocked.example", "PERMISSION_DENIED", "policy.denylist_change"],
      ["https://*.example.com", "BAD_REQUEST", "exact origin"],
    ];
    for (const [origin, errCode, text] of cases) {
      const r = await h.call(c, "policy.site_change", { origin, changes: { auth: true }, reason: "should be refused" });
      expect(r.isError, origin).toBe(true);
      expect(r.text, origin).toContain(errCode);
      expect(r.text, origin).toContain(text);
      expect(await h.pendingPrompts()).toHaveLength(0);
    }
    expect((await settings(h)).sites).toEqual(s.sites);
  } finally {
    await h.sw.evaluate((list) => (globalThis as any).__tabagent.updateSettings({ denylist: list }), s.denylist);
  }
});

test("#104 an approval is refused when the site settings changed while the prompt was open", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "site-change-stale", profile: "full" });
  const pend = h.call(c, "policy.site_change", { origin: h.A, changes: { auth: true }, reason: "stale approval" });
  await expect.poll(async () => (await h.pendingPrompts()).length, { timeout: 10000 }).toBe(1);
  const [p] = await h.pendingPrompts();
  await h.setPolicies({ [h.A]: "read", [h.B]: "full" }, { devAllowSensitive: false });
  await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "once"), p.promptId);
  const r = await pend;
  expect(r.text).toContain("BAD_REQUEST");
  expect(r.text).toContain("changed while this approval was pending");
  expect((await settings(h)).sites[h.A]).toEqual({ policy: "read" });
  await h.trustFixtures();
});

test("#13 login form: submit with a password prompts; deny leaves the page unchanged; feed masks the password", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "login" });
  await h.ok(c, "nav.goto", { url: `${h.A}/login.html` });
  const s = await h.ok(c, "page.snapshot");
  await h.ok(c, "act.type", { ref: Harness.ref(s.text, /textbox "Username"/), text: "neo" });
  await h.ok(c, "act.type", { ref: Harness.ref(s.text, /textbox "Password"/), text: "hunter2-secret" });
  const sub = await h.answerPrompt("deny", () => h.call(c, "form.submit", {}));
  expect((sub.result as any).text).toContain("PERMISSION_DENIED");
  expect(sub.reasons).toContain("password");
  expect((await h.ok(c, "page.text", {})).text).toContain("NOT SUBMITTED");
  // Enter inside the form is the same gate
  const enter = await h.answerPrompt("deny", () => h.call(c, "act.press", { key: "Enter", ref: Harness.ref(s.text, /textbox "Password"/) }));
  expect((enter.result as any).text).toContain("PERMISSION_DENIED");
  // clicking the submit control is the same gate
  const click = await h.answerPrompt("deny", () => h.call(c, "act.click", { ref: Harness.ref(s.text, /button "Sign in"/) }));
  expect((click.result as any).text).toContain("PERMISSION_DENIED");
  expect((await h.ok(c, "page.text", {})).text).toContain("NOT SUBMITTED");
  // live feed shows the action but never the password
  const feed = JSON.stringify(await h.sw.evaluate(() => (globalThis as any).__tabagent.feed()));
  expect(feed).toContain("act.type");
  expect(feed).not.toContain("hunter2-secret");
  expect(feed).toContain("••••");
  const panel = await h.openPanel();
  await panel.waitForSelector("#feed li[data-feed-id]");
  expect(await panel.textContent("#feed")).not.toContain("hunter2-secret");
  await panel.close();
});

test("#13 card form + delete button prompt; pre-approval is per origin per category", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
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
  await h.answerPrompt("once", () => h.ok(c, "act.click", { ref: pay }));
  expect((await h.ok(c, "page.text", {})).text).toContain("PAID");
  const del = Harness.ref(s.text, /Delete account/);
  const alw = await h.answerPrompt("always", () => h.ok(c, "act.click", { ref: del }));
  expect(alw.title).toContain("Delete account");
  const pre = (await settings(h)).sites[h.A].preapproved;
  expect(pre.b).toBe(true);
  expect(pre.c).toBeUndefined();
  // pre-approved now for b on A: no prompt
  await h.ok(c, "act.click", { ref: del });
  // ...but not for c on A
  const js = await h.answerPrompt("deny", () => h.call(c, "js.eval", { expression: "1" }));
  expect((js.result as any).text).toContain("PERMISSION_DENIED");
  // ...and not for b on B
  await h.ok(c, "nav.goto", { url: `${h.B}/checkout.html` });
  const s2 = await h.ok(c, "page.snapshot");
  const delB = await h.answerPrompt("deny", () => h.call(c, "act.click", { ref: Harness.ref(s2.text, /Delete account/) }));
  expect((delB.result as any).text).toContain("PERMISSION_DENIED");
  expect((await h.ok(c, "page.text", {})).text).toContain("UNPAID");
});

test("#13 static categories are gated in the router: nav.wait fn, cookies, storage", async ({ h }) => {
  await h.trustFixtures({ devAllowSensitive: false });
  const c = await h.mcp({ label: "static" });
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  // nav.wait without fn is not sensitive
  await h.ok(c, "nav.wait", { for: "load", timeout: 5000 });
  const fn = await h.answerPrompt("deny", () => h.call(c, "nav.wait", { for: "fn", value: "true", timeout: 2000 }));
  expect((fn.result as any).text).toContain("PERMISSION_DENIED");
  expect(fn.prompt.sensitive.category).toBe("c");
  const ck = await h.answerPrompt("deny", () => h.call(c, "cookies.get"));
  expect(ck.prompt.sensitive.category).toBe("d");
  const st = await h.answerPrompt("once", () => h.ok(c, "storage.get", { kind: "local" }));
  expect(st.prompt.sensitive.category).toBe("d");
  // devAllowSensitive passes a-e without prompting
  await h.trustFixtures({ devAllowSensitive: true });
  await h.ok(c, "cookies.get");
});

test("#14 kill switch: in-flight nav.wait returns KILLED, every call is KILLED until Resume, grants cleared", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: true });
  const c = await h.mcp({ label: "killme" });
  await h.answerPrompt("once", () => h.ok(c, "nav.goto", { url: `${h.A}/index.html` }));
  const panel = await h.openPanel();
  const long = h.call(c, "nav.wait", { for: "text", value: "never appears on this page", timeout: 60000 });
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__tabagent.inflight()), { timeout: 10000 }).toBeGreaterThan(0);
  const started = Date.now();
  await panel.click("#killBtn");
  const r = await long;
  expect(r.text).toContain("KILLED");
  expect(Date.now() - started).toBeLessThan(10000);
  await panel.waitForSelector("#resumeBtn:not([hidden])");
  expect((await h.sw.evaluate(() => (globalThis as any).__tabagent.badge())).text).toBe("⏸");
  expect((await h.call(c, "page.snapshot")).text).toContain("KILLED");
  // a brand-new session is refused too
  const fresh = await h.mcp({ label: "fresh" });
  expect((await h.call(fresh, "tabs", { action: "list" })).text).toContain("KILLED");
  // debuggers detached
  expect(await h.sw.evaluate(() => (globalThis as any).__tabagent.attachedTabs())).toEqual([]);
  await panel.click("#resumeBtn");
  await panel.waitForSelector("#killBtn:not([hidden])");
  // allow-once grant is gone: the same session is asked again
  const again = await h.answerPrompt("once", () => h.ok(c, "page.snapshot"));
  expect(again.title).toContain(h.A);
  // feed shows the calls
  await panel.reload();
  await panel.waitForSelector("#feed li[data-feed-id]");
  expect(await panel.textContent("#feed")).toContain("nav.wait");
  await panel.close();
});

test("#14 settings: revoke a site policy from the side panel", async ({ h }) => {
  await h.setPolicies({ [h.A]: "full" }, { devAllowSensitive: true });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  await panel.waitForSelector(`button[data-del="${h.A}"]`);
  await panel.click(`button[data-del="${h.A}"]`);
  await expect.poll(async () => (await settings(h)).sites[h.A]).toBeUndefined();
  await panel.fill("#newOrigin", h.B);
  await panel.selectOption("#newLevel", "read");
  await panel.click("#addSite button[type=submit]");
  await expect.poll(async () => (await settings(h)).sites[h.B]?.policy).toBe("read");
  await panel.close();
});

test("#118 adding a site with full in the panel turns on sign-in and every pre-approval", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  expect(await panel.textContent("#addSite")).toContain("full also turns on sign-in (without asking) and pre-approvals");
  await panel.fill("#newOrigin", h.A);
  await panel.selectOption("#newLevel", "full");
  await panel.click("#addSite button[type=submit]");
  await expect.poll(async () => (await settings(h)).sites[h.A]).toEqual({ policy: "full", auth: true, authAuto: true, preapproved: { a: true, b: true, c: true, d: true, e: true } });
  await expect(panel.locator(`input[data-auth][data-origin="${h.A}"]`)).toBeChecked();
  for (const c of ["a", "b", "c", "d", "e"]) await expect(panel.locator(`input[data-pre="${c}"][data-origin="${h.A}"]`)).toBeChecked();
  // A sensitive action (c: js.eval) on that origin runs with no extra toggle and no prompt.
  const c = await h.mcp({ label: "full118" });
  await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  const r = await h.ok(c, "js.eval", { expression: "1+1" });
  expect(JSON.stringify(r.json)).toContain("2");
  expect(await h.pendingPrompts()).toHaveLength(0);
  // Lowering from full leaves the toggles alone.
  await panel.selectOption(`select[data-policy][data-origin="${h.A}"]`, "act");
  await expect.poll(async () => (await settings(h)).sites[h.A]).toEqual({ policy: "act", auth: true, authAuto: true, preapproved: { a: true, b: true, c: true, d: true, e: true } });
  await panel.close();
});

test("#118 full never enables sign-in on hard-limited or denylisted hosts, and says why", async ({ h }) => {
  const host = new URL(h.B).hostname;
  const prevDenylist = (await settings(h)).denylist;
  await h.setPolicies({ [h.B]: "read" }, { paused: false, devAllowSensitive: false, denylist: [...prevDenylist, host] });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  await panel.fill("#newOrigin", "https://www.chase.com");
  await panel.selectOption("#newLevel", "full");
  await panel.click("#addSite button[type=submit]");
  await expect.poll(async () => (await settings(h)).sites["https://www.chase.com"]?.policy).toBe("full");
  const chase = (await settings(h)).sites["https://www.chase.com"];
  expect(chase.auth).toBeUndefined();
  expect(chase.preapproved).toEqual({ a: true, b: true, c: true, d: true, e: true });
  await expect(panel.locator("#siteLevelNote")).toContainText("never signs in on www.chase.com");
  await expect(panel.locator(`input[data-auth][data-origin="https://www.chase.com"]`)).not.toBeChecked();
  // Same rule through the row's policy select, for a host on the user's denylist.
  await panel.selectOption(`select[data-policy][data-origin="${h.B}"]`, "full");
  await expect.poll(async () => (await settings(h)).sites[h.B]?.policy).toBe("full");
  expect((await settings(h)).sites[h.B].auth).toBeUndefined();
  await expect(panel.locator("#siteLevelNote")).toContainText("denylist");
  await h.setPolicies({}, { denylist: prevDenylist });
  await panel.close();
});

test("#15 scoped tokens: cap and site limits; audit log never has raw card numbers", async ({ h }) => {
  await h.trustFixtures();
  const { execFileSync } = await import("node:child_process");
  const cli = join(process.cwd(), "packages/bridge/dist/cli.js");
  const env = { ...process.env, TABAGENT_HOME: h.home };
  const readTok = execFileSync(process.execPath, [cli, "token", "create", "--name", "reader", "--cap", "read"], { env }).toString().trim();
  const siteTok = execFileSync(process.execPath, [cli, "token", "create", "--name", "bonly", "--cap", "act", "--sites", "127.0.0.1"], { env }).toString().trim();
  const call = (tok: string, tool: string, params: unknown) =>
    fetch(`http://127.0.0.1:${h.port}/v1/call/${tool}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ params }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  // D16: navigation is act, so a read token cannot navigate
  let r = await call(readTok, "nav.goto", { url: `${h.A}/index.html` });
  expect(r.status).toBe(403);
  expect(r.body.error.message).toContain('limited to "read"');
  r = await call(siteTok, "nav.goto", { url: `${h.A}/index.html` });
  expect(r.status).toBe(403);
  expect(r.body.error.message).toContain("not allowed on localhost");
  r = await call(siteTok, "nav.goto", { url: `${h.B}/index.html` });
  expect(r.status).toBe(200);
  r = await call("bogus", "nav.goto", { url: `${h.B}/index.html` });
  expect(r.status).toBe(401);
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/checkout.html` });
  await h.ok(c, "form.fill", { fields: { "Card number": "4242424242424242" } });
  const log = readFileSync(join(h.home, "audit.jsonl"), "utf8");
  expect(log).toContain('"tool":"form.fill"');
  expect(log).not.toContain("4242424242424242");
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

test("prompt with no TabAgent panel open pops the approval window; answering it settles the call", async ({ h }) => {
  await h.setPolicies({ [h.A]: "read" }, { paused: false, devAllowSensitive: false });
  const c = await h.mcp({ label: "popper" });
  await h.ok(c, "tabs", { action: "new" });
  const popupP = h.ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/prompt.html?id="), timeout: 10000 });
  const pend = h.call(c, "nav.goto", { url: `${h.A}/index.html` });
  const popup = await popupP;
  await popup.locator("#once").click();
  expect((await pend).isError).toBeFalsy();
});

test("prompt while the side panel is open does not pop a window", async ({ h }) => {
  await h.setPolicies({ [h.A]: "read" }, { paused: false, devAllowSensitive: false });
  const panel = await h.openPanel();
  const c = await h.mcp({ label: "quiet" });
  await h.ok(c, "tabs", { action: "new" });
  let popped = false;
  const onPage = (p: { url(): string }) => { if (p.url().includes("/prompt.html")) popped = true; };
  h.ctx.on("page", onPage);
  const pend = h.call(c, "nav.goto", { url: `${h.A}/index.html` });
  await expect.poll(async () => (await h.pendingPrompts()).length, { timeout: 10000 }).toBe(1);
  await panel.waitForTimeout(1500);
  h.ctx.off("page", onPage);
  expect(popped).toBe(false);
  const [p] = await h.pendingPrompts();
  await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "deny"), p.promptId);
  expect((await pend).text).toContain("PERMISSION_DENIED");
  await panel.close();
});

test("YOLO toggle in the side panel: a new site needs no prompt", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false, yolo: false });
  const panel = await h.openPanel();
  await panel.locator("#yolo").evaluate((el) => el.closest("details")?.setAttribute("open", ""));
  await panel.locator("#yolo").check();
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__tabagent.getSettings().then((s: any) => s.yolo))).toBe(true);
  const c = await h.mcp({ label: "yolo" });
  await h.ok(c, "tabs", { action: "new" });
  const r = await h.call(c, "nav.goto", { url: `${h.A}/index.html` });
  expect(r.isError).toBeFalsy();
  expect(await h.pendingPrompts()).toHaveLength(0);
  await panel.locator("#yolo").uncheck();
  await panel.close();
});
