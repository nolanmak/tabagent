import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALARM_MINUTES, createBridgeClient, PING_MS, type WsLike } from "../src/background/bridgeClient";

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function client(cfg: { port: number; secret: string | null } = { port: 4000, secret: "s3" }) {
  const onMessage = vi.fn();
  const statuses: string[] = [];
  let secret = cfg.secret;
  const c = createBridgeClient({
    makeSocket: (u) => new FakeWs(u),
    loadConfig: async () => ({ port: cfg.port, secret }),
    saveSecret: async (s) => void (secret = s),
    onMessage,
    onStatus: (s) => statuses.push(s),
    protocolVersion: 1,
    extensionVersion: "0.1.0",
    extensionId: "ext",
    features: ["files.resolve"],
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as any),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as any),
  });
  return { c, onMessage, statuses, secret: () => secret };
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("bridge client", () => {
  it("unpaired without secret or code", async () => {
    const { c, statuses } = client({ port: 1, secret: null });
    await c.connect();
    expect(FakeWs.all).toHaveLength(0);
    expect(statuses).toEqual(["unpaired"]);
  });
  it("sends the D4 hello with protocolVersion, extensionVersion, features and the secret", async () => {
    const { c } = client();
    await c.connect();
    const ws = FakeWs.all[0];
    expect(ws.url).toBe("ws://127.0.0.1:4000/ext");
    ws.open();
    expect(ws.sent[0]).toMatchObject({ type: "hello", protocolVersion: 1, extensionVersion: "0.1.0", secret: "s3", features: ["files.resolve"] });
  });
  it("pairing stores the secret from welcome and drops the code", async () => {
    const { c, secret } = client({ port: 1, secret: null });
    await c.pair(" ab1-cd2 ");
    const ws = FakeWs.all[0];
    ws.open();
    expect(ws.sent[0].pairCode).toBe("AB1-CD2");
    ws.msg({ type: "welcome", protocolVersion: 1, bridgeVersion: "x", secret: "new" });
    await flush();
    expect(secret()).toBe("new");
    expect(c.status()).toBe("connected");
  });
  it("heartbeat: ping every 20s once welcomed", async () => {
    const { c } = client();
    await c.connect();
    const ws = FakeWs.all[0];
    ws.open();
    ws.msg({ type: "welcome", protocolVersion: 1, bridgeVersion: "x" });
    await flush();
    vi.advanceTimersByTime(PING_MS * 3);
    expect(ws.sent.filter((m) => m.type === "ping")).toHaveLength(3);
    ws.msg({ type: "pong" });
    expect(PING_MS).toBe(20_000);
    expect(ALARM_MINUTES * 60_000).toBe(30_000);
  });
  it("alarm tick reconnects when the socket is closed, and is a no-op while open", async () => {
    const { c } = client();
    await c.connect();
    FakeWs.all[0].open();
    c.tick();
    await flush();
    expect(FakeWs.all).toHaveLength(1);
    FakeWs.all[0].close();
    c.tick();
    await flush();
    expect(FakeWs.all).toHaveLength(2);
  });
  it("backoff reconnect after close", async () => {
    const { c } = client();
    await c.connect();
    FakeWs.all[0].close();
    vi.advanceTimersByTime(500);
    await flush();
    expect(FakeWs.all).toHaveLength(2);
  });
  it("send only after welcome; commands and files.resolved pass through", async () => {
    const { c, onMessage } = client();
    await c.connect();
    const ws = FakeWs.all[0];
    ws.open();
    expect(c.send({ type: "x" })).toBe(false);
    ws.msg({ type: "welcome", protocolVersion: 1, bridgeVersion: "x" });
    await flush();
    expect(c.send({ type: "x" })).toBe(true);
    ws.msg({ type: "command", id: "1" });
    ws.msg({ type: "files.resolved", id: "f" });
    ws.onmessage({ data: "not json" });
    expect(onMessage.mock.calls.map((x) => x[0].type)).toEqual(["command", "files.resolved"]);
  });
  it("UNAUTHORIZED about the secret clears it and stops reconnecting", async () => {
    const { c, secret } = client();
    await c.connect();
    const ws = FakeWs.all[0];
    ws.open();
    ws.msg({ type: "error", error: { code: "UNAUTHORIZED", message: "bad secret" } });
    await flush();
    await flush();
    expect(secret()).toBeNull();
    expect(c.status()).toBe("pair-failed");
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });
  it("VERSION_MISMATCH stops reconnecting and keeps the hint", async () => {
    const { c } = client();
    await c.connect();
    FakeWs.all[0].open();
    FakeWs.all[0].msg({ type: "error", error: { code: "VERSION_MISMATCH", message: "protocol 2 vs 1", hint: "Update the extension" } });
    await flush();
    expect(c.status()).toBe("version-mismatch");
    expect(c.lastError()).toContain("Update the extension");
    c.tick();
    await flush();
    expect(FakeWs.all).toHaveLength(1);
    await c.reconnect();
    expect(FakeWs.all).toHaveLength(2);
  });
  it("other errors pass through; disconnect sets unpaired", async () => {
    const { c, onMessage } = client();
    await c.connect();
    FakeWs.all[0].open();
    FakeWs.all[0].msg({ type: "error", error: { code: "INTERNAL", message: "x" } });
    await flush();
    expect(onMessage).toHaveBeenCalled();
    c.disconnect();
    expect(c.status()).toBe("unpaired");
  });
  it("socket constructor failure -> disconnected and retry", async () => {
    let n = 0;
    const c = createBridgeClient({
      makeSocket: () => {
        n++;
        throw new Error("blocked");
      },
      loadConfig: async () => ({ port: 1, secret: "s" }),
      saveSecret: async () => {},
      onMessage: () => {},
      protocolVersion: 1,
      extensionVersion: "x",
      extensionId: "x",
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as any),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
    });
    await c.connect();
    expect(c.status()).toBe("disconnected");
    vi.advanceTimersByTime(500);
    await flush();
    expect(n).toBe(2);
  });
});
