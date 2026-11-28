// #151: agent.history / agent.watch / agent.entries over the paired /ext socket, and Remote Control URLs in
// agents.listed. Transcripts are only read for listed sessions, and their content is never audited.
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEntriesSchema, AgentHistoryResultSchema, AgentsListedSchema } from "@tabagent/protocol";
import type { Daemon } from "../src/daemon";
import { parseSessionRecord, RemoteControlReader, defaultClaudeSessionsDir } from "../src/agents/remote";
import { claudeRecord, codexThread, FakeCodex, StubClaude, tx } from "./agents-fakes";
import { FakeExt, pairedExt, startDaemon } from "./helpers";

let claude: StubClaude;
let codex: FakeCodex;
let d: Daemon;
let ext: FakeExt;
const SID = "aaaaaaaa-1111-4222-8333-444444444444";
const AGENT = "claude:10:1000";
const RC = "session_01TestRemoteControlId";

beforeEach(async () => {
  claude = new StubClaude();
  codex = await new FakeCodex().listen();
  codex.threads([codexThread("t-1")]);
  claude.agents([claudeRecord(10, 1000, { cwd: claude.dir, sessionId: SID }), claudeRecord(11, 2000, { cwd: claude.dir, sessionId: "bbbbbbbb-1111-4222-8333-444444444444" })]);
});
afterEach(async () => {
  ext?.close();
  await d?.stop();
  await codex.close();
  claude.cleanup();
});

async function boot() {
  ({ d } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: codex.socket, claudeProjectsDir: claude.projectsDir, claudeSessionsDir: claude.sessionsDir, watchPollMs: 50 } }));
  ext = await pairedExt(d, undefined, ["agents"]);
}

let seq = 0;
async function history(fields: Record<string, unknown>) {
  const requestId = `h${++seq}`;
  ext.send({ type: "agent.history", requestId, agentId: AGENT, ...fields });
  const r = await ext.next("agent.history.result", (m) => m.requestId === requestId, 8000);
  const { __seen: _s, ...wire } = r;
  expect(AgentHistoryResultSchema.safeParse(wire).success).toBe(true);
  return wire;
}

const auditText = () => (existsSync(d.audit.path) ? readFileSync(d.audit.path, "utf8") : "");

describe("agent.history", () => {
  it("returns the newest page of a listed session, then older pages by cursor; nothing is audited", async () => {
    const recs = [tx.user("SECRET-first question"), tx.assistant([tx.text("first answer"), tx.toolUse("t1", "Bash", { command: "ls" })]), tx.toolResult("t1", "a.txt"), tx.system(), tx.user("second question"), tx.assistant([tx.text("second answer")])];
    claude.transcript(claude.dir, SID, recs);
    await boot();
    const newest = await history({ limit: 2 });
    expect(newest).toMatchObject({ ok: true, agentId: AGENT, hasMore: true });
    expect(newest.entries.map((e: any) => e.text)).toEqual(["second question", "second answer"]);
    const older = await history({ limit: 50, before: newest.before });
    expect(older.hasMore).toBe(false);
    expect(older.before).toBeUndefined();
    expect(older.entries.map((e: any) => e.text ?? e.tool.name)).toEqual(["SECRET-first question", "first answer", "Bash", "result"]);
    expect(auditText()).not.toContain("SECRET");
    expect(auditText()).not.toContain("agent.history");
  });

  it("an agent that is not listed is AGENT_GONE (no arbitrary paths); a listed one with no transcript is NO_TRANSCRIPT", async () => {
    await boot();
    expect(await history({ agentId: "claude:99:9" })).toMatchObject({ ok: false, code: "AGENT_GONE", entries: [] });
    expect(await history({})).toMatchObject({ ok: false, code: "NO_TRANSCRIPT" });
    expect(await history({ agentId: "../../etc/passwd" })).toMatchObject({ ok: false, code: "AGENT_GONE" });
  });

  it("Codex history is UNSUPPORTED for now; bad cursors and malformed requests are BAD_REQUEST", async () => {
    await boot();
    expect(await history({ agentId: "codex:t-1" })).toMatchObject({ ok: false, code: "UNSUPPORTED", detail: "History isn't available for Codex yet" });
    expect(await history({ before: "x/../1" })).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(await history({ limit: 100_000 })).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    // No requestId: no reply at all.
    ext.send({ type: "agent.history", agentId: AGENT });
    const after = await history({ agentId: "codex:t-1" });
    expect(after.code).toBe("UNSUPPORTED");
  });
});

