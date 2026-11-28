// agent.send -> agent.sent + agent.status over the paired /ext socket (spec AD3, AD6, AD7, AD10, AD12,
// AD13, AD15, §6), against a stub `claude` and a fake Codex app-server. Every send code is produced here
// except PAUSED, NO_EXTENSION and TIMEOUT, which the worker produces (extension bridgeAgents tests).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSentSchema, AgentStatusSchema } from "@tabagent/protocol";
import type { Daemon } from "../src/daemon";
import { claudeRecord, codexThread, FakeCodex, NO_REPLY, StubClaude } from "./agents-fakes";
import { FakeExt, pairedExt, startDaemon } from "./helpers";

let claude: StubClaude;
let codex: FakeCodex;
let d: Daemon;
let ext: FakeExt;
let queue: { id: string; threadId: string }[];

const T = "019a0000-0000-7000-8000-00000000000a";

beforeEach(async () => {
  claude = new StubClaude();
  codex = await new FakeCodex().listen();
  queue = [];
  codex.threads([codexThread(T), codexThread("t-err", { type: "systemError" }), codexThread("t-off", { type: "notLoaded" })]);
  codex.on("thread/queue/add", ({ threadId, clientUserMessageId }) => {
    const id = `sub-${clientUserMessageId}`;
    queue.push({ id, threadId });
    return { queuedSubmission: { id, clientUserMessageId, input: [] } };
  });
  codex.on("thread/queue/list", ({ threadId }) => ({ data: queue.filter((q) => q.threadId === threadId).map((q) => ({ id: q.id })), nextCursor: null }));
  claude.agents([claudeRecord(10, 1000, { cwd: claude.dir })]);
});
afterEach(async () => {
  ext?.close();
  await d?.stop();
  await codex.close();
  claude.cleanup();
});

async function boot(agents: Record<string, unknown> = {}) {
  ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket, ...agents } }));
  ext = await pairedExt(d, undefined, ["agents"]);
}

let seq = 0;
async function send(fields: Record<string, unknown>, e: FakeExt = ext) {
  const requestId = (fields.requestId as string) ?? `q${++seq}`;
  e.send({ type: "agent.send", requestId, prompt: "Please look", includeTab: false, ...fields });
  const sent = await e.next("agent.sent", (m) => m.requestId === requestId, 8000);
  expect(AgentSentSchema.safeParse(sent).success).toBe(true);
  const { __seen: _seen, ...wire } = sent;
  return wire;
}

function auditEvents(): any[] {
  const p = d.audit.path;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "agent.send");
}

const page = { includeTab: true, tabId: 5, title: "Docs", url: "https://docs.test/a?token=zzz", selection: "picked words" };

