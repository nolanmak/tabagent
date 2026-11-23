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
import { DEV_EXTENSION_ID, toMcpName } from "../packages/protocol/src/index";

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

  async setPolicies(policies: Record<string, string>, extra: Record<string, unknown> = {}) {
    await this.sw.evaluate(async ([p, e]) => (globalThis as any).__tabagent.updateSettings({ policies: p, ...e }), [policies, extra] as const);
  }

  /** Grant full access to both fixture origins (most tests). */
  async trustFixtures(extra: Record<string, unknown> = {}) {
    await this.setPolicies({ [this.A]: "full", [this.B]: "full" }, { sensitiveAllowed: {}, paused: false, ...extra });
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
      json = JSON.parse(first);
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

  /** Wait for a permission prompt window and answer it. */
  async answerPrompt(answer: "once" | "always" | "deny", trigger: () => Promise<unknown>) {
    const pageP = this.ctx.waitForEvent("page", { predicate: (p) => p.url().includes("prompt.html"), timeout: 15000 });
    const resP = trigger();
    const page = await pageP;
    await page.waitForSelector(`#${answer}`);
    const title = await page.textContent("#title");
    const reasons = await page.textContent("#reasons");
    await page.click(`#${answer}`);
    return { result: await resP, title, reasons };
  }

  async stop() {
    for (const c of this.clients) await c.close().catch(() => {});
    await this.ctx?.close().catch(() => {});
    this.bridge?.kill();
    for (const s of this.servers) s.close();
  }
}
