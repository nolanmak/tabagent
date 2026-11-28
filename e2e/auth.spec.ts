// M6 auth e2e (#33 login, #34 code, #35 handoff) through a real MCP client, the real bridge with a
// fake `op` on PATH, the real extension, and an https fixture on two host names (the real one and a
// look-alike). The fixture server asserts it received the right secret; the MCP transcript, the
// bridge log and the audit log are searched for it and must not contain it.
import { chromium, expect, test as base } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "./harness";
import { authServer, type AuthServer } from "./fixtures/auth/server";
import { seedPassword, spkiOf } from "./spikes/pwm";
import { bwItem, bwScenario, fakeCliDir, opItem, opScenario } from "../packages/bridge/test/auth-fakes";

const HOST = "tabagent-fixture.com";
const EVIL = "tabagent-fixture.com.evil-example.com";
const PASSWORD = `pw-marker-${Math.random().toString(36).slice(2, 12)}`;
const USERNAME = "alice@example.com";
const ITEM = "abcdefghijklmnopqrstuvwxyz";
const CHROME_PW = `chrome-pw-${Math.random().toString(36).slice(2, 12)}`;
const CODE = String(100000 + Math.floor(Math.random() * 899999));
// #112: the fake `bw` session key and the password its `bw generate` hands out.
const BW_KEY = `K${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const GEN_PW = `gen-marker-${Math.random().toString(36).slice(2, 12)}`;
const NEW_ITEM = "bw-new-item-0001";
const SIGNUP_EMAIL = "newuser@example.com";

interface W {
  h: Harness;
  srv: AuthServer;
  site: string;
  evil: string;
  transcript: string[];
}

const test = base.extend<{}, { w: W }>({
  w: [
    async ({}, use) => {
      const srv = await authServer({ https: { names: [HOST, EVIL] } });
      const spki = spkiOf(srv.cert!);
      // Fake 1Password CLI on PATH, inherited by the bridge the harness spawns.
      const fake = fakeCliDir();
      fake.bin("op");
      fake.scenario("op", opScenario({ items: [opItem(ITEM, [`https://${HOST}`], USERNAME)], secrets: { [ITEM]: { username: USERNAME, password: PASSWORD, otp: CODE } } }));
      // Fake Bitwarden CLI too (#112 auth.signup); the provider stays off until a test turns it on.
      fake.bin("bw");
      fake.scenario("bw", bwScenario({ key: BW_KEY, items: [], create: bwItem({ id: NEW_ITEM, uris: [{ uri: `https://${HOST}`, match: 0 }], username: SIGNUP_EMAIL, password: GEN_PW, name: HOST }) }));
      process.env.PATH = `${fake.dir}:${process.env.PATH}`;
      // The harness launches Chromium; add host mapping + trust for the fixture cert (test-only flags).
      const orig = chromium.launchPersistentContext.bind(chromium);
      (chromium as any).launchPersistentContext = (dir: string, opts: any) => orig(dir, { ...opts, args: [...(opts.args ?? []), `--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${EVIL} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`] });
      const h = new Harness();
      await h.start();
      (chromium as any).launchPersistentContext = orig;
      const site = `https://${HOST}:${srv.port}`;
      const evil = `https://${EVIL}:${srv.port}`;
      await use({ h, srv, site, evil, transcript: [] });
      await h.stop();
      await srv.close();
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

async function enable(w: W, extraSites: Record<string, unknown> = {}) {
  await w.h.setPolicies({ [w.site]: "full", [w.evil]: "full" }, { paused: false, devAllowSensitive: true, sites: { [w.site]: { auth: true }, [w.evil]: { auth: true }, ...extraSites } });
}

async function call(w: W, c: any, tool: string, args: Record<string, unknown> = {}) {
  const r = await w.h.call(c, tool, args);
  w.transcript.push(JSON.stringify({ tool, args }), r.text);
  return r;
}