describe("agent.watch -> agent.entries", () => {
  it("pushes entries appended to the transcript until agent.unwatch; reconnecting drops watches", async () => {
    claude.transcript(claude.dir, SID, [tx.user("before the watch")]);
    await boot();
    ext.send({ type: "agent.watch", agentId: AGENT });
    // Unlisted and Codex agents are never watched.
    ext.send({ type: "agent.watch", agentId: "claude:99:9" });
    ext.send({ type: "agent.watch", agentId: "codex:t-1" });
    await expect.poll(() => d.agents.transcripts.started(AGENT), { timeout: 5000 }).toBe(true);
    expect(d.agents.transcripts.size).toBe(1);
    claude.appendTranscript(claude.dir, SID, [tx.channel("Reply with OK"), tx.assistant([tx.text("SECRET-OK")])]);
    const m = await ext.next("agent.entries", () => true, 5000);
    const { __seen: _s, ...wire } = m;
    expect(AgentEntriesSchema.safeParse(wire).success).toBe(true);
    expect(wire.agentId).toBe(AGENT);
    expect(wire.entries.map((e: any) => [e.role, e.text, e.fromTabAgent ?? false])).toEqual([
      ["user", "Reply with OK", true],
      ["assistant", "SECRET-OK", false],
    ]);
    expect(auditText()).not.toContain("SECRET");
    ext.send({ type: "agent.unwatch", agentId: AGENT });
    await expect.poll(() => d.agents.transcripts.size).toBe(0);
    ext.send({ type: "agent.watch", agentId: AGENT });
    await expect.poll(() => d.agents.transcripts.size).toBe(1);
    ext.close();
    await expect.poll(() => d.agents.transcripts.size, { timeout: 5000 }).toBe(0);
  });
});

describe("Remote Control (#151)", () => {
  it("agents.listed carries remoteControlUrl from ~/.claude/sessions/<pid>.json when its pid and startedAt match", async () => {
    claude.session(10, { startedAt: 1000, sessionId: SID, bridgeSessionId: RC, messagingSocketPath: "/tmp/never-used.sock" });
    // A stale record for a reused pid (different startedAt) lends no URL.
    claude.session(11, { startedAt: 1, bridgeSessionId: "session_01StaleStaleStale" });
    await boot();
    ext.send({ type: "agents.list", id: "l" });
    const r = await ext.next("agents.listed", (m) => m.id === "l", 8000);
    expect(AgentsListedSchema.safeParse(r).success).toBe(true);
    const byId = Object.fromEntries(r.agents.map((a: any) => [a.id, a]));
    expect(byId[AGENT].remoteControlUrl).toBe(`https://claude.ai/code/${RC}`);
    expect(byId["claude:11:2000"].remoteControlUrl).toBeUndefined();
    expect(byId["codex:t-1"].remoteControlUrl).toBeUndefined();
  });

  it("parseSessionRecord validates the record and the id", () => {
    expect(parseSessionRecord(JSON.stringify({ pid: 5, startedAt: 7, bridgeSessionId: RC }), 5, 7)).toBe(`https://claude.ai/code/${RC}`);
    expect(parseSessionRecord(JSON.stringify({ bridgeSessionId: RC }), 5, 7)).toBe(`https://claude.ai/code/${RC}`);
    expect(parseSessionRecord(JSON.stringify({ pid: 6, bridgeSessionId: RC }), 5, 7)).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ pid: 5, startedAt: 8, bridgeSessionId: RC }), 5, 7)).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ pid: 5, bridgeSessionId: null }), 5, 7)).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ pid: 5, bridgeSessionId: "session_x/../../evil" }), 5, 7)).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ pid: 5, bridgeSessionId: "javascript:alert(1)" }), 5, 7)).toBeNull();
    expect(parseSessionRecord("{nope", 5, 7)).toBeNull();
    expect(parseSessionRecord("[]", 5, 7)).toBeNull();
  });

  it("RemoteControlReader reads only <pid>.json, caches by mtime, and ignores bad pids", () => {
    claude.session(42, { startedAt: 3, bridgeSessionId: RC });
    const r = new RemoteControlReader({ sessionsDir: claude.sessionsDir });
    expect(r.urlFor(42, 3)).toBe(`https://claude.ai/code/${RC}`);
    expect(r.urlFor(42, 3)).toBe(`https://claude.ai/code/${RC}`);
    expect(r.urlFor(43, 3)).toBeNull();
    expect(r.urlFor(undefined, 3)).toBeNull();
    expect(r.urlFor(-1, 3)).toBeNull();
    expect(defaultClaudeSessionsDir({ TABAGENT_CLAUDE_SESSIONS_DIR: "/x" }, "/h")).toBe("/x");
    expect(defaultClaudeSessionsDir({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe("/c/sessions");
    expect(defaultClaudeSessionsDir({}, "/h")).toBe("/h/.claude/sessions");
  });
});
