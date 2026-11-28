// agents.list -> agents.listed over the paired /ext socket (spec AD2, AD10, AD16, §5), against a stub
// `claude` on a temp PATH and a fake Codex app-server on a temp unix socket.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { AgentsListedSchema, PROTOCOL_VERSION } from "@tabagent/protocol";
import { AgentDiscovery } from "../src/agents/discovery-service";
import type { Daemon } from "../src/daemon";
import { claudeRecord, codexThread, FakeCodex, NO_REPLY, StubClaude } from "./agents-fakes";
import { FakeExt, pairedExt, rest, startDaemon } from "./helpers";

let claude: StubClaude;
let codex: FakeCodex;
let d: Daemon;
let ext: FakeExt | undefined;

beforeEach(async () => {
  claude = new StubClaude();
  codex = await new FakeCodex().listen();
});
afterEach(async () => {
  ext?.close();
  ext = undefined;
  await d?.stop();
  await codex.close();
  claude.cleanup();
});

async function list(e: FakeExt, id = "l1") {
  e.send({ type: "agents.list", id });
  return e.next("agents.listed", (m) => m.id === id, 8000);
}

describe("agents.list over the extension socket", () => {
  it("welcome advertises the agents feature (AD16)", async () => {
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket } }));
    const e = new FakeExt(d.port);
    const w = await e.hello({ pairCode: d.pairCode, features: ["files.resolve", "agents"] });
    expect(w).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION, features: expect.arrayContaining(["agents"]) });
    ext = e;
  });

  it("merges claude (interactive + background) and codex agents; both sources ok", async () => {
    claude.agents([claudeRecord(10, 1000), claudeRecord(11, 2000, { kind: "background", state: "running", status: undefined })]);
    codex.threads([codexThread("t-idle"), codexThread("t-busy", { type: "active", activeFlags: ["waitingOnApproval"] }), codexThread("t-off", { type: "notLoaded" })]);
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(AgentsListedSchema.safeParse(r).success).toBe(true);
    expect(r.sources).toEqual({ claude: "ok", codex: "ok" });
    const byId = Object.fromEntries(r.agents.map((a: any) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(["claude:10:1000", "claude:11:2000", "codex:t-busy", "codex:t-idle"]);
    expect(byId["codex:t-busy"]).toMatchObject({ status: "busy", statusLabel: "waitingOnApproval", delivery: "queue", linked: false, canDriveTab: false });
    expect(byId["claude:11:2000"]).toMatchObject({ status: "busy", delivery: "none", pid: 11 });
    // Never --all; handshake is initialize + initialized; the daemon is never started by us.
    expect(claude.calls()).toEqual(["agents --json"]);
    expect(codex.initializedSeen).toBe(1);
    expect(codex.calls("initialize")[0].params.clientInfo.name).toBe("tabagent");
  });

  it("#137: a Claude session's title comes from its transcript (custom over ai), else its name", async () => {
    const projects = claude.projectsDir;
    claude.transcript("/work/a", "sid-a", [{ type: "user", message: { content: "hi" } }, { type: "ai-title", aiTitle: "Pending user input check", sessionId: "sid-a" }]);
    claude.transcript("/work/b", "sid-b", [{ type: "ai-title", aiTitle: "Auto" }, { type: "custom-title", customTitle: "My rename" }]);
    claude.agents([
      claudeRecord(10, 1000, { cwd: "/work/a", sessionId: "sid-a", name: "a-22" }),
      claudeRecord(11, 2000, { cwd: "/work/b", sessionId: "sid-b", name: "b-1f" }),
      claudeRecord(12, 3000, { cwd: "/work/c", sessionId: "sid-c", name: "c-0a" }),
    ]);
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: join(codex.dir, "missing.sock"), claudeProjectsDir: projects } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(AgentsListedSchema.safeParse(r).success).toBe(true);
    expect(Object.fromEntries(r.agents.map((a: any) => [a.id, a.title]))).toEqual({ "claude:10:1000": "Pending user input check", "claude:11:2000": "My rename", "claude:12:3000": "c-0a" });
    for (const a of r.agents) expect(a).not.toHaveProperty("sessionId");
    // A send re-resolves with the title too.
    expect((await d.agents.discovery.resolve("claude:11:2000"))?.title).toBe("My rename");
  });

  it("a missing claude binary and a missing codex socket give unavailable sources, never a failed call", async () => {
    ({ d } = await startDaemon({ agents: { claudeBin: join(claude.dir, "nope"), codexSocket: join(codex.dir, "missing.sock") } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(r).toMatchObject({ agents: [], sources: { claude: "unavailable", codex: "unavailable" } });
  });

  it.each([
    ["non-zero exit", { "agents.exit": 1, "agents.json": "[]" }],
    ["garbage output", { "agents.json": "Error: something" }],
    ["timeout", { "agents.sleep": 2, "agents.json": "[]" }],
  ])("claude source %s -> unavailable; codex still listed", async (_n, files) => {
    for (const [k, v] of Object.entries(files)) claude.set(k, v);
    codex.threads([codexThread("t1")]);
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket, claudeTimeoutMs: 500 } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(r.sources).toEqual({ claude: "unavailable", codex: "ok" });
    expect(r.agents.map((a: any) => a.id)).toEqual(["codex:t1"]);
  });

  it("codex thread/loaded/list error -> codex unavailable; one failing thread/read only drops that thread", async () => {
    claude.agents([claudeRecord(10, 1000)]);
    codex.on("thread/loaded/list", () => {
      throw { code: -32603, message: "boom" };
    });
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(r.sources).toEqual({ claude: "ok", codex: "unavailable" });
    expect(r.agents.map((a: any) => a.id)).toEqual(["claude:10:1000"]);

    codex.on("thread/loaded/list", () => ({ data: ["t1", "gone"], nextCursor: null }));
    codex.on("thread/read", ({ threadId }) => {
      if (threadId === "gone") throw { code: -32603, message: "no rollout found" };
      return { thread: codexThread("t1") };
    });
    d.agents.discovery.clearCache();
    const r2 = await list(ext, "l2");
    expect(r2.sources.codex).toBe("ok");
    expect(r2.agents.map((a: any) => a.id).sort()).toEqual(["claude:10:1000", "codex:t1"]);
  });

  it("follows thread/loaded/list pagination", async () => {
    codex.on("thread/loaded/list", ({ cursor }) => (cursor ? { data: ["t2"], nextCursor: null } : { data: ["t1"], nextCursor: "c1" }));
    codex.on("thread/read", ({ threadId }) => ({ thread: codexThread(threadId) }));
    ({ d } = await startDaemon({ agents: { claudeBin: join(claude.dir, "nope"), codexSocket: codex.socket } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(r.agents.map((a: any) => a.id).sort()).toEqual(["codex:t1", "codex:t2"]);
  });

  it("a codex server that never answers -> unavailable within the timeout", async () => {
    codex.on("thread/loaded/list", () => NO_REPLY);
    ({ d } = await startDaemon({ agents: { claudeBin: join(claude.dir, "nope"), codexSocket: codex.socket, codexTimeoutMs: 300 } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    const r = await list(ext);
    expect(r.sources.codex).toBe("unavailable");
  });

  it("finds `claude` on PATH by default", async () => {
    claude.agents([claudeRecord(10, 1000)]);
    const old = process.env.PATH;
    process.env.PATH = `${claude.dir}:${old}`;
    try {
      ({ d } = await startDaemon({ agents: { codexSocket: join(codex.dir, "missing.sock") } }));
      ext = await pairedExt(d, undefined, ["agents"]);
      const r = await list(ext);
      expect(r.sources.claude).toBe("ok");
      expect(r.agents[0].id).toBe("claude:10:1000");
    } finally {
      process.env.PATH = old;
    }
  });

  it("caches the list for 5 s for display; after that it re-runs the sources", async () => {
    let now = 1_000_000;
    claude.agents([claudeRecord(10, 1000)]);
    ({ d } = await startDaemon({ now: () => now, agents: { claudeBin: claude.bin, codexSocket: join(codex.dir, "missing.sock") } }));
    ext = await pairedExt(d, undefined, ["agents"]);
    await list(ext, "a");
    claude.agents([claudeRecord(10, 1000), claudeRecord(11, 2000)]);
    now += 4_000;
    expect((await list(ext, "b")).agents).toHaveLength(1);
    now += 1_500;
    expect((await list(ext, "c")).agents).toHaveLength(2);
    expect(claude.calls()).toHaveLength(2);
  });

  it("concurrent list requests share one discovery run", async () => {
    claude.agents([claudeRecord(10, 1000)]);
    const disc = new AgentDiscovery({ claudeBin: claude.bin, codexSocket: join(codex.dir, "missing.sock") });
    const [a, b] = await Promise.all([disc.list(), disc.list()]);
    // Links are applied per call (AD4), so the lists are equal, not identical; one run is what matters.
    expect(a).toEqual(b);
    expect(claude.calls()).toHaveLength(1);
  });

  it("ignores agents.list from a socket that is not the paired extension, and malformed requests", async () => {
    claude.agents([]);
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: join(codex.dir, "missing.sock") } }));
    const stranger = new FakeExt(d.port);
    await stranger.opened();
    stranger.send({ type: "agents.list", id: "x" });
    await expect(stranger.next("agents.listed", () => true, 300)).rejects.toThrow(/timeout/);
    stranger.close();
    ext = await pairedExt(d, undefined, ["agents"]);
    ext.send({ type: "agents.list" });
    await expect(ext.next("agents.listed", () => true, 300)).rejects.toThrow(/timeout/);
  });

  it("there is no REST discovery route (AD2)", async () => {
    ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket } }));
    const r = await rest(`http://127.0.0.1:${d.port}`, "/v1/agents", d.cfg.secret);
    expect(r.status).toBe(404);
  });
});