function noLeak(w: W, secret: string) {
  expect(w.transcript.join("\n")).not.toContain(secret);
  expect(w.h.bridgeLog).not.toContain(secret);
  for (const f of ["audit.jsonl", "bridge.log"]) {
    const p = join(w.h.home, f);
    if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toContain(secret);
  }
}

test.describe.configure({ mode: "serial" });

test("auth.status lists the matching 1Password account masked; nothing secret fetched", async ({ w }) => {
  await enable(w);
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
  const r = await call(w, c, "auth.status");
  expect(r.isError, r.text).toBe(false);
  expect(r.json.loginFormPresent).toBe(true);
  const op = r.json.providers.find((p: any) => p.name === "1password");
  expect(op.accounts).toEqual([expect.objectContaining({ id: `1password:${ITEM}`, accountMasked: "a•••@example.com" })]);
  noLeak(w, PASSWORD);
  noLeak(w, USERNAME);
});

test("auth.login classic: prompt (Allow once) → filled from fake op, submitted; server got the password, transcript did not", async ({ w }) => {
  await enable(w);
  w.srv.received.length = 0;
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
  const { result, title } = await w.h.answerPrompt("once", () => call(w, c, "auth.login"));
  const r = result as any;
  expect(r.isError, r.text).toBe(false);
  expect(r.json).toMatchObject({ filled: true, account: "a•••@example.com", source: "1password", submitted: true, next: "done" });
  expect(title ?? "").toContain("a•••@example.com");
  const got = w.srv.received.find((x) => x.path === "/auth/login");
  expect(got?.fields).toEqual({ username: USERNAME, password: PASSWORD });
  // a snapshot taken afterwards carries no secret either
  const snap = await call(w, c, "page.snapshot");
  expect(snap.isError).toBe(false);
  noLeak(w, PASSWORD);
});

test("DA1 (review H1): even in YOLO mode the typed password cannot be read back with js.eval, nav.wait fn or network.get", async ({ w }) => {
  await enable(w, { [`https://${HOST}:${w.srv.port}`]: { auth: true, authAlways: [`1password:${ITEM}`] } });
  await w.h.sw.evaluate(() => (globalThis as any).__tabagent.updateSettings({ yolo: true }));
  try {
    w.srv.received.length = 0;
    const c = await w.h.mcp({ profile: "full,auth" });
    await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
    await w.h.ok(c, "network.list");
    const fill = await call(w, c, "auth.login", { submit: false });
    expect(fill.isError, fill.text).toBe(false);
    const ev = await call(w, c, "js.eval", { expression: "document.querySelector('input[type=password]').value" });
    expect(ev.isError).toBe(true);
    expect(ev.text).toContain("PERMISSION_DENIED");
    const fn = await call(w, c, "nav.wait", { for: "fn", value: "document.querySelector('input[type=password]').value === ''", timeout: 2000 });
    expect(fn.isError).toBe(true);
    expect(fn.text).toContain("PERMISSION_DENIED");
    // No agent JS ran, so auth may still submit; the login POST it makes stays unreadable.
    const sub = await call(w, c, "auth.login");
    expect(sub.isError, sub.text).toBe(false);
    expect(w.srv.received.find((x) => x.path === "/auth/login")?.fields.password).toBe(PASSWORD);
    const list = await call(w, c, "network.list", { method: "POST" });
    const id = String(list.text.match(/id\W+(n\d+)/)?.[1] ?? "");
    expect(id, list.text).not.toBe("");
    const got = await call(w, c, "network.get", { id });
    expect(got.isError).toBe(true);
    expect(got.text).toContain("PERMISSION_DENIED");
    noLeak(w, PASSWORD);
  } finally {
    await w.h.sw.evaluate(() => (globalThis as any).__tabagent.updateSettings({ yolo: false }));
  }
});

