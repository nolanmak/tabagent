// The stdio proxy's side of the agent inbox (AD4, AD5): registration headers, reconnect with backoff
// after the stream drops, ensureDaemon before each reconnect, and the ack for each push.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InboxClient } from "../src/inbox-client";

let server: Server;
let client: InboxClient | null = null;

afterEach(async () => {
  client?.stop();
  client = null;
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

interface Seen {
  opens: { headers: IncomingMessage["headers"]; res: ServerResponse }[];
  acks: { headers: IncomingMessage["headers"]; body: any }[];
}

async function fakeBridge(onOpen: (res: ServerResponse, n: number) => void, status = 200): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = { opens: [], acks: [] };
  server = createServer((req, res) => {
    if (req.url === "/v1/inbox" && req.method === "GET") {
      seen.opens.push({ headers: req.headers, res });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end('{"ok":false}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: ready\ndata: {"sessionId":"s"}\n\n`);
      onOpen(res, seen.opens.length);
      return;
    }
    if (req.url === "/v1/inbox/ack" && req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.acks.push({ headers: req.headers, body: JSON.parse(b) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, seen };
}

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met");
}

const hdrs = () => ({ "x-tabagent-mcp": "1", "x-tabagent-session": "9-abcdef", "x-tabagent-client": "claude-code", "x-tabagent-agent-pid": "5918", "x-tabagent-channels": "0", "x-tabagent-profile": "core" });

describe("InboxClient", () => {
  it("registers with the bearer and the session headers, then reports connected", async () => {
    const { port, seen } = await fakeBridge(() => {});
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true });
    client.start();
    await until(() => client!.connected);
    const h = seen.opens[0].headers;
    expect(h.authorization).toBe("Bearer sek");
    expect(h.accept).toBe("text/event-stream");
    expect([h["x-tabagent-session"], h["x-tabagent-client"], h["x-tabagent-agent-pid"], h["x-tabagent-channels"], h["x-tabagent-profile"]]).toEqual(["9-abcdef", "claude-code", "5918", "0", "core"]);
  });

  it("acks each push with POST /v1/inbox/ack {msgId} after handing it to onPush", async () => {
    const order: string[] = [];
    const { port, seen } = await fakeBridge((res) => res.write(`event: message\ndata: {"msgId":"m1","content":"x"}\n\n`));
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true, onPush: (m) => void order.push(`push:${m.msgId}`) });
    client.start();
    await until(() => seen.acks.length === 1);
    expect(order).toEqual(["push:m1"]);
    expect(seen.acks[0].body).toEqual({ msgId: "m1" });
    expect(seen.acks[0].headers["x-tabagent-session"]).toBe("9-abcdef");
    expect(seen.acks[0].headers.authorization).toBe("Bearer sek");
  });

  it("a push that onPush refuses (throws) is never acked, and later pushes still are (AD9 channel timeout)", async () => {
    const logs: string[] = [];
    const { port, seen } = await fakeBridge((res) => res.write(`event: message\ndata: {"msgId":"bad","kind":"x"}\n\nevent: message\ndata: {"msgId":"ok","kind":"channel"}\n\n`));
    client = new InboxClient({
      port,
      token: "sek",
      headers: hdrs,
      ensureDaemon: async () => true,
      log: (m) => logs.push(m),
      onPush: async (m) => {
        if (m.kind !== "channel") throw new Error("unknown push kind");
      },
    });
    client.start();
    await until(() => seen.acks.length === 1);
    expect(seen.acks.map((a) => a.body)).toEqual([{ msgId: "ok" }]);
    expect(logs.some((l) => l.includes("push bad failed: unknown push kind"))).toBe(true);
  });

  it("a push without a msgId is ignored (no ack)", async () => {
    const pushes: unknown[] = [];
    const { port, seen } = await fakeBridge((res) => res.write(`event: message\ndata: {"content":"x"}\n\nevent: message\ndata: not json\n\n`));
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true, onPush: (m) => void pushes.push(m) });
    client.start();
    await until(() => client!.connected);
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes).toEqual([]);
    expect(seen.acks).toEqual([]);
  });

  it("reconnects with backoff after the stream ends, calling ensureDaemon first (daemon respawn)", async () => {
    const { port, seen } = await fakeBridge((res, n) => {
      if (n <= 2) res.end();
    });
    let ensured = 0;
    const waits: number[] = [];
    client = new InboxClient({
      port,
      token: "sek",
      headers: hdrs,
      ensureDaemon: async () => void ensured++,
      sleep: async (ms) => void waits.push(ms),
    });
    client.start();
    await until(() => seen.opens.length === 3 && client!.connected);
    expect(ensured).toBe(2);
    // Short-lived streams keep growing the delay: 1 s, then 2 s.
    expect(waits).toEqual([1000, 2000]);
  });

  it("an HTTP error (bad token) keeps retrying with growing backoff, capped at 30 s", async () => {
    const { port, seen } = await fakeBridge(() => {}, 401);
    const waits: number[] = [];
    client = new InboxClient({ port, token: "bad", headers: hdrs, ensureDaemon: async () => true, sleep: async (ms) => void waits.push(ms), log: () => {} });
    client.start();
    await until(() => seen.opens.length >= 8);
    client.stop();
    expect(waits.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(client.connected).toBe(false);
  });

  it("a stream that lived a long time resets the backoff to 1 s", async () => {
    let t = 0;
    const { port, seen } = await fakeBridge((res, n) => {
      if (n === 1) {
        t += 60_000;
        res.end();
      }
    });
    const waits: number[] = [];
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true, sleep: async (ms) => void waits.push(ms), now: () => t });
    client.start();
    await until(() => seen.opens.length === 2);
    expect(waits).toEqual([1000]);
  });

  it("stop() closes the stream and does not reconnect", async () => {
    const { port, seen } = await fakeBridge(() => {});
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true, sleep: async () => {} });
    client.start();
    await until(() => client!.connected);
    client.stop();
    await until(() => !client!.connected);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.opens).toHaveLength(1);
  });

  it("an unreachable bridge is retried, not thrown", async () => {
    const { port } = await fakeBridge(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    const waits: number[] = [];
    client = new InboxClient({ port, token: "sek", headers: hdrs, ensureDaemon: async () => true, sleep: async (ms) => void waits.push(ms) });
    client.start();
    await until(() => waits.length >= 2);
    expect(client.connected).toBe(false);
  });
});