describe("queue route (Codex, AD10)", () => {
  it("queued once thread/queue/add succeeds, then delivered when the submission leaves the queue (thread/queue/changed)", async () => {
    await boot();
    const sent = await send({ requestId: "r-cx", agentId: `codex:${T}`, ...page });
    expect(sent).toEqual({ type: "agent.sent", requestId: "r-cx", route: "queue", state: "queued" });
    const [add] = codex.calls("thread/queue/add");
    expect(add.params.threadId).toBe(T);
    expect(add.params.clientUserMessageId).toBe("r-cx");
    expect(add.params.input).toHaveLength(1);
    expect(add.params.input[0].type).toBe("text");
    const text: string = add.params.input[0].text;
    expect(text.startsWith("[TabAgent: message from the user via the side panel]\nPlease look\n\nThe user was looking at this page (you do not have browser access to it):")).toBe(true);
    expect(text).toContain("picked words");

    queue.length = 0;
    codex.notify("thread/queue/changed", { threadId: T });
    const st = await ext.next("agent.status", (m) => m.requestId === "r-cx", 3000);
    expect(AgentStatusSchema.safeParse(st).success).toBe(true);
    expect(st).toMatchObject({ requestId: "r-cx", state: "delivered" });

    const ev = auditEvents();
    expect(ev.map((e) => e.data.state)).toEqual(["queued", "delivered"]);
    expect(ev[0].data).toMatchObject({ requestId: "r-cx", agentId: `codex:${T}`, vendor: "codex", route: "queue", tabOrigin: "https://docs.test" });
    expect(JSON.stringify(ev)).not.toContain("Please look");
    expect(JSON.stringify(ev)).not.toContain("picked words");
    expect(JSON.stringify(ev)).not.toContain("token=zzz");
  });

  it("delivered found by the periodic poll when no notification comes", async () => {
    await boot({ queuePollMs: 100 });
    await send({ requestId: "r-poll", agentId: `codex:${T}` });
    queue.length = 0;
    expect(await ext.next("agent.status", (m) => m.requestId === "r-poll", 3000)).toMatchObject({ state: "delivered" });
  });

  it("reconnects to the app-server on the next poll when the watch connection drops", async () => {
    await boot({ queuePollMs: 100 });
    await send({ requestId: "r-drop", agentId: `codex:${T}` });
    for (const c of codex.clients) c.terminate();
    queue.length = 0;
    expect(await ext.next("agent.status", (m) => m.requestId === "r-drop", 3000)).toMatchObject({ state: "delivered" });
    expect(codex.calls("initialize").length).toBeGreaterThanOrEqual(3);
  });

  it("stops watching after the watch window and leaves it queued", async () => {
    await boot({ queuePollMs: 50, queueWatchMs: 200 });
    await send({ requestId: "r-stuck", agentId: `codex:${T}` });
    await new Promise((r) => setTimeout(r, 450));
    const n = codex.calls("thread/queue/list").length;
    await new Promise((r) => setTimeout(r, 200));
    expect(codex.calls("thread/queue/list").length).toBe(n);
    expect(ext.msgs.some((m) => m.type === "agent.status")).toBe(false);
  });

  it("JSON-RPC error from thread/queue/add -> failed QUEUE_FAILED with the message", async () => {
    codex.on("thread/queue/add", () => {
      throw { code: -32603, message: "thread/queue/add failed: no rollout found" };
    });
    await boot();
    expect(await send({ agentId: `codex:${T}` })).toMatchObject({ route: "queue", state: "failed", code: "QUEUE_FAILED", detail: "thread/queue/add failed: no rollout found" });
  });

  it("thread/queue/add that never answers -> failed QUEUE_FAILED after the timeout", async () => {
    codex.on("thread/queue/add", () => NO_REPLY);
    await boot({ queueTimeoutMs: 200 });
    const r = await send({ agentId: `codex:${T}` });
    expect(r).toMatchObject({ route: "queue", state: "failed", code: "QUEUE_FAILED" });
    expect(r.detail).toMatch(/did not answer/);
  });

  it("a thread in systemError -> failed NO_ROUTE", async () => {
    await boot();
    expect(await send({ agentId: "codex:t-err" })).toMatchObject({ route: "none", state: "failed", code: "NO_ROUTE" });
    expect(codex.calls("thread/queue/add")).toHaveLength(0);
  });

  it("a notLoaded or unknown thread -> failed AGENT_GONE (re-resolved fresh)", async () => {
    await boot();
    expect(await send({ agentId: "codex:t-off" })).toMatchObject({ state: "failed", code: "AGENT_GONE" });
    expect(await send({ agentId: "codex:nope" })).toMatchObject({ state: "failed", code: "AGENT_GONE" });
  });
});

