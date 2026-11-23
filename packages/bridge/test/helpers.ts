import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@tabagent/protocol";
import { loadConfig } from "../src/config";
import { Daemon, type DaemonOpts } from "../src/daemon";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

export function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "tabagent-test-"));
  process.env.TABAGENT_HOME = h;
  delete process.env.TABAGENT_PORT;
  return h;
}

export async function startDaemon(opts: DaemonOpts = {}, home = tempHome()) {
  const cfg = loadConfig();
  cfg.port = 0;
  const d = new Daemon(cfg, { log: () => {}, extWaitMs: 50, ...opts });
  await d.start();
  return { d, home, cfg, base: `http://127.0.0.1:${d.port}` };
}

export class FakeExt {
  ws: WebSocket;
  msgs: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;
  /** Auto-reply to commands; return a Result envelope (without type/id) or undefined to stay silent. */
  onCommand?: (cmd: any) => any;

  constructor(port: number, id = EXT_ID, origin = `chrome-extension://${id}`) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin });
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      this.msgs.push(m);
      if (m.type === "command" && this.onCommand) {
        const r = this.onCommand(m);
        if (r) this.send({ type: "result", id: m.id, ...r });
      }
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    this.closed = new Promise((r) => this.ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
  }

  opened() {
    return new Promise<void>((res, rej) => {
      if (this.ws.readyState === 1) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  next(type: string, pred: (m: any) => boolean = () => true, ms = 3000): Promise<any> {
    const hit = this.msgs.find((m) => m.type === type && pred(m) && !m.__seen);
    if (hit) {
      hit.__seen = true;
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}; got ${JSON.stringify(this.msgs)}`)), ms);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m),
        resolve: (m) => {
          clearTimeout(t);
          m.__seen = true;
          resolve(m);
        },
      });
    });
  }

  async hello(extra: Record<string, unknown>) {
    await this.opened();
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, extensionVersion: "9.9.9", ...extra });
    return Promise.race([this.next("welcome"), this.next("error")]);
  }

  close() {
    this.ws.close();
  }
}

/** Pair a fake extension and leave it connected. */
export async function pairedExt(d: Daemon, id = EXT_ID, features: string[] = []) {
  const e = new FakeExt(d.port, id);
  const w = await e.hello({ pairCode: d.pairCode, features });
  if (w.type !== "welcome") throw new Error(JSON.stringify(w));
  return e;
}

export function okEnvelope(result: unknown, tool = "x", extra: Record<string, unknown> = {}) {
  return { ok: true, result, audit: { tool, origin: "http://a.test", params: {}, outcome: "ok", resultSummary: { bytes: 1, sha256: "x" } }, ...extra };
}

export async function rest(base: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
