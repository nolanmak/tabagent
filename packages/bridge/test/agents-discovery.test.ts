// Pure rules for agent discovery (spec AD3, AD6, AD10, §5): ids, status maps, parsing, merge, route.
import { describe, expect, it } from "vitest";
import { AgentSchema } from "@tabagent/protocol";
import {
  claudeAgentId,
  claudeStatus,
  codexAgentId,
  codexStatus,
  codexThreadToAgent,
  mergeAgents,
  parseAgentId,
  parseClaudeAgents,
} from "../src/agents/discovery";
import { chooseRoute } from "../src/agents/route";
import { claudeRecord, codexThread } from "./agents-fakes";

describe("agent ids (AD3)", () => {
  it("formats and parses claude and codex ids", () => {
    expect(claudeAgentId(5918, 1795639119768)).toBe("claude:5918:1795639119768");
    expect(codexAgentId("019a-uuid")).toBe("codex:019a-uuid");
    expect(parseAgentId("claude:5918:1795639119768")).toEqual({ vendor: "claude", pid: 5918, startedAt: 1795639119768 });
    expect(parseAgentId("codex:019a-uuid")).toEqual({ vendor: "codex", threadId: "019a-uuid" });
  });
  it.each(["", "claude:", "claude:12", "claude:x:1", "claude:1:y", "claude:-1:5", "codex:", "cursor:1", "claude:1:2:3", "codex"])("rejects %j", (id) => {
    expect(parseAgentId(id)).toBeNull();
  });
});

describe("claude agents --json parsing (§5)", () => {
  it("one agent per live pid; two pids sharing a sessionId stay two agents with distinct ids", () => {
    const out = JSON.stringify([claudeRecord(10, 1000), claudeRecord(11, 2000)]);
    const agents = parseClaudeAgents(out);
    expect(agents.map((a) => a.id)).toEqual(["claude:10:1000", "claude:11:2000"]);
    expect(agents[0]).toEqual({ id: "claude:10:1000", vendor: "claude", name: "agent-10", cwd: "/work/cl", startedAt: 1000, pid: 10, status: "idle", sessionId: "11111111-2222-3333-4444-555555555555" });
  });
  it("includes background sessions as well as interactive ones", () => {
    const out = JSON.stringify([claudeRecord(10, 1000), claudeRecord(12, 3000, { kind: "background", id: "abcd1234", state: "running", status: undefined })]);
    const agents = parseClaudeAgents(out);
    expect(agents).toHaveLength(2);
    expect(agents[1]).toMatchObject({ id: "claude:12:3000", status: "busy" });
  });
  it("skips records without a numeric pid and startedAt (no stable id), and non-objects", () => {
    const out = JSON.stringify([{ kind: "background", id: "abcd1234", state: "running" }, claudeRecord(10, 1000, { startedAt: "soon" }), null, 3, claudeRecord(13, 4000)]);
    expect(parseClaudeAgents(out).map((a) => a.id)).toEqual(["claude:13:4000"]);
  });
  it("missing name -> null; missing cwd -> empty string", () => {
    const [a] = parseClaudeAgents(JSON.stringify([{ pid: 1, startedAt: 2 }]));
    expect(a).toMatchObject({ name: null, cwd: "", status: "idle" });
    expect(a.sessionId).toBeUndefined();
  });
  it.each(["not json", "{}", '{"agents":[]}', ""])("throws on output that is not a JSON array: %j", (s) => {
    expect(() => parseClaudeAgents(s)).toThrow();
  });
});

describe("claude status map", () => {
  it.each([
    [{ status: "busy" }, { status: "busy" }],
    [{ status: "idle" }, { status: "idle" }],
    [{ status: "waiting" }, { status: "busy", statusLabel: "waiting" }],
    [{ state: "running" }, { status: "busy" }],
    [{ state: "done" }, { status: "idle", statusLabel: "done" }],
    [{ state: "failed" }, { status: "error", statusLabel: "failed" }],
    [{ status: "error" }, { status: "error" }],
    [{}, { status: "idle" }],
  ])("%j -> %j", (rec, want) => {
    expect(claudeStatus(rec)).toEqual(want);
  });
});

