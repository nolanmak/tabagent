import { describe, expect, it } from "vitest";
import { AGENT_HISTORY_LIMITS, AgentEntrySchema, AgentHistorySchema, isRemoteControlUrl, remoteControlUrl, AGENT_GRANT_CODES, AgentGrantedSchema, AgentGrantSchema, AgentReleaseSchema, AGENT_DELIVERY_STATES, AGENT_LIMITS, AGENTS_FEATURE, AgentSchema, AgentSendSchema, agentSendOverLimit, AgentSentSchema, AgentStatusSchema, AgentsListedSchema, AgentsListSchema, BridgeToExtSchema, ExtToBridgeSchema, WelcomeSchema } from "@tabagent/protocol";

const agent = { id: "claude:1:2", vendor: "claude", name: "x", cwd: "/w", startedAt: 2, pid: 1, status: "idle", linked: false, canDriveTab: false, delivery: "spawn" };

describe("agents protocol (AD1, AD16, §5)", () => {
  it("agents.list / agents.listed round-trip and route through the unions", () => {
    const req = { type: "agents.list", id: "r1" };
    const res = { type: "agents.listed", id: "r1", agents: [agent, { ...agent, id: "codex:t", vendor: "codex", name: null, pid: undefined, status: "busy", statusLabel: "waitingOnApproval", delivery: "queue" }], sources: { claude: "ok", codex: "unavailable" } };
    expect(AgentsListSchema.parse(req)).toEqual(req);
    expect(ExtToBridgeSchema.parse(req).type).toBe("agents.list");
    expect(BridgeToExtSchema.parse(res).type).toBe("agents.listed");
    expect(AgentsListedSchema.parse(JSON.parse(JSON.stringify(res))).agents[1].name).toBeNull();
  });
  it.each(["id", "vendor", "name", "cwd", "startedAt", "status", "linked", "canDriveTab", "delivery"])("Agent without %s is rejected", (f) => {
    const bad: Record<string, unknown> = { ...agent };
    delete bad[f];
    expect(AgentSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects unknown vendors, statuses, routes and source states", () => {
    expect(AgentSchema.safeParse({ ...agent, vendor: "cursor" }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...agent, status: "sleeping" }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...agent, delivery: "email" }).success).toBe(false);
    expect(AgentsListedSchema.safeParse({ type: "agents.listed", id: "r", agents: [], sources: { claude: "ok", codex: "down" } }).success).toBe(false);
    expect(AgentsListSchema.safeParse({ type: "agents.list" }).success).toBe(false);
  });
  it("welcome may carry features; the agents feature name is stable", () => {
    expect(AGENTS_FEATURE).toBe("agents");
    expect(WelcomeSchema.parse({ type: "welcome", protocolVersion: 1, bridgeVersion: "x", features: [AGENTS_FEATURE] }).features).toEqual(["agents"]);
  });
});

describe("agent.send / agent.sent / agent.status (AD1, AD7, §6)", () => {
  const send = { type: "agent.send", requestId: "q1", agentId: "codex:t", prompt: "hi", includeTab: true, tabId: 7, title: "T", url: "https://a.test/x?tok=1", selection: "sel" };
  it("round-trip and route through the unions", () => {
    expect(AgentSendSchema.parse(send)).toEqual(send);
    expect(ExtToBridgeSchema.parse(send).type).toBe("agent.send");
    const sent = { type: "agent.sent", requestId: "q1", route: "queue", state: "queued" };
    expect(BridgeToExtSchema.parse(sent).type).toBe("agent.sent");
    expect(AgentSentSchema.parse({ ...sent, state: "failed", code: "QUEUE_FAILED", detail: "boom" }).code).toBe("QUEUE_FAILED");
    const st = { type: "agent.status", requestId: "q1", state: "delivered" };
    expect(BridgeToExtSchema.parse(st).type).toBe("agent.status");
    expect(AgentStatusSchema.parse({ ...st, detail: "d" }).detail).toBe("d");
  });
  it.each(["requestId", "agentId", "prompt", "includeTab"])("agent.send without %s is rejected", (f) => {
    const bad: Record<string, unknown> = { ...send };
    delete bad[f];
    expect(AgentSendSchema.safeParse(bad).success).toBe(false);
  });
  it("schemas do not cap lengths: the bridge answers TOO_LARGE instead of dropping the message", () => {
    expect(AgentSendSchema.safeParse({ ...send, prompt: "x".repeat(AGENT_LIMITS.prompt + 1) }).success).toBe(true);
  });
  it("rejects unknown states, routes and codes", () => {
    expect(AgentSentSchema.safeParse({ type: "agent.sent", requestId: "q", route: "queue", state: "read" }).success).toBe(false);
    expect(AgentSentSchema.safeParse({ type: "agent.sent", requestId: "q", route: "fax", state: "sent" }).success).toBe(false);
    expect(AgentSentSchema.safeParse({ type: "agent.sent", requestId: "q", route: "none", state: "failed", code: "OOPS" }).success).toBe(false);
    expect(AGENT_DELIVERY_STATES).toEqual(["sent", "held", "delivered", "queued", "started", "expired", "failed"]);
  });
});