test("auth.login two-step: first call fills the username, second the password (Always for this account)", async ({ w }) => {
  await enable(w, { [`https://${HOST}:${w.srv.port}`]: { auth: true, authAlways: [`1password:${ITEM}`] } });
  w.srv.received.length = 0;
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/two-step.html` });
  const r1 = await call(w, c, "auth.login");
  expect(r1.isError, r1.text).toBe(false);
  expect(r1.json).toMatchObject({ filled: true, submitted: true });
  expect(w.srv.received.find((x) => x.path === "/auth/step1")?.fields).toEqual({ username: USERNAME });
  const r2 = await call(w, c, "auth.login");
  expect(r2.isError, r2.text).toBe(false);
  expect(r2.json).toMatchObject({ filled: true, submitted: true, next: "done" });
  expect(w.srv.received.find((x) => x.path === "/auth/login")?.fields).toEqual({ username: USERNAME, password: PASSWORD });
  noLeak(w, PASSWORD);
});

test("auth.login on a look-alike origin is refused and no secret is fetched from the provider", async ({ w }) => {
  await enable(w);
  w.srv.received.length = 0;
  const fakeLog = process.env.FAKE_CLI_LOG!;
  const before = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).length : 0;
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.evil}/login.html` });
  const r = await call(w, c, "auth.login");
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/PERMISSION_DENIED|NOT_FOUND/);
  const calls = readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l));
  expect(calls.filter((x: any) => x.argv[0] === "item" && x.argv[1] === "get")).toEqual([]);
  expect(w.srv.received).toEqual([]);
});

test("auth.login refused when sign-in is not enabled for the origin (no prompt)", async ({ w }) => {
  await w.h.setPolicies({ [w.site]: "full" }, { paused: false, devAllowSensitive: true });
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
  const r = await call(w, c, "auth.login");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("PERMISSION_DENIED");
  expect(await w.h.pendingPrompts()).toEqual([]);
});

test("auth.code email: login asks for a code, the fake mailbox gets it a moment later, the right code reaches the server", async ({ w }) => {
  await enable(w, { [`https://${HOST}:${w.srv.port}`]: { auth: true, authAlways: [`1password:${ITEM}`, "code-source:email"] } });
  w.srv.received.length = 0;
  w.srv.mailbox.length = 0;
  w.srv.setCode(CODE);
  await w.h.sw.evaluate((u) => (globalThis as any).__tabagentAuth.setMailUrl(u), `${w.site}/mail/feed/atom`);
  try {
    const c = await w.h.mcp({ profile: "core,auth" });
    await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
    const login = await call(w, c, "auth.login");
    expect(login.isError, login.text).toBe(false);
    expect(login.json.next).toBe("code_required");
    setTimeout(() => w.srv.mailbox.push({ from: "noreply@tabagent-fixture.com", subject: "Your sign-in code", body: `Your verification code is ${CODE}. It expires in 10 minutes.`, ts: Date.now() }), 1500);
    const r = await call(w, c, "auth.code", { source: "email", from: "tabagent-fixture.com", timeout: 20000 });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ filled: true, source: "email", submitted: true });
    expect(w.srv.received.find((x) => x.path === "/auth/code")?.fields).toEqual({ code: CODE });
    // the private reader tab is gone and never showed up in tabs list
    const tabs = await call(w, c, "tabs", { action: "list" });
    expect(tabs.text).not.toContain("/mail/feed/atom");
    noLeak(w, CODE);
    noLeak(w, PASSWORD);
  } finally {
    w.srv.setCode("");
    await w.h.sw.evaluate(() => (globalThis as any).__tabagentAuth.setMailUrl(""));
  }
});

