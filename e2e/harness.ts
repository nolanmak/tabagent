// E2E harness (#22): fixture servers + real bridge process + Chromium with the
// unpacked extension + real pairing through the pairing screen + MCP stdio client.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    this.port = await freePort();
    // Write config up-front so the bridge listens on our free port.
    writeFileSync(join(this.home, "config.json"), JSON.stringify({ port: this.port }));
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

    // Real pairing through the pairing screen.
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
   * D17: the harness turns `devAllowSensitive` on so D18-gated effects run in tests; `extra`
   * is any other settings patch (tests of the refusal pass devAllowSensitive: false).
   */
  async trustFixtures(extra: Record<string, unknown> = {}) {
    await this.sw.evaluate(async (e) => (globalThis as any).__tabagent.updateSettings({ devAllowSensitive: true, ...e }), extra);
  }

  async mcp(opts: { profile?: string; label?: string } = {}): Promise<Client> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: this.home };
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

  async stop() {
    for (const c of this.clients) await c.close().catch(() => {});
    await this.ctx?.close().catch(() => {});
    this.bridge?.kill();
    for (const s of this.servers) s.close();
  }
}
