// Worker side of Send to agent: agents.list request/reply over the bridge socket (AD1, AD16).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSendRequest, agentsSupported, listAgents, onAgentsBridgeMessage, sendToAgent, setAgentsSender, setAgentStatusListener } from "../src/background/bridgeAgents";

let sent: any[];
beforeEach(() => {
  sent = [];
  setAgentsSender((m) => (sent.push(m), true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("agents feature negotiation (AD16)", () => {
  it.each([
    [["files.resolve", "agents"], ["agents"], true],
    [["agents"], [], false],
    [[], ["agents"], false],
  ])("ext %j + bridge %j -> %s", (ext, br, want) => {
    expect(agentsSupported(ext, br)).toBe(want);
  });
});

describe("listAgents", () => {
  it("sends agents.list and resolves with the matching agents.listed", async () => {
    const p = listAgents();
    expect(sent[0]).toMatchObject({ type: "agents.list" });
    const id = sent[0].id;
    onAgentsBridgeMessage({ type: "agents.listed", id: "other", agents: [], sources: { claude: "ok", codex: "ok" } });
    onAgentsBridgeMessage({ type: "agents.listed", id, agents: [{ id: "codex:t" }], sources: { claude: "unavailable", codex: "ok" } });
    await expect(p).resolves.toEqual({ agents: [{ id: "codex:t" }], sources: { claude: "unavailable", codex: "ok" } });
  });
  it("rejects with NO_EXTENSION when the bridge socket is not up", async () => {
    setAgentsSender(() => false);
    await expect(listAgents()).rejects.toMatchObject({ code: "NO_EXTENSION" });
  });
  it("rejects with TIMEOUT when the bridge never answers", async () => {
    const p = listAgents(1000);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("ignores messages it does not own", () => {
    expect(onAgentsBridgeMessage({ type: "command" })).toBe(false);
    expect(onAgentsBridgeMessage({ type: "agents.listed", id: "nobody", agents: [], sources: {} })).toBe(true);
  });
});

describe("ui.agent_send -> agent.send (AD12, AD17, §6)", () => {
  const ui = { type: "ui.agent_send", requestId: "q1", agentId: "codex:t", prompt: "hi", includeTab: true, tabId: 3, title: "T", url: "https://a.test/", selection: "s" };
  it("builds the wire message from the panel's raw fields", () => {
    expect(agentSendRequest(ui, false)).toEqual({ ok: true, msg: { type: "agent.send", requestId: "q1", agentId: "codex:t", prompt: "hi", includeTab: true, tabId: 3, title: "T", url: "https://a.test/", selection: "s" } });
  });
  it("kill switch on -> failed PAUSED and nothing is sent (AD17)", () => {
    expect(agentSendRequest(ui, true)).toEqual({ ok: false, reply: { type: "agent.sent", requestId: "q1", route: "none", state: "failed", code: "PAUSED", detail: expect.any(String) } });
  });
  it.each([
    ["no prompt", { ...ui, prompt: undefined }],
    ["includeTab not boolean", { ...ui, includeTab: "yes" }],
    ["no agentId", { ...ui, agentId: "" }],
  ])("%s -> failed BAD_REQUEST", (_n, m) => {
    expect(agentSendRequest(m, false)).toMatchObject({ ok: false, reply: { requestId: "q1", state: "failed", code: "BAD_REQUEST" } });
  });
  it("a missing requestId gets one so the reply can still be keyed", () => {
    const r = agentSendRequest({ ...ui, requestId: undefined }, false);
    expect(r.ok && r.msg.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it("sendToAgent resolves with agent.sent; agent.status goes to the listener", async () => {
    const statuses: any[] = [];
    setAgentStatusListener((m) => statuses.push(m));
    const p = sendToAgent({ type: "agent.send", requestId: "q1", agentId: "codex:t", prompt: "hi", includeTab: false });
    expect(sent[0]).toMatchObject({ type: "agent.send", requestId: "q1" });
    onAgentsBridgeMessage({ type: "agent.sent", requestId: "q1", route: "queue", state: "queued" });
    await expect(p).resolves.toEqual({ type: "agent.sent", requestId: "q1", route: "queue", state: "queued" });
    expect(onAgentsBridgeMessage({ type: "agent.status", requestId: "q1", state: "delivered" })).toBe(true);
    expect(statuses).toEqual([{ type: "agent.status", requestId: "q1", state: "delivered" }]);
  });
  it("bridge not connected -> failed NO_EXTENSION", async () => {
    setAgentsSender(() => false);
    await expect(sendToAgent({ type: "agent.send", requestId: "q2", agentId: "codex:t", prompt: "hi", includeTab: false })).resolves.toMatchObject({ requestId: "q2", route: "none", state: "failed", code: "NO_EXTENSION" });
  });
  it("no agent.sent within 20 s -> failed TIMEOUT", async () => {
    const p = sendToAgent({ type: "agent.send", requestId: "q3", agentId: "codex:t", prompt: "hi", includeTab: false });
    vi.advanceTimersByTime(20_001);
    await expect(p).resolves.toMatchObject({ requestId: "q3", state: "failed", code: "TIMEOUT" });
    expect(onAgentsBridgeMessage({ type: "agent.sent", requestId: "q3", route: "queue", state: "queued" })).toBe(true);
  });
});
