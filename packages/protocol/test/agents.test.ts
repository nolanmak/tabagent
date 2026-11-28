import { describe, expect, it } from "vitest";
import { AGENTS_FEATURE, AgentSchema, AgentsListedSchema, AgentsListSchema, BridgeToExtSchema, ExtToBridgeSchema, WelcomeSchema } from "@tabagent/protocol";

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
