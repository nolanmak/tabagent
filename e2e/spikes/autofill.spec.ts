// #32 / OA1 spike: can Chrome's saved-password autofill be triggered through CDP?
// Each mechanism is one test asserting the fixture server received the saved
// password. Mechanisms that don't work stay as test.fail with the reason, so a
// Chrome change that makes them work turns the suite red and gets noticed.
// Runs in Playwright's Chromium by default; SPIKE_CHANNEL=chrome runs Chrome
// stable with a temp user-data-dir (the user's profile is never touched).
import { expect, test } from "@playwright/test";
import { cdpClick, cdpInsertText, cdpKey, launchSpike, pageValues, savedCount, seedPassword, waitReceived, type Spike } from "./pwm";

const PW_A = `marker-A-${Math.random().toString(36).slice(2, 10)}`;
const PW_B = `marker-B-${Math.random().toString(36).slice(2, 10)}`;



let sp: Spike;
test.afterEach(async () => {
  await sp?.close();
});

async function open(sp: Spike, path = "/login.html") {
  const page = await sp.ctx.newPage();
  const cdp = await sp.ctx.newCDPSession(page);
  await page.goto(sp.site + path);
  return { page, cdp };
}

test("seeding: Add password in chrome://password-manager stores a credential in a throwaway profile", async () => {
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  expect(await savedCount(sp.ctx)).toBe(1);
});

test("M1: https page, Chrome fills on load; trusted CDP click on the field then CDP click on submit sends the saved password", async () => {
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page, cdp } = await open(sp);
  await expect.poll(() => pageValues(page).then((v) => v.username), { timeout: 5000 }).toBe("alice@example.com");
  await cdpClick(cdp, page, "#username");
  await cdpClick(cdp, page, "#submit");
  const r = await waitReceived(sp.srv);
  expect(r?.fields).toEqual({ username: "alice@example.com", password: PW_A });
});

test("M1 control: without any trusted gesture, a script submit still sends the password (no gesture gate observed)", async () => {
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page } = await open(sp);
  await expect.poll(() => pageValues(page).then((v) => v.username), { timeout: 5000 }).toBe("alice@example.com");
  await page.evaluate(() => (document.getElementById("login") as HTMLFormElement).requestSubmit());
  const r = await waitReceived(sp.srv);
  expect(r?.fields.password).toBe(PW_A);
});

test("M2: focus + ArrowDown + Enter through CDP accepts Chrome's suggestion (http page, no fill on load)", async () => {
  test.fail(!process.env.SPIKE_PROBE, "Chrome's suggestion popup did not accept CDP ArrowDown/Enter in this build (see report)");
  sp = await launchSpike({ https: false });
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page, cdp } = await open(sp);
  await page.waitForTimeout(800);
  expect(await pageValues(page)).toEqual({ username: "", password: "" });
  await cdpClick(cdp, page, "#username");
  await page.waitForTimeout(400);
  await cdpKey(cdp, "ArrowDown");
  await page.waitForTimeout(300);
  await cdpKey(cdp, "Enter");
  await expect.poll(() => pageValues(page).then((v) => v.password), { timeout: 3000 }).toBe(PW_A);
});

test("M2b: https, page in front, prefill cleared; trusted click + ArrowDown + Enter refills from the suggestion", async () => {
  test.fail(!process.env.SPIKE_PROBE, "Chrome's suggestion popup did not accept CDP ArrowDown/Enter in this build (see report)");
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page, cdp } = await open(sp);
  await page.bringToFront();
  await expect.poll(() => pageValues(page).then((v) => v.username), { timeout: 5000 }).toBe("alice@example.com");
  await page.evaluate(() => {
    for (const id of ["username", "password"]) (document.getElementById(id) as HTMLInputElement).value = "";
  });
  await cdpClick(cdp, page, "#username");
  await page.waitForTimeout(600);
  await cdpKey(cdp, "ArrowDown");
  await page.waitForTimeout(300);
  await cdpKey(cdp, "Enter");
  await expect.poll(() => pageValues(page).then((v) => v.password), { timeout: 3000 }).toBe(PW_A);
});

test("M3: two saved accounts; typing the second username via insertText then leaving the field fills that account's password", async () => {
  test.fail(!process.env.SPIKE_PROBE, "Chrome keeps the account it pre-filled on load (the first one); typing another username does not swap the password");
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  await seedPassword(sp.ctx, sp.site, "bob@example.com", PW_B);
  const { page, cdp } = await open(sp);
  await page.waitForTimeout(1000);
  await cdpClick(cdp, page, "#username");
  await page.evaluate(() => ((document.getElementById("username") as HTMLInputElement).select(), 0));
  await cdpInsertText(cdp, "bob@example.com");
  await cdpClick(cdp, page, "#password");
  await page.waitForTimeout(500);
  await cdpClick(cdp, page, "#submit");
  const r = await waitReceived(sp.srv);
  expect(r?.fields).toEqual({ username: "bob@example.com", password: PW_B });
});

test("M3b: two saved accounts; typing a username prefix then ArrowDown + Enter picks that account", async () => {
  test.fail(!process.env.SPIKE_PROBE, "Suggestion popup selection via CDP keys did not fill (same cause as M2)");
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  await seedPassword(sp.ctx, sp.site, "bob@example.com", PW_B);
  const { page, cdp } = await open(sp);
  await page.waitForTimeout(1000);
  await cdpClick(cdp, page, "#username");
  await page.evaluate(() => ((document.getElementById("username") as HTMLInputElement).value = "", 0));
  await cdpInsertText(cdp, "bob");
  await page.waitForTimeout(400);
  await cdpKey(cdp, "ArrowDown");
  await cdpKey(cdp, "Enter");
  await expect.poll(() => pageValues(page).then((v) => v.password), { timeout: 3000 }).toBe(PW_B);
});

test("M4: fields added after load are still filled once they appear; trusted click + submit sends the password", async () => {
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page, cdp } = await open(sp, "/login-late.html");
  await page.waitForSelector("#username", { timeout: 5000 });
  await expect.poll(() => pageValues(page).then((v) => v.username), { timeout: 5000 }).toBe("alice@example.com");
  await cdpClick(cdp, page, "#username");
  await cdpClick(cdp, page, "#submit");
  const r = await waitReceived(sp.srv);
  expect(r?.fields).toEqual({ username: "alice@example.com", password: PW_A });
});

test("M5: http (not a secure context) page: no fill on load and a trusted click alone fills nothing", async () => {
  sp = await launchSpike({ https: false });
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const { page, cdp } = await open(sp);
  await page.waitForTimeout(1000);
  await cdpClick(cdp, page, "#username");
  await page.waitForTimeout(800);
  expect(await pageValues(page)).toEqual({ username: "", password: "" });
});

test("M6: background tab (another page in front): Chrome still fills on load and a CDP click on submit sends the password", async () => {
  sp = await launchSpike();
  await seedPassword(sp.ctx, sp.site, "alice@example.com", PW_A);
  const front = await sp.ctx.newPage();
  await front.goto("about:blank");
  const page = await sp.ctx.newPage();
  const cdp = await sp.ctx.newCDPSession(page);
  await front.bringToFront();
  await page.goto(sp.site + "/login.html");
  await expect.poll(() => pageValues(page).then((v) => v.username), { timeout: 5000 }).toBe("alice@example.com");
  expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
  expect(await page.evaluate(() => document.getElementById("password")!.matches(":autofill"))).toBe(true);
  await cdpClick(cdp, page, "#submit");
  const r = await waitReceived(sp.srv);
  expect(r?.fields).toEqual({ username: "alice@example.com", password: PW_A });
});