test("auth.code totp from the fake op item", async ({ w }) => {
  await enable(w, { [`https://${HOST}:${w.srv.port}`]: { auth: true, authAlways: [`1password:${ITEM}`] } });
  w.srv.received.length = 0;
  w.srv.setCode(CODE);
  try {
    const c = await w.h.mcp({ profile: "core,auth" });
    await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
    expect((await call(w, c, "auth.login")).json.next).toBe("code_required");
    const r = await call(w, c, "auth.code", { source: "totp" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ filled: true, source: "totp", submitted: true });
    expect(w.srv.received.find((x) => x.path === "/auth/code")?.fields).toEqual({ code: CODE });
    noLeak(w, CODE);
  } finally {
    w.srv.setCode("");
  }
});

test("#131 sign in without asking: auth.login runs with no prompt and the audit says authAuto; off, it asks again", async ({ w }) => {
  await w.h.setPolicies({ [w.site]: "full", [w.evil]: "full" }, { paused: false, devAllowSensitive: false, sites: { [w.site]: { auth: true, authAuto: true }, [w.evil]: { auth: true } } });
  w.srv.received.length = 0;
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
  const r = await call(w, c, "auth.login");
  expect(r.isError, r.text).toBe(false);
  expect(r.json).toMatchObject({ filled: true, source: "1password" });
  expect(await w.h.pendingPrompts()).toHaveLength(0);
  await expect
    .poll(() => {
      const p = join(w.h.home, "audit.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((x) => x.tool === "auth.login" && x.outcome === "ok" && x.authAuto === true) : false;
    })
    .toBe(true);
  noLeak(w, PASSWORD);

  // Turned off: the same sign-in asks again.
  await w.h.setPolicies({ [w.site]: "full", [w.evil]: "full" }, { paused: false, devAllowSensitive: false, sites: { [w.site]: { auth: true }, [w.evil]: { auth: true } } });
  const c2 = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c2, "nav.goto", { url: `${w.site}/login.html` });
  const { prompt, result } = await w.h.answerPrompt("deny", () => call(w, c2, "auth.login"));
  expect(prompt.sensitive.category).toBe("g");
  expect((result as any).isError).toBe(true);
});

test("auth.handoff: debugger detached and tab busy while waiting; user clicks the human check and Done; agent sees signed-in state", async ({ w }) => {
  await enable(w);
  const c = await w.h.mcp({ profile: "core,auth" });
  const nav = await w.h.ok(c, "nav.goto", { url: `${w.site}/auth/human` });
  const before = await w.h.ok(c, "page.snapshot");
  const oldRef = Harness.ref(before.json?.snapshot ?? before.text, /button "I am human"/);
  const tabId = (await w.h.ok(c, "tabs", { action: "list" })).json.tabs[0].tabId;
  expect(nav.isError).toBe(false);

  expect(await w.h.sw.evaluate((id) => (globalThis as any).__tabagent.attachedTabs().includes(id), tabId)).toBe(true);
  const hp = call(w, c, "auth.handoff", { reason: "Please confirm you are human" });
  await expect.poll(() => w.h.sw.evaluate(() => (globalThis as any).__tabagentAuth.handoffs().length), { timeout: 10000 }).toBe(1);
  // not under automation while the user acts (TabAgent's own chrome.debugger; Playwright's CDP client is separate)
  const attached = await w.h.sw.evaluate((id) => (globalThis as any).__tabagent.attachedTabs().includes(id), tabId);
  expect(attached).toBe(false);
  // the agent's tools on that tab are refused
  const busy = await w.h.call(c, "page.snapshot");
  expect(busy.isError).toBe(true);
  expect(busy.text).toContain("TAB_BUSY");

  // the user: click the button in the page, then Done in the side panel
  const page = w.h.ctx.pages().find((p) => p.url().includes("/auth/human"))!;
  await page.click("#human");
  await page.waitForSelector("text=Signed in");
  expect(await w.h.sw.evaluate((id) => (globalThis as any).__tabagent.attachedTabs().includes(id), tabId)).toBe(false);
  const panel = await w.h.openPanel();
  const item = panel.locator(`li[data-handoff-tab="${tabId}"]`);
  await item.waitFor();
  expect(await item.textContent()).toContain("is asking you to finish a step in this tab");
  await item.locator('button[data-handoff="done"]').click();
  await panel.close();

  const r = await hp;
  expect(r.isError, r.text).toBe(false);
  expect(r.json).toEqual({ completed: true });
  const stale = await w.h.call(c, "act.click", { ref: oldRef });
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("REF_STALE");
  const after = await w.h.ok(c, "page.snapshot");
  expect(after.text).toContain("Signed in");
});