describe("AD13 limits", () => {
  it("limits are the spec values", () => {
    expect(AGENT_LIMITS).toEqual({ prompt: 8000, selection: 16000, title: 500, url: 2000 });
  });
  it.each([
    ["prompt", { prompt: "x".repeat(8000) }, null],
    ["prompt", { prompt: "x".repeat(8001) }, "prompt"],
    ["selection", { prompt: "p", selection: "s".repeat(16000) }, null],
    ["selection", { prompt: "p", selection: "s".repeat(16001) }, "selection"],
    ["title", { prompt: "p", title: "t".repeat(500) }, null],
    ["title", { prompt: "p", title: "t".repeat(501) }, "title"],
    ["url", { prompt: "p", url: "u".repeat(2000) }, null],
    ["url", { prompt: "p", url: "u".repeat(2001) }, "url"],
  ] as const)("%s at %#", (_f, fields, over) => {
    const r = agentSendOverLimit(fields);
    if (over === null) expect(r).toBeNull();
    else expect(r).toEqual({ field: over, limit: AGENT_LIMITS[over], length: (fields as Record<string, string>)[over].length });
  });
  it("the first field over its limit is reported", () => {
    expect(agentSendOverLimit({ prompt: "x".repeat(9000), url: "u".repeat(3000) })!.field).toBe("prompt");
  });
});

describe("agent.grant / agent.granted / agent.release (AD1, AD11)", () => {
  const meta = { id: "mcp:local:100-aaaaaa", label: "claude-code", cap: "full", sites: [] };
  it("round-trip and route through the unions", () => {
    const grant = { type: "agent.grant", requestId: "q1", meta, tabId: 7 };
    expect(AgentGrantSchema.parse(grant)).toEqual(grant);
    expect(BridgeToExtSchema.parse(grant).type).toBe("agent.grant");
    const ok = { type: "agent.granted", requestId: "q1", ok: true, added: true };
    expect(AgentGrantedSchema.parse(ok)).toEqual(ok);
    expect(ExtToBridgeSchema.parse(ok).type).toBe("agent.granted");
    for (const code of AGENT_GRANT_CODES) expect(AgentGrantedSchema.parse({ type: "agent.granted", requestId: "q1", ok: false, code }).code).toBe(code);
    expect(AGENT_GRANT_CODES).toEqual(expect.arrayContaining(["TAB_BUSY", "PERMISSION_DENIED", "NOT_FOUND", "TIMEOUT"]));
    const rel = { type: "agent.release", sessionId: meta.id, tabId: 7 };
    expect(AgentReleaseSchema.parse(rel)).toEqual(rel);
    expect(BridgeToExtSchema.parse(rel).type).toBe("agent.release");
  });
  it("rejects a grant without meta or tabId, and unknown refusal codes", () => {
    expect(AgentGrantSchema.safeParse({ type: "agent.grant", requestId: "q", tabId: 1 }).success).toBe(false);
    expect(AgentGrantSchema.safeParse({ type: "agent.grant", requestId: "q", meta }).success).toBe(false);
    expect(AgentGrantSchema.safeParse({ type: "agent.grant", requestId: "q", meta, tabId: 1.5 }).success).toBe(false);
    expect(AgentGrantedSchema.safeParse({ type: "agent.granted", requestId: "q", ok: false, code: "OOPS" }).success).toBe(false);
  });
});

describe("#151 chat page: history, watch, entries, Remote Control", () => {
  it("remoteControlUrl accepts only plain session ids; isRemoteControlUrl only URLs it could make", () => {
    expect(remoteControlUrl("session_01AbCdEfGhIj")).toBe("https://claude.ai/code/session_01AbCdEfGhIj");
    for (const bad of [null, undefined, 5, "", "session_", "session_../../x", "sess_01AbCdEfGhIj", "session_01AbCdEfGhIj?x=1"]) expect(remoteControlUrl(bad)).toBeNull();
    expect(isRemoteControlUrl("https://claude.ai/code/session_01AbCdEfGhIj")).toBe(true);
    for (const bad of ["https://evil.test/code/session_01AbCdEfGhIj", "javascript:alert(1)", "https://claude.ai/code/session_01AbCdEfGhIj/../x", 3]) expect(isRemoteControlUrl(bad)).toBe(false);
  });
  it("history, watch and entries messages route through the unions; Agent takes remoteControlUrl", () => {
    expect(AgentSchema.parse({ ...agent, remoteControlUrl: "https://claude.ai/code/session_01AbCdEfGhIj" }).remoteControlUrl).toContain("session_");
    const entry = { uuid: "u1", ts: 1, role: "tool", tool: { name: "Bash", summary: "ls", id: "t", result: true, error: true } };
    expect(ExtToBridgeSchema.parse({ type: "agent.history", requestId: "r", agentId: "claude:1:2", before: "100", limit: 50 }).type).toBe("agent.history");
    expect(ExtToBridgeSchema.parse({ type: "agent.watch", agentId: "claude:1:2" }).type).toBe("agent.watch");
    expect(ExtToBridgeSchema.parse({ type: "agent.unwatch", agentId: "claude:1:2" }).type).toBe("agent.unwatch");
    expect(BridgeToExtSchema.parse({ type: "agent.history.result", requestId: "r", agentId: "a", ok: true, entries: [entry], hasMore: false }).type).toBe("agent.history.result");
    expect(BridgeToExtSchema.parse({ type: "agent.entries", agentId: "a", entries: [], reset: true }).type).toBe("agent.entries");
    expect(AgentHistorySchema.safeParse({ type: "agent.history", requestId: "r", agentId: "a", limit: AGENT_HISTORY_LIMITS.maxLimit + 1 }).success).toBe(false);
    expect(AgentEntrySchema.safeParse({ ...entry, role: "system" }).success).toBe(false);
    expect(AgentEntrySchema.safeParse({ uuid: "u", ts: 0, role: "user", text: "x".repeat(AGENT_HISTORY_LIMITS.text + 200) }).success).toBe(false);
  });
});
