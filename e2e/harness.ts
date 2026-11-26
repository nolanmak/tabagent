// E2E harness: fixture servers + real bridge process + Chromium with the
// unpacked extension + real pairing through the side panel + MCP stdio client.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEV_EXTENSION_ID, toMcpName, unwrapDeep } from "../packages/protocol/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES = join(HERE, "fixtures");
const CLI = join(ROOT, "packages/bridge/dist/cli.js");
const EXT = join(ROOT, "packages/extension/dist");

function fixtureServer(host: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/data.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: ["alpha", "beta", "gamma"] }));
      return;
    }
    if (u.pathname === "/download/data.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="data.csv"' });
      res.end("name,qty\nwidget,3\ngadget,5\n");
      return;
    }
    if (u.pathname.startsWith("/p/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>${u.pathname}</title><h1>${u.pathname}</h1>`);
      return;
    }
    const file = join(FIXTURES, u.pathname === "/" ? "index.html" : u.pathname.replace(/\.\./g, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": extname(file) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({ server, origin: `http://${host}:${(server.address() as any).port}` })));
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

export interface CallResult {
  isError: boolean;
  text: string;
  json: any;
  image?: { data: string; mimeType: string };
}

export class Harness {
  A!: string; // http://localhost:port
  B!: string; // http://127.0.0.1:port (cross-site)
  servers: Server[] = [];
  home!: string;
  port!: number;
  bridge!: ChildProcess;
  bridgeLog = "";
  pairCode!: string;
  ctx!: BrowserContext;
  sw!: Worker;
  clients: Client[] = [];

  async start() {
    const a = await fixtureServer("localhost");
    const b = await fixtureServer("127.0.0.1");
    this.servers.push(a.server, b.server);
    this.A = a.origin;
    this.B = b.origin;
    this.home = mkdtempSync(join(tmpdir(), "tabagent-e2e-"));
    mkdirSync(join(this.home, "uploads"), { recursive: true });
    this.port = await freePort();
    // Write config up-front so uploads dir is our temp dir.
    writeFileSync(join(this.home, "config.json"), JSON.stringify({ port: this.port, uploadDirs: [join(this.home, "uploads")] }));
    this.bridge = spawn(process.execPath, [CLI, "serve"], { env: { ...process.env, TABAGENT_HOME: this.home }, stdio: ["ignore", "pipe", "pipe"] });
    this.pairCode = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("bridge did not start: " + this.bridgeLog)), 10000);
      const on = (d: Buffer) => {
        this.bridgeLog += d.toString();
        const m = this.bridgeLog.match(/pairing code: ([A-Z0-9]{3}-[A-Z0-9]{3})/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      };
      this.bridge.stdout!.on("data", on);
      this.bridge.stderr!.on("data", on);
    });

    const userDir = mkdtempSync(join(tmpdir(), "tabagent-chrome-"));
    this.ctx = await chromium.launchPersistentContext(userDir, {
      channel: "chromium",
      headless: process.env.HEADED ? false : true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      viewport: { width: 1200, height: 800 },
      acceptDownloads: true,
    });
    // Playwright auto-dismisses JS dialogs on pages without a listener; real Chrome doesn't.
    const keepDialogs = (p: Page) => p.on("dialog", () => {});
    this.ctx.pages().forEach(keepDialogs);
    this.ctx.on("page", keepDialogs);
    this.sw = this.ctx.serviceWorkers()[0] ?? (await this.ctx.waitForEvent("serviceworker"));
    if (!this.sw.url().includes(DEV_EXTENSION_ID)) throw new Error(`Unexpected extension id: ${this.sw.url()}`);
    await this.sw.evaluate(async (port) => (globalThis as any).__tabagent.updateSettings({ port }), this.port);

    // Real pairing through the side panel UI.
    const panel = await this.openPanel();
    await panel.fill("#pairCode", this.pairCode);
    await panel.click("#pairBtn");
    await panel.waitForFunction(() => document.getElementById("status")?.textContent === "Connected", null, { timeout: 15000 });
    await panel.close();
  }

  async openPanel(): Promise<Page> {
    const p = await this.ctx.newPage();
    await p.goto(`chrome-extension://${DEV_EXTENSION_ID}/sidepanel.html`);
    return p;
  }

  /**
   * Set site policies. `policies` maps origin -> "read"|"act"|"full"|"deny" (written to the
   * `sites` settings shape, contract §7); `extra` is any other settings patch.
   * Legacy `extra.liteSites` (host globs) marks matching fixture origins lite.
   */
  async setPolicies(policies: Record<string, string>, extra: Record<string, unknown> = {}) {
    const { liteSites, sensitiveAllowed: _legacy, sites: extraSites, ...rest } = extra as { liteSites?: string[]; sensitiveAllowed?: unknown; sites?: Record<string, unknown> };
    const sites: Record<string, Record<string, unknown>> = {};
    for (const [o, p] of Object.entries(policies)) if (p !== "ask") sites[o] = { policy: p };
    for (const g of liteSites ?? []) {
      for (const o of [this.A, this.B]) if (new URL(o).hostname === g) sites[o] = { ...sites[o], lite: true };
    }
    for (const [o, e] of Object.entries(extraSites ?? {})) sites[o] = { ...sites[o], ...(e as object) };
    await this.sw.evaluate(async ([s, e]) => (globalThis as any).__tabagent.updateSettings({ sites: s, liteSites: [], ...e }), [sites, rest] as const);
  }

  /**
   * Grant full access to both fixture origins (most tests). Sensitive gates are bypassed
   * with `devAllowSensitive` (D17) unless `extra` says otherwise; answerPrompt() re-enables
   * them for the duration of its trigger.
   */
  async trustFixtures(extra: Record<string, unknown> = {}) {
    await this.setPolicies({ [this.A]: "full", [this.B]: "full" }, { paused: false, devAllowSensitive: true, ...extra });
  }

  async mcp(opts: { profile?: string; label?: string; token?: string } = {}): Promise<Client> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: this.home };
    if (opts.token) env.TABAGENT_TOKEN = opts.token;
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--profile", opts.profile ?? "full", ...(opts.label ? ["--label", opts.label] : [])], env, stderr: "pipe" });
    const client = new Client({ name: opts.label ?? "e2e-agent", version: "1.0.0" });
    await client.connect(transport);
    this.clients.push(client);
    return client;
  }

  async call(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const r: any = await client.callTool({ name: toMcpName(tool), arguments: args }, undefined, { timeout: 150_000 });
    const texts = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
    const image = (r.content ?? []).find((c: any) => c.type === "image");
    const text = texts.join("\n");
    let json: any = null;
    const first = text.split("\n")[0];
    try {
      json = unwrapDeep(JSON.parse(first));
    } catch {
      /* not json */
    }
    return { isError: !!r.isError, text, json, image };
  }

  /** Like call() but throws on tool errors. */
  async ok(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const r = await this.call(client, tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r;
  }

  /** Find a ref in snapshot text by a line regex. */
  static ref(snapshot: string, re: RegExp): string {
    const line = snapshot.split("\n").find((l) => re.test(l));
    const m = line?.match(/\[ref=([a-z]\d+)\]/);
    if (!m) throw new Error(`No ref matching ${re} in:\n${snapshot}`);
    return m[1];
  }

  /** Pending prompts in the service worker (FIFO). */
  async pendingPrompts(): Promise<any[]> {
    return this.sw.evaluate(() => (globalThis as any).__tabagent.pendingPrompts());
  }

  /**
   * Run `trigger`, wait for the permission prompt it raises, and answer it through the real
   * side-panel page buttons (D19: prompts are answered in the side panel, never in the page).
   * Sensitive gates are switched on (devAllowSensitive=false) while the trigger runs.
   */
  async answerPrompt(answer: "once" | "always" | "deny", trigger: () => Promise<unknown>) {
    const prevDev = await this.sw.evaluate(async () => (await (globalThis as any).__tabagent.getSettings()).devAllowSensitive);
    await this.sw.evaluate(async () => (globalThis as any).__tabagent.updateSettings({ devAllowSensitive: false }));
    const before = new Set((await this.pendingPrompts()).map((p) => p.promptId));
    try {
      let settled = false;
      const resP = trigger().finally(() => (settled = true));
      resP.catch(() => {});
      let prompt: any = null;
      const end = Date.now() + 15000;
      while (!prompt && Date.now() < end) {
        prompt = (await this.pendingPrompts()).find((p) => !before.has(p.promptId)) ?? null;
        if (!prompt) {
          if (settled) throw new Error(`answerPrompt: the call finished without a prompt: ${JSON.stringify(await resP)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!prompt) throw new Error("answerPrompt: no prompt appeared within 15s");
      const panel = await this.openPanel();
      try {
        const item = panel.locator(`li[data-prompt-id="${prompt.promptId}"]`);
        await item.waitFor({ timeout: 10000 });
        const title = await item.locator(".ptitle").textContent();
        const reasons = await item.locator(".preasons").textContent();
        const summary = await item.locator(".psummary").textContent();
        await item.locator(`button[data-a="${answer}"]`).click();
        return { result: await resP, title, reasons, summary, prompt };
      } finally {
        await panel.close().catch(() => {});
      }
    } finally {
      await this.sw.evaluate(async (v) => (globalThis as any).__tabagent.updateSettings({ devAllowSensitive: v }), prevDev);
    }
  }

  async stop() {
    for (const c of this.clients) await c.close().catch(() => {});
    await this.ctx?.close().catch(() => {});
    this.bridge?.kill();
    for (const s of this.servers) s.close();
  }
}