test("chrome-autofill (#32): Chrome pre-fills its saved password on the https page; auth.login asks, submits, and never sees it", async ({ w }) => {
  await seedPassword(w.h.ctx, w.site, "carol@example.com", CHROME_PW);
  await enable(w);
  w.srv.received.length = 0;
  const c = await w.h.mcp({ profile: "core,auth" });
  await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
  const st = await call(w, c, "auth.status");
  await expect.poll(async () => JSON.stringify((await call(w, c, "auth.status")).json.providers), { timeout: 5000 }).toContain("chrome-autofill");
  expect(st.isError).toBe(false);
  const { result, title } = await w.h.answerPrompt("once", () => call(w, c, "auth.login", { account: "chrome-autofill:saved" }));
  const r = result as any;
  expect(r.isError, r.text).toBe(false);
  expect(r.json).toMatchObject({ filled: true, account: "c•••@example.com", source: "chrome-autofill", submitted: true, next: "done" });
  expect(title ?? "").toContain("chrome-autofill");
  expect(w.srv.received.find((x) => x.path === "/auth/login")?.fields).toEqual({ username: "carol@example.com", password: CHROME_PW });
  noLeak(w, CHROME_PW);
});

test("auth.signup (#112): consent every time (Always does not skip it), Bitwarden creates the login, both password fields get it, the agent never sees it", async ({ w }) => {
  // Turn the Bitwarden provider on (config is read live) and unlock it through the admin route.
  const cfgPath = join(w.h.home, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, auth: { providers: ["1password", "bitwarden"] } }));
  try {
    const unlock = await fetch(`http://127.0.0.1:${w.h.port}/v1/admin/bitwarden/session`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` }, body: JSON.stringify({ key: BW_KEY }) });
    expect(unlock.status).toBe(204);
    // An Always for the prompt's placeholder id must not let a sign-up through without asking.
    await enable(w, { [w.site]: { auth: true, authAlways: ["bitwarden:new-login"] } });
    w.srv.received.length = 0;
    const c = await w.h.mcp({ profile: "core,auth" });
    await w.h.ok(c, "nav.goto", { url: `${w.site}/signup.html` });
    const { result, title } = await w.h.answerPrompt("once", () => call(w, c, "auth.signup", { email: SIGNUP_EMAIL }));
    const r = result as any;
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toEqual({ created: true, account: "new•••er@example.com", accountId: `bitwarden:${NEW_ITEM}`, source: "bitwarden", filled: true, submitted: true, next: "done" });
    expect(title).toBe(`Create an account on ${HOST}:${w.srv.port} as new•••er@example.com and save it to Bitwarden?`);
    expect(w.srv.received.find((x) => x.path === "/auth/signup")?.fields).toEqual({ email: SIGNUP_EMAIL, password: GEN_PW, confirm: GEN_PW });
    const snap = await call(w, c, "page.snapshot");
    expect(snap.isError).toBe(false);
    noLeak(w, GEN_PW);
    noLeak(w, BW_KEY);

    // A login page is refused before any prompt.
    await w.h.ok(c, "nav.goto", { url: `${w.site}/login.html` });
    const no = await call(w, c, "auth.signup", { email: SIGNUP_EMAIL });
    expect(no.isError).toBe(true);
    expect(no.text).toContain("NOT_FOUND");
  } finally {
    writeFileSync(cfgPath, JSON.stringify(cfg));
  }
});