describe("codex status map (AD10)", () => {
  it.each([
    [{ type: "active", activeFlags: [] }, { status: "busy" }],
    [{ type: "idle" }, { status: "idle" }],
    [{ type: "notLoaded" }, null],
    [{ type: "systemError" }, { status: "error", statusLabel: "systemError" }],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, { status: "busy", statusLabel: "waitingOnApproval" }],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, { status: "busy", statusLabel: "waitingOnUserInput" }],
    [{ type: "somethingNew" }, { status: "busy", statusLabel: "somethingNew" }],
    [undefined, null],
  ])("%j -> %j", (st, want) => {
    expect(codexStatus(st)).toEqual(want);
  });
  it("maps a thread; createdAt seconds become ms; null name stays null; notLoaded is not listed", () => {
    expect(codexThreadToAgent(codexThread("t1", { type: "idle" }, { name: "Fix tests" }))).toEqual({
      id: "codex:t1",
      vendor: "codex",
      name: "Fix tests",
      cwd: "/work/cx",
      startedAt: 1_795_000_000_000,
      status: "idle",
      title: "Fix tests",
    });
    expect(codexThreadToAgent(codexThread("t2"))!.name).toBeNull();
    expect(codexThreadToAgent(codexThread("t2"))!.title).toBeUndefined();
    expect(codexThreadToAgent(codexThread("t3", { type: "notLoaded" }))).toBeNull();
    expect(codexThreadToAgent({ status: { type: "idle" } })).toBeNull();
    expect(codexThreadToAgent(null)).toBeNull();
  });
});

describe("route choice (AD6)", () => {
  const T = (vendor: "claude" | "codex", extra: Partial<{ status: "busy" | "idle" | "error"; linked: boolean; channels: boolean }> = {}) => ({ vendor, status: "idle" as const, linked: false, ...extra });
  it.each([
    ["linked claude with channels (P3 ships it: on by default)", T("claude", { linked: true, channels: true }), {}, "channel"],
    ["linked claude with channels, busy (the push runs after the current turn)", T("claude", { linked: true, channels: true, status: "busy" }), {}, "channel"],
    ["linked claude with channels, channel route switched off", T("claude", { linked: true, channels: true }), { channelEnabled: false }, "piggyback"],
    ["linked claude with channels, user chose Start new session", T("claude", { linked: true, channels: true }), { forceSpawn: true }, "spawn"],
    ["unlinked claude claiming channels (no live stream)", T("claude", { channels: true }), {}, "spawn"],
    ["linked codex with channels (Claude only)", T("codex", { linked: true, channels: true }), {}, "piggyback"],
    ["linked claude", T("claude", { linked: true }), {}, "piggyback"],
    ["linked claude, user chose Start new session", T("claude", { linked: true }), { forceSpawn: true }, "spawn"],
    ["codex idle", T("codex"), {}, "queue"],
    ["codex busy", T("codex", { status: "busy" }), {}, "queue"],
    ["codex systemError", T("codex", { status: "error" }), {}, "none"],
    ["codex with forceSpawn (Claude only)", T("codex"), { forceSpawn: true }, "none"],
    // #137: an unlinked Claude session cannot be messaged; a new session needs the explicit forceSpawn.
    ["unlinked claude", T("claude"), {}, "none"],
    ["unlinked claude, busy", T("claude", { status: "busy" }), {}, "none"],
    ["unlinked claude in error", T("claude", { status: "error" }), {}, "none"],
    ["unlinked claude, user chose Start a new session", T("claude"), { forceSpawn: true }, "spawn"],
    ["unlinked claude, forceSpawn false", T("claude"), { forceSpawn: false }, "none"],
  ] as const)("%s -> %s", (_n, t, o, want) => {
    expect(chooseRoute(t, o)).toBe(want);
  });
});

describe("titles on the wire (#137)", () => {
  it("toAgent keeps the title, falls back to the vendor name, and never puts the sessionId on the wire", () => {
    const [base] = parseClaudeAgents(JSON.stringify([claudeRecord(10, 1000, { name: "cl-03" })]));
    const plain = mergeAgents([[base]])[0];
    expect(plain.title).toBe("cl-03");
    expect(plain).not.toHaveProperty("sessionId");
    const titled = mergeAgents([[{ ...base, title: "Pending user input check" }]])[0];
    expect(titled.title).toBe("Pending user input check");
    expect(AgentSchema.safeParse(titled).success).toBe(true);
    const [unnamed] = parseClaudeAgents(JSON.stringify([{ pid: 1, startedAt: 2 }]));
    expect(mergeAgents([[unnamed]])[0]).not.toHaveProperty("title");
  });
});

describe("merge", () => {
  it("P1: linked and canDriveTab are false, delivery is the would-be route, newest first, ids unique", () => {
    const cl = parseClaudeAgents(JSON.stringify([claudeRecord(10, 1000), claudeRecord(10, 1000)]));
    const cx = [codexThreadToAgent(codexThread("t1"))!, codexThreadToAgent(codexThread("t2", { type: "systemError" }, { createdAt: 1 }))!];
    const all = mergeAgents([cl, cx]);
    expect(all.map((a) => [a.id, a.delivery])).toEqual([
      ["codex:t1", "queue"],
      ["claude:10:1000", "none"],
      ["codex:t2", "none"],
    ]);
    for (const a of all) {
      expect(a.linked).toBe(false);
      expect(a.canDriveTab).toBe(false);
      expect(AgentSchema.safeParse(a).success).toBe(true);
    }
  });
});
