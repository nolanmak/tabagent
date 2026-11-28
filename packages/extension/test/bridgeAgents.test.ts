// Worker side of Send to agent: agents.list request/reply over the bridge socket (AD1, AD16).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsSupported, listAgents, onAgentsBridgeMessage, setAgentsSender } from "../src/background/bridgeAgents";

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