describe("spawn route (claude --bg, §6)", () => {
  it("started with the parsed id; argv is --bg <composed text>; cwd is the agent's cwd", async () => {
    claude.set("bg.out", "Starting…\nbackgrounded · 0badc0de\nclaude attach 0badc0de\n");
    await boot();
    const r = await send({ requestId: "r-sp", agentId: "claude:10:1000", prompt: "Summarise", ...page });
    expect(r).toEqual({ type: "agent.sent", requestId: "r-sp", route: "spawn", state: "started", detail: "Started background session 0badc0de. Attach with: claude attach 0badc0de" });
    const text = claude.read("bg.text")!;
    expect(text.startsWith("[TabAgent: message from the user via the side panel]\nSummarise\n\nThe user was looking at this page")).toBe(true);
    expect(realpathSync(claude.read("bg.cwd")!.trim())).toBe(realpathSync(claude.dir));
    expect(auditEvents()[0].data).toMatchObject({ requestId: "r-sp", vendor: "claude", route: "spawn", state: "started" });
  });

  it("untrusted workspace -> failed WORKSPACE_UNTRUSTED with the CLI message", async () => {
    claude.set("bg.err", "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n");
    claude.set("bg.exit", 1);
    await boot();
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({
      route: "spawn",
      state: "failed",
      code: "WORKSPACE_UNTRUSTED",
      detail: "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.",
    });
  });

  it("other CLI failure -> failed SPAWN_FAILED", async () => {
    claude.set("bg.err", "kaboom\n");
    claude.set("bg.exit", 2);
    await boot();
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({ route: "spawn", state: "failed", code: "SPAWN_FAILED", detail: "kaboom" });
  });

  it("spawn timeout -> failed SPAWN_FAILED", async () => {
    claude.set("bg.sleep", 3);
    await boot({ spawnTimeoutMs: 300 });
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({ route: "spawn", state: "failed", code: "SPAWN_FAILED" });
  });

  it("the agent's cwd no longer exists -> failed NO_CWD", async () => {
    claude.agents([claudeRecord(10, 1000, { cwd: join(claude.dir, "deleted") })]);
    await boot();
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({ route: "spawn", state: "failed", code: "NO_CWD" });
    expect(claude.read("bg.text")).toBeNull();
  });

  it("a reused pid with a different startedAt -> failed AGENT_GONE", async () => {
    claude.agents([claudeRecord(10, 9999, { cwd: claude.dir })]);
    await boot();
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({ route: "none", state: "failed", code: "AGENT_GONE" });
    expect(claude.read("bg.text")).toBeNull();
  });

  it("re-resolves fresh: the 5 s display cache is not used for a send", async () => {
    await boot();
    ext.send({ type: "agents.list", id: "l" });
    await ext.next("agents.listed");
    claude.agents([]);
    expect(await send({ agentId: "claude:10:1000" })).toMatchObject({ code: "AGENT_GONE" });
  });
});

describe("limits, validation and trust", () => {
  it.each([
    ["prompt", { prompt: "x".repeat(8001) }],
    ["selection", { ...page, selection: "s".repeat(16001) }],
    ["title", { ...page, title: "t".repeat(501) }],
    ["url", { ...page, url: `https://a.test/${"u".repeat(2000)}` }],
  ])("%s over the AD13 limit -> failed TOO_LARGE, nothing delivered, nothing truncated", async (field, extra) => {
    await boot();
    const r = await send({ agentId: `codex:${T}`, ...extra });
    expect(r).toMatchObject({ route: "queue", state: "failed", code: "TOO_LARGE" });
    expect(r.detail).toContain(field);
    expect(codex.calls("thread/queue/add")).toHaveLength(0);
    expect(auditEvents()[0].data).toMatchObject({ state: "failed", code: "TOO_LARGE" });
  });

  it("a malformed agent.send with a requestId -> failed BAD_REQUEST; without one it is dropped", async () => {
    await boot();
    ext.send({ type: "agent.send", requestId: "bad1", agentId: `codex:${T}`, includeTab: false });
    expect(await ext.next("agent.sent", (m) => m.requestId === "bad1")).toMatchObject({ route: "none", state: "failed", code: "BAD_REQUEST" });
    ext.send({ type: "agent.send", agentId: `codex:${T}`, prompt: "x" });
    await expect(ext.next("agent.sent", (m) => m.requestId !== "bad1", 300)).rejects.toThrow(/timeout/);
  });

  it("an unparseable agent id -> failed AGENT_GONE", async () => {
    await boot();
    expect(await send({ agentId: "cursor:1" })).toMatchObject({ state: "failed", code: "AGENT_GONE" });
  });

  it("agent.send from a socket that is not the paired extension is ignored (AD14)", async () => {
    await boot();
    const stranger = new FakeExt(d.port);
    await stranger.opened();
    stranger.send({ type: "agent.send", requestId: "x", agentId: `codex:${T}`, prompt: "p", includeTab: false });
    await expect(stranger.next("agent.sent", () => true, 300)).rejects.toThrow(/timeout/);
    expect(codex.calls("thread/queue/add")).toHaveLength(0);
    stranger.close();
  });

  it("agent.status goes to the extension's current socket after it reconnects", async () => {
    await boot({ queuePollMs: 100 });
    await send({ requestId: "r-re", agentId: `codex:${T}` });
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = new FakeExt(d.port);
    await again.hello({ secret: d.cfg.secret, features: ["agents"] });
    queue.length = 0;
    expect(await again.next("agent.status", (m) => m.requestId === "r-re", 3000)).toMatchObject({ state: "delivered" });
    again.close();
  });
});
