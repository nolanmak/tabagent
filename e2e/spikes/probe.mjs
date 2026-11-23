// Scratch probe for #32 (not a test): seeds a password and reports what each mechanism does.
// npx tsx is not installed, so this is plain JS mirroring pwm.ts.
import { chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const channel = process.argv[2] || "chromium";
const headless = process.argv[3] !== "headed";
const received = [];
const https = process.env.SCHEME === "https";
let tls = null, spki = "";
if (https) {
  const d = mkdtempSync(join(tmpdir(), "cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", d + "/k.pem", "-out", d + "/c.pem", "-days", "2", "-subj", "/CN=tabagent-fixture.com", "-addext", "subjectAltName=DNS:tabagent-fixture.com,DNS:*.tabagent-fixture.com"], { stdio: "ignore" });
  tls = { key: readFileSync(d + "/k.pem"), cert: readFileSync(d + "/c.pem") };
  spki = execFileSync("sh", ["-c", `openssl x509 -in ${d}/c.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`]).toString().trim();
}
const handler = ((req, res) => {
  if (req.method === "POST") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      received.push(Object.fromEntries(new URLSearchParams(b)));
      res.end("<h1>ok</h1>");
    });
    return;
  }
  const f = req.url.includes("late") ? "login-late.html" : "login.html";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(readFileSync(new URL(`../fixtures/auth/${f}`, import.meta.url)));
});
const srv = https ? createHttps(tls, handler) : createHttp(handler);
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const site = `${https ? "https" : "http"}://tabagent-fixture.com:${port}`;
const dir = mkdtempSync(join(tmpdir(), "pwspike-"));
const ctx = await chromium.launchPersistentContext(dir, { channel, headless, args: ["--host-resolver-rules=MAP tabagent-fixture.com 127.0.0.1, MAP *.tabagent-fixture.com 127.0.0.1", ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [])], ignoreDefaultArgs: process.env.NOAUTO ? ["--enable-automation"] : [], viewport: { width: 1000, height: 700 } });
console.log("browser", ctx.browser()?.version());
const pm = await ctx.newPage();
await pm.goto("chrome://password-manager/passwords");
await pm.locator("#addPasswordButton").click();
await pm.locator("#websiteInput input").fill(site);
await pm.locator("#usernameInput input").fill("alice@example.com");
await pm.locator("#passwordInput input").fill("S3cret-marker-123");
await pm.waitForTimeout(300);
await pm.locator("#websiteInput input").press("Tab");
await pm.waitForTimeout(500);
console.log("website invalid", await pm.locator("#websiteInput").evaluate((e) => ({ inv: e.invalid, msg: e.errorMessage })), await pm.locator("#passwordInput").evaluate((e) => ({ inv: e.invalid, msg: e.errorMessage })), await pm.locator("#usernameInput").evaluate((e) => ({ inv: e.invalid, msg: e.errorMessage })));
const btns = await pm.locator("add-password-dialog cr-button").allTextContents();
console.log("dialog buttons", btns);
await pm.locator("add-password-dialog cr-button.action-button").click();
await pm.waitForTimeout(800);
console.log("saved items", await pm.locator("password-list-item").count());

const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const vals = () => page.evaluate(() => ({ u: document.getElementById("username")?.value, p: document.getElementById("password")?.value, uAF: document.getElementById("username")?.matches(":autofill"), pAF: document.getElementById("password")?.matches(":autofill") }));
await page.goto(site + "/");
await page.waitForTimeout(1500);
console.log("after load", await vals());
const c = await page.evaluate(() => { const r = document.getElementById("username").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...c });
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...c, button: "left", clickCount: 1 });
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...c, button: "left", clickCount: 1 });
await page.waitForTimeout(800);
console.log("after trusted click", await vals());
const key = async (k, kc, text) => {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (text) await cdp.send("Input.dispatchKeyEvent", { type: "char", key: k, code: k, text, windowsVirtualKeyCode: kc });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
};
await key("ArrowDown", 40);
await page.waitForTimeout(400);
await key("Enter", 13, "\r");
await page.waitForTimeout(800);
await page.waitForTimeout(1500);
console.log("after ArrowDown+Enter", page.url(), await page.evaluate(() => document.body.innerHTML.slice(0, 200)), JSON.stringify(received));
await ctx.close();
srv.close();
