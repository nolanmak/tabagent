import { test, expect, Harness } from "./fixture";

// #131: Settings -> Sites has its own Sign-in column: allowed, without asking (authAuto), always
// allow texted/emailed codes, and the per-account Always grants with a remove button each.
const settings = (h: Harness) => h.sw.evaluate(async () => (globalThis as any).__tabagent.getSettings());
const ALL = { a: true, b: true, c: true, d: true, e: true };

test.describe.configure({ mode: "serial" });

test("#131 Sign-in column: lists and revokes Always grants, toggles codes-always", async ({ h }) => {
  await h.setPolicies({ [h.A]: "act" }, { paused: false, devAllowSensitive: false, sites: { [h.A]: { auth: true, authAlways: ["1password:abcdefghijklmnop", "code-source:sms"] } } });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  await expect(panel.locator("table.sites thead th")).toHaveText(["Origin", "Policy", "Lite", "Pre-approved", "Sign-in", ""]);
  const row = panel.locator(`#sites tr[data-site="${h.A}"]`);
  // The sign-in box is no longer among the pre-approvals.
  await expect(row.locator("td.pre input[data-auth]")).toHaveCount(0);
  await expect(row.locator("td.signin input[data-auth]")).toBeChecked();
  await expect(row.locator("td.signin")).toContainText("allowed");
  const grants = row.locator("td.signin .always li");
  await expect(grants).toHaveText([/1password ab•••op/, /texted codes/]);
  await expect(row.locator("td.signin")).not.toContainText("abcdefghijklmnop");

  // Revoke one Always grant with its ✕.
  await row.getByRole("button", { name: "Remove Always for 1password ab•••op" }).click();
  await expect.poll(async () => (await settings(h)).sites[h.A].authAlways).toEqual(["code-source:sms"]);
  await expect(grants).toHaveText([/texted codes/]);

  // Codes-always: on adds both code sources, off removes them.
  const codes = row.locator("input[data-codes-always]");
  await expect(codes).not.toBeChecked();
  await codes.check();
  await expect.poll(async () => (await settings(h)).sites[h.A].authAlways).toEqual(["code-source:sms", "code-source:email"]);
  await expect(grants).toHaveText([/texted codes/, /emailed codes/]);
  await expect(codes).toBeChecked();
  await codes.uncheck();
  await expect.poll(async () => (await settings(h)).sites[h.A].authAlways).toBeUndefined();
  await expect(grants).toHaveCount(0);
  await panel.close();
});

test("#131 sign in without asking: enabling shows the payment warning; turning sign-in off clears it", async ({ h }) => {
  await h.setPolicies({ [h.A]: "act" }, { paused: false, devAllowSensitive: false, sites: { [h.A]: { auth: true } } });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  const row = panel.locator(`#sites tr[data-site="${h.A}"]`);
  const auto = row.locator("input[data-auth-auto]");
  await expect(auto).not.toBeChecked();
  await expect(row.locator(".signin-warn")).toHaveCount(0);
  await auto.check();
  await expect.poll(async () => (await settings(h)).sites[h.A]).toEqual({ policy: "act", auth: true, authAuto: true });
  await expect(panel.locator("#siteLevelNote")).toContainText("payments or transfers");
  await expect(row.locator(".signin-warn")).toContainText("payments or transfers");
  await expect(auto).toBeChecked();
  // Sign-in off takes "without asking" with it.
  await row.locator("input[data-auth]").uncheck();
  await expect.poll(async () => (await settings(h)).sites[h.A]).toEqual({ policy: "act" });
  await expect(auto).not.toBeChecked();
  await panel.close();
});

test("#131 full means full: sign-in without asking is on, with the warning; blocked hosts never get it", async ({ h }) => {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  expect(await panel.textContent("#addSite")).toContain("full also turns on sign-in (without asking) and pre-approvals");
  await panel.fill("#newOrigin", h.A);
  await panel.selectOption("#newLevel", "full");
  await panel.click("#addSite button[type=submit]");
  await expect.poll(async () => (await settings(h)).sites[h.A]).toEqual({ policy: "full", auth: true, authAuto: true, preapproved: ALL });
  const row = panel.locator(`#sites tr[data-site="${h.A}"]`);
  await expect(row.locator("input[data-auth-auto]")).toBeChecked();
  await expect(row.locator(".signin-warn")).toContainText("payments or transfers");
  await expect(panel.locator("#siteLevelNote")).toContainText("payments or transfers");

  await panel.fill("#newOrigin", "https://my.1password.com");
  await panel.selectOption("#newLevel", "full");
  await panel.click("#addSite button[type=submit]");
  await expect.poll(async () => (await settings(h)).sites["https://my.1password.com"]?.policy).toBe("full");
  expect((await settings(h)).sites["https://my.1password.com"].authAuto).toBeUndefined();
  const vault = panel.locator(`#sites tr[data-site="https://my.1password.com"]`);
  await expect(vault.locator("input[data-auth-auto]")).toBeDisabled();
  await expect(vault.locator("input[data-codes-always]")).toBeDisabled();
  await panel.close();
});
