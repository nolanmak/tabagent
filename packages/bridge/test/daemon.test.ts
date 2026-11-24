import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@tabagent/protocol";
import { loadConfig } from "../src/config";
import type { Daemon } from "../src/daemon";
import { EXT_ID, FakeExt, OTHER_ID, okEnvelope, pairedExt, rest, startDaemon, tempHome } from "./helpers";

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});
async function boot(opts = {}) {
  const r = await startDaemon(opts);
  daemons.push(r.d);
  return r;
}

describe("pairing (D4)", () => {
  it("valid pair code -> welcome with secret + protocolVersion; ID recorded; code is single use", async () => {
    const { d, home } = await boot();
    const code = d.pairCode!;
    const e = new FakeExt(d.port);
    const w = await e.hello({ pairCode: code });
    expect(w).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION, secret: d.cfg.secret });
    expect(typeof w.bridgeVersion).toBe("string");
    const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(disk.extensionIds).toEqual([EXT_ID]);
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    e.close();
    await e.closed;
    const again = new FakeExt(d.port, OTHER_ID);
    const r = await again.hello({ pairCode: code });
    expect(r.type).toBe("error");
    expect(r.error.code).toBe("UNAUTHORIZED");
  });

  it("5 wrong codes invalidate the code; `pair` mints a fresh one", async () => {
    const { d, base, cfg } = await boot();
    const code = d.pairCode!;
    for (let i = 0; i < 5; i++) {
      const e = new FakeExt(d.port);
      const r = await e.hello({ pairCode: "ZZZ-ZZZ" });
      expect(r.error.code).toBe("UNAUTHORIZED");
      e.close();
    }
    const late = new FakeExt(d.port);
    const r = await late.hello({ pairCode: code });
    expect(r.type).toBe("error");
    expect(r.error.message).toMatch(/invalidated|No valid/);
    expect(d.pairCode).toBeNull();
    const minted = await rest(base, "/v1/pair", cfg.secret, {});
    expect(minted.body.pairCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(minted.body.expiresInSec).toBe(30 * 60);
    const ok = new FakeExt(d.port);
    expect((await ok.hello({ pairCode: minted.body.pairCode.toLowerCase() })).type).toBe("welcome");
    ok.close();
  });

  it("a code still works at 29 minutes (30-minute lifetime)", async () => {
    let now = 1_000_000;
    const { d } = await boot({ now: () => now });
    const code = d.pairCode!;
    now += 29 * 60_000;
    expect(d.pairCode).toBe(code);
    const e = new FakeExt(d.port);
    expect((await e.hello({ pairCode: code })).type).toBe("welcome");
  });

  it("an expired code is rejected (fake clock past 30 min)", async () => {
    let now = 1_000_000;
    const { d } = await boot({ now: () => now });
    const code = d.pairCode!;
    now += 30 * 60_000 + 1;
    expect(d.pairCode).toBeNull();
    const e = new FakeExt(d.port);
    const r = await e.hello({ pairCode: code });
    expect(r.error.message).toMatch(/expired/);
  });

  it("correct secret from an unknown ID is rejected; known ID accepted (no secret echoed)", async () => {
    const { d } = await boot();
    const e = await pairedExt(d);
    e.close();
    await e.closed;
    const stranger = new FakeExt(d.port, OTHER_ID);
    const r = await stranger.hello({ secret: d.cfg.secret });
    expect(r.error.code).toBe("UNAUTHORIZED");
    expect(r.error.message).toContain("not paired");
    expect(r.error.message).not.toMatch(/secret/i); // the extension clears its secret only on a wrong secret
    const known = new FakeExt(d.port);
    const w = await known.hello({ secret: d.cfg.secret });
    expect(w.type).toBe("welcome");
    expect(w.secret).toBeUndefined();
    known.close();
  });

  it("wrong secret and no credentials are refused", async () => {
    const { d } = await boot();
    const a = new FakeExt(d.port);
    expect((await a.hello({ secret: "nope" })).error.message).toMatch(/Unknown secret/);
    const b = new FakeExt(d.port);
    expect((await b.hello({})).error.message).toMatch(/Not paired/);
    const c = new FakeExt(d.port);
    await c.opened();
    c.send({ type: "ping" });
    expect((await c.next("error")).error.message).toMatch(/hello/);
  });

  it("legacy hello {version, extensionId} still pairs (protocol 1)", async () => {
    const { d } = await boot();
    const e = new FakeExt(d.port);
    await e.opened();
    e.send({ type: "hello", pairCode: d.pairCode, version: "0.1.0", extensionId: "ignored" });
    expect((await e.next("welcome")).secret).toBe(d.cfg.secret);
    e.close();
  });

  it("secret is stable across restarts", async () => {
    tempHome();
    const a = loadConfig().secret;
    const b = loadConfig().secret;
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("origin check", () => {
  async function upgrade(port: number, origin?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, origin ? { origin } : {});
    return new Promise<string>((res) => {
      ws.on("unexpected-response", (_q, resp) => res(String(resp.statusCode)));
      ws.on("error", (e) => res("error:" + e.message));
      ws.on("open", () => {
        res("open");
        ws.close();
      });
    });
  }
  it("web origin and missing origin are refused; extension origin upgrades", async () => {
    const { d } = await boot();
    expect(await upgrade(d.port, "https://evil.example")).toBe("403");
    expect(await upgrade(d.port)).toBe("403");
    expect(await upgrade(d.port, `chrome-extension://${EXT_ID}`)).toBe("open");
  });
  it("wrong path is refused", async () => {
    const { d } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/other`, { origin: `chrome-extension://${EXT_ID}` });
    const r = await new Promise<string>((res) => {
      ws.on("unexpected-response", (_q, resp) => res(String(resp.statusCode)));
      ws.on("error", () => res("error"));
    });
    expect(r).not.toBe("open");
  });
});

describe("version handshake (D5)", () => {
  it.each([
    [PROTOCOL_VERSION + 1, /npm package/],
    [PROTOCOL_VERSION - 1, /extension/],
  ])("protocolVersion %i -> VERSION_MISMATCH naming the side to update", async (v, side) => {
    const { d } = await boot();
    const e = new FakeExt(d.port);
    await e.opened();
    e.send({ type: "hello", protocolVersion: v, extensionVersion: "1", pairCode: d.pairCode });
    const r = await e.next("error");
    expect(r.error.code).toBe("VERSION_MISMATCH");
    expect(r.error.hint).toMatch(side);
    await e.closed;
    expect(d.extensionConnected).toBe(false);
  });
});

describe("one extension connection (D4)", () => {
  it("same ID replaces the old socket; its in-flight action fails NO_EXTENSION at once (not re-sent)", async () => {
    const { d, base, cfg } = await boot();
    const first = await pairedExt(d);
    const call = rest(base, "/v1/act.click", cfg.secret, { ref: "e1" });
    await first.next("command");
    const second = new FakeExt(d.port);
    expect((await second.hello({ secret: cfg.secret })).type).toBe("welcome");
    const r = await call;
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("NO_EXTENSION");
    // An action may already have run in the old worker; re-sending could click twice.
    expect(second.msgs.some((m) => m.type === "command")).toBe(false);
    expect((await first.closed).code).toBe(4002);
    second.onCommand = () => okEnvelope({ snapshot: "- x" }, "page.snapshot");
    expect((await rest(base, "/v1/page.snapshot", cfg.secret, {})).body.ok).toBe(true);
    second.close();
  });
  it("a different ID while one is connected is refused with the cause", async () => {
    const { d, cfg } = await boot();
    cfg.extensionIds.push(OTHER_ID);
    const first = await pairedExt(d);
    const other = new FakeExt(d.port, OTHER_ID);
    const r = await other.hello({ secret: cfg.secret });
    expect(r.error.code).toBe("UNAUTHORIZED");
    expect(r.error.message).toContain("already connected");
    expect(d.extensionConnected).toBe(true);
    first.close();
  });
});

describe("heartbeat (D11)", () => {
  it("ping -> pong", async () => {
    const { d } = await boot();
    const e = await pairedExt(d);
    e.send({ type: "ping" });
    expect((await e.next("pong")).type).toBe("pong");
    e.close();
  });
  it("silent for 45s (fake clock) -> socket closed, in-flight fails NO_EXTENSION", async () => {
    let now = 5_000_000;
    const { d, base, cfg } = await boot({ now: () => now, heartbeatCheckMs: 60_000 });
    const e = await pairedExt(d);
    const call = rest(base, "/v1/page.snapshot", cfg.secret, {});
    await e.next("command");
    now += 44_000;
    d.checkSilent();
    expect(d.extensionConnected).toBe(true);
    now += 2_000;
    d.checkSilent();
    expect(d.extensionConnected).toBe(false);
    const r = await call;
    expect(r.body.error.code).toBe("NO_EXTENSION");
    await e.closed;
  });
  it("any message counts as activity", async () => {
    let now = 5_000_000;
    const { d } = await boot({ now: () => now, heartbeatCheckMs: 60_000 });
    const e = await pairedExt(d);
    now += 40_000;
    e.send({ type: "ping" });
    await e.next("pong");
    now += 40_000;
    d.checkSilent();
    expect(d.extensionConnected).toBe(true);
    e.close();
  });
});

// Reload race (Legion, 2026-11-23): "Extension disconnected", then two "Extension connected" in the same
// second, then "silent for 45s" and a reconnect; commands in that window failed NO_EXTENSION.
describe("extension reload (D4 + D11)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settled = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "settled" as const), sleep(ms).then(() => "pending" as const)]);

  it("two near-simultaneous hellos from the same ID leave exactly one active socket, and commands go to it", async () => {
    const { d, base, cfg } = await boot();
    const old = await pairedExt(d);
    old.close();
    await old.closed;
    const a = new FakeExt(d.port);
    const b = new FakeExt(d.port);
    await Promise.all([a.opened(), b.opened()]);
    a.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0", secret: cfg.secret });
    b.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0", secret: cfg.secret });
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    const loser = await Promise.race([a.closed.then(() => a), b.closed.then(() => b), sleep(1000).then(() => null)]);
    expect(loser).not.toBeNull();
    expect((await loser!.closed).code).toBe(4002);
    const winner = loser === a ? b : a;
    expect(winner.ws.readyState).toBe(WebSocket.OPEN);
    expect(d.extensionConnected).toBe(true);
    expect([...(d as any).wss.clients].filter((c: WebSocket) => c.readyState === WebSocket.OPEN)).toHaveLength(1);
    winner.onCommand = () => okEnvelope({ snapshot: "- live" }, "page.snapshot");
    const r = await rest(base, "/v1/page.snapshot", cfg.secret, {});
    expect(r.body.ok).toBe(true);
    expect(r.body.result.snapshot).toContain("- live");
    winner.close();
  });

  it("a read-only command in flight on the replaced socket is re-sent to the new one and succeeds at once", async () => {
    const { d, base, cfg } = await boot();
    const first = await pairedExt(d); // never answers: its worker went away with the reload
    const started = Date.now();
    const call = rest(base, "/v1/page.snapshot", cfg.secret, {});
    const cmd = await first.next("command");
    const second = new FakeExt(d.port);
    second.onCommand = () => okEnvelope({ snapshot: "- after reload" }, "page.snapshot");
    expect((await second.hello({ secret: cfg.secret })).type).toBe("welcome");
    const r = await call;
    expect(r.body.ok).toBe(true);
    expect(r.body.result.snapshot).toContain("- after reload");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(second.msgs.find((m) => m.type === "command")).toMatchObject({ id: cmd.id, tool: "page.snapshot" });
    expect((await first.closed).code).toBe(4002);
    second.close();
  });

  it("a socket already silent for 45s gets no new commands; the call waits for the reconnect and succeeds", async () => {
    let now = 5_000_000;
    const { d, base, cfg } = await boot({ now: () => now, heartbeatCheckMs: 60_000, extWaitMs: 3_000 });
    const stale = await pairedExt(d);
    now += 46_000; // the 5s sweep has not run yet
    const call = rest(base, "/v1/page.snapshot", cfg.secret, {});
    expect(await settled(stale.closed, 1_000)).toBe("settled");
    const fresh = new FakeExt(d.port);
    fresh.onCommand = () => okEnvelope({ snapshot: "- fresh" }, "page.snapshot");
    expect((await fresh.hello({ secret: cfg.secret })).type).toBe("welcome");
    const r = await call;
    expect(r.body.ok).toBe(true);
    expect(stale.msgs.some((m) => m.type === "command")).toBe(false);
    fresh.close();
  });

  it("with a single socket, 44s of silence still routes commands to it (the 45s rule is unchanged)", async () => {
    let now = 5_000_000;
    const { d, base, cfg } = await boot({ now: () => now, heartbeatCheckMs: 60_000 });
    const e = await pairedExt(d);
    e.onCommand = () => okEnvelope({ snapshot: "- ok" }, "page.snapshot");
    now += 44_000;
    const r = await rest(base, "/v1/page.snapshot", cfg.secret, {});
    expect(r.body.ok).toBe(true);
    expect(d.extensionConnected).toBe(true);
    e.close();
  });

  it("with a single socket, a silent close is followed by a working reconnect", async () => {
    let now = 5_000_000;
    const { d, base, cfg } = await boot({ now: () => now, heartbeatCheckMs: 60_000 });
    const e = await pairedExt(d);
    now += 46_000;
    d.checkSilent();
    expect(d.extensionConnected).toBe(false);
    await e.closed;
    const again = new FakeExt(d.port);
    again.onCommand = () => okEnvelope({ snapshot: "- back" }, "page.snapshot");
    expect((await again.hello({ secret: cfg.secret })).type).toBe("welcome");
    expect((await rest(base, "/v1/page.snapshot", cfg.secret, {})).body.ok).toBe(true);
    again.close();
  });
});

describe("events (D20)", () => {
  it("kill/resume/prompt/decision events are logged", async () => {
    const { d, home } = await boot();
    const e = await pairedExt(d);
    for (const ev of ["prompt", "decision", "killed", "resumed"]) e.send({ type: "event", event: ev, data: { origin: "http://a.test" } });
    e.send({ type: "ping" });
    await e.next("pong");
    const log = readFileSync(join(home, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((l) => l.event)).toEqual(["prompt", "decision", "killed", "resumed"]);
    expect(log[0].data).toEqual({ origin: "http://a.test" });
    e.close();
  });
});
