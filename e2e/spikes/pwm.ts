// #32 spike helpers: a throwaway Chrome profile (temp user-data-dir) with saved
// passwords seeded through Chrome's own password manager UI
// (chrome://password-manager → Add password), an https fixture whose
// self-signed cert Chrome trusts via --ignore-certificate-errors-spki-list
// (the password manager refuses pages with certificate errors), and raw CDP
// input of the kind the extension sends through chrome.debugger.
import { chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authServer, type AuthServer } from "../fixtures/auth/server";

export const CHANNEL = (process.env.SPIKE_CHANNEL as "chromium" | "chrome" | undefined) ?? "chromium";
export const HOST = "tabagent-fixture.com";

export interface Spike {
  ctx: BrowserContext;
  srv: AuthServer;
  /** https://tabagent-fixture.com:<port> */
  site: string;
  /** Same server over plain http (not a secure context). */
  httpSite?: string;
  close(): Promise<void>;
}

export function spkiOf(certPem: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "tabagent-spki-"));
  const certFile = join(dir, "c.pem");
  writeFileSync(certFile, certPem);
  const pub = execFileSync("openssl", ["x509", "-in", certFile, "-pubkey", "-noout"]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: pub });
  return execFileSync("openssl", ["dgst", "-sha256", "-binary"], { input: der }).toString("base64");
}

export async function launchSpike(opts: { https?: boolean } = {}): Promise<Spike> {
  const https = opts.https ?? true;
  const srv = await authServer(https ? { https: { names: [HOST, `*.${HOST}`] } } : {});
  const args = [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`];
  if (https) args.push(`--ignore-certificate-errors-spki-list=${spkiOf(srv.cert!)}`);
  const dir = mkdtempSync(join(tmpdir(), "tabagent-pwm-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: CHANNEL,
    headless: !process.env.HEADED,
    args,
    viewport: { width: 1000, height: 700 },
  });
  const site = `${https ? "https" : "http"}://${HOST}:${srv.port}`;
  return {
    ctx,
    srv,
    site,
    async close() {
      await ctx.close().catch(() => {});
      await srv.close();
    },
  };
}

/** Save a credential through chrome://password-manager → Add password. */
export async function seedPassword(ctx: BrowserContext, site: string, username: string, password: string) {
  const page = await ctx.newPage();
  await page.goto("chrome://password-manager/passwords");
  await page.locator("#addPasswordButton").click();
  await page.locator("#websiteInput input").fill(site);
  await page.locator("#usernameInput input").fill(username);
  await page.locator("#passwordInput input").fill(password);
  await page.locator("#websiteInput input").press("Tab");
  await page.locator("add-password-dialog cr-button.action-button").click({ timeout: 5000 });
  await page.locator("add-password-dialog #dialog[open]").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.close();
}

export async function savedCount(ctx: BrowserContext): Promise<number> {
  const page = await ctx.newPage();
  await page.goto("chrome://password-manager/passwords");
  await page.waitForTimeout(500);
  const n = await page.locator("password-list-item").count();
  await page.close();
  return n;
}

export async function center(page: Page, selector: string) {
  return page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

/** Trusted click via Input.dispatchMouseEvent, as chrome.debugger sends it. */
export async function cdpClick(cdp: CDPSession, page: Page, selector: string) {
  const { x, y } = await center(page, selector);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS = {
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, text: undefined },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: undefined },
} as const;

export async function cdpKey(cdp: CDPSession, name: keyof typeof KEYS) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

export async function cdpInsertText(cdp: CDPSession, text: string) {
  await cdp.send("Input.insertText", { text });
}

/** What the page's own JS sees in the fields right now. */
export async function pageValues(page: Page) {
  return page.evaluate(() => ({
    username: (document.getElementById("username") as HTMLInputElement | null)?.value ?? null,
    password: (document.getElementById("password") as HTMLInputElement | null)?.value ?? null,
  }));
}

/** Wait until the fixture server received a POST to /auth/login, or time out. */
export async function waitReceived(srv: AuthServer, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = srv.received.find((x) => x.path === "/auth/login");
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

export { readFileSync };
