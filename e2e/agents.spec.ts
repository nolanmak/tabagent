// Send to agent (docs/specs/agent-inbox.md): the panel's ui.* messages through the real worker, the
// real bridge process and its /ext socket, against a stub `claude` on PATH and a fake Codex app-server.
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { claudeRecord, codexThread, FakeCodex, StubClaude } from "../packages/bridge/test/agents-fakes";
import { Harness } from "./harness";

interface W {
  h: Harness;
  claude: StubClaude;
  codex: FakeCodex;
  panel: Page;
}

const test = base.extend<{}, { w: W }>({
  w: [
    async ({}, use) => {
      const claude = new StubClaude();
      const codex = await new FakeCodex().listen();
      const oldPath = process.env.PATH;
      const oldSock = process.env.TABAGENT_CODEX_SOCKET;
      // Inherited by the bridge process the harness spawns.
      process.env.PATH = `${claude.dir}:${oldPath}`;
      process.env.TABAGENT_CODEX_SOCKET = codex.socket;
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = oldPath;
        if (oldSock === undefined) delete process.env.TABAGENT_CODEX_SOCKET;
        else process.env.TABAGENT_CODEX_SOCKET = oldSock;
      }
      const panel = await h.openPanel();
      await use({ h, claude, codex, panel });
      await h.stop();
      await codex.close();
      claude.cleanup();
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

/** Send a ui.* message from the side panel page, as the panel UI will (AD14 sender gate). */
function ui(w: W, msg: Record<string, unknown>): Promise<any> {
  return w.panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

test("ui.agents_list lists stub Claude and fake Codex agents; both sides advertise the agents feature", async ({ w }) => {
  w.claude.agents([claudeRecord(4242, 1795639119768, { cwd: w.claude.dir })]);
  w.codex.threads([codexThread("019a0000-0000-7000-8000-000000000001", { type: "idle" }, { name: "Codex thread" })]);
  const state = await ui(w, { type: "ui.state" });
  expect(state.agentsSupported).toBe(true);
  const r = await ui(w, { type: "ui.agents_list" });
  expect(r.supported).toBe(true);
  expect(r.sources).toEqual({ claude: "ok", codex: "ok" });
  const ids = r.agents.map((a: any) => `${a.id} ${a.delivery}`).sort();
  expect(ids).toEqual(["claude:4242:1795639119768 spawn", "codex:019a0000-0000-7000-8000-000000000001 queue"]);
  expect(w.claude.calls()).toEqual(["agents --json"]);
});

/** Collect agent.status broadcasts on the panel page. */
async function watchStatus(w: W) {
  await w.panel.evaluate(() => {
    const g = globalThis as any;
    if (g.__agentStatus) return;
    g.__agentStatus = [];
    chrome.runtime.onMessage.addListener((m: any) => {
      if (m?.type === "agent.status") g.__agentStatus.push(m);
    });
  });
}
const statuses = (w: W) => w.panel.evaluate(() => (globalThis as any).__agentStatus as any[]);

test("ui.agent_send to a fake Codex thread: queued, then agent.status delivered", async ({ w }) => {
  const T = "019a0000-0000-7000-8000-000000000002";
  const queue: string[] = [];
  w.codex.threads([codexThread(T)]);
  w.codex.on("thread/queue/add", ({ clientUserMessageId }) => {
    queue.push(`sub-${clientUserMessageId}`);
    return { queuedSubmission: { id: `sub-${clientUserMessageId}`, clientUserMessageId, input: [] } };
  });
  w.codex.on("thread/queue/list", () => ({ data: queue.map((id) => ({ id })), nextCursor: null }));
  await watchStatus(w);
  const r = await ui(w, { type: "ui.agent_send", requestId: "e2e-q", agentId: `codex:${T}`, prompt: "Summarise the page", includeTab: true, tabId: 1, title: "Fixture", url: `${w.h.A}/index.html` });
  expect(r).toEqual({ type: "agent.sent", requestId: "e2e-q", route: "queue", state: "queued" });
  const text: string = w.codex.calls("thread/queue/add")[0].params.input[0].text;
  expect(text).toContain("[TabAgent: message from the user via the side panel]\nSummarise the page");
  expect(text).toContain("you do not have browser access to it");
  queue.length = 0;
  w.codex.notify("thread/queue/changed", { threadId: T });
  await expect.poll(() => statuses(w), { timeout: 5000 }).toEqual([{ type: "agent.status", requestId: "e2e-q", state: "delivered" }]);
});

test("ui.agent_send to a stub Claude agent: started via claude --bg; untrusted workspace fails cleanly", async ({ w }) => {
  w.claude.agents([claudeRecord(4243, 1795639119999, { cwd: w.claude.dir })]);
  w.claude.set("bg.out", "backgrounded · 0badc0de\nclaude attach 0badc0de\n");
  const ok = await ui(w, { type: "ui.agent_send", requestId: "e2e-s", agentId: "claude:4243:1795639119999", prompt: "Write tests", includeTab: false });
  expect(ok).toMatchObject({ requestId: "e2e-s", route: "spawn", state: "started" });
  expect(ok.detail).toContain("claude attach 0badc0de");
  expect(w.claude.read("bg.text")).toBe("[TabAgent: message from the user via the side panel]\nWrite tests");

  w.claude.set("bg.out", null);
  w.claude.set("bg.err", "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n");
  w.claude.set("bg.exit", 1);
  const bad = await ui(w, { type: "ui.agent_send", requestId: "e2e-u", agentId: "claude:4243:1795639119999", prompt: "Again", includeTab: false });
  expect(bad).toMatchObject({ requestId: "e2e-u", route: "spawn", state: "failed", code: "WORKSPACE_UNTRUSTED" });

  const gone = await ui(w, { type: "ui.agent_send", requestId: "e2e-g", agentId: "claude:4243:1", prompt: "x", includeTab: false });
  expect(gone).toMatchObject({ state: "failed", code: "AGENT_GONE" });
});

test("the kill switch blocks sends with PAUSED, and nothing reaches the agent (AD17)", async ({ w }) => {
  const before = w.codex.calls("thread/queue/add").length;
  await w.h.sw.evaluate(() => (globalThis as any).__tabagent.kill());
  try {
    const r = await ui(w, { type: "ui.agent_send", requestId: "e2e-p", agentId: "codex:019a0000-0000-7000-8000-000000000002", prompt: "x", includeTab: false });
    expect(r).toMatchObject({ requestId: "e2e-p", route: "none", state: "failed", code: "PAUSED" });
    expect(w.codex.calls("thread/queue/add").length).toBe(before);
  } finally {
    await w.h.sw.evaluate(() => (globalThis as any).__tabagent.resume());
  }
});

// P1c (#90): the side panel's Agents section, composer and feed, driven through the real panel UI.
test("panel: lists stub agents, sends to Codex (queued -> delivered), spawns Claude (started + attach hint), blocks over-limit", async ({ w }) => {
  const T = "019a0000-0000-7000-8000-0000000000c1";
  const queue: string[] = [];
  w.claude.set("bg.err", null);
  w.claude.set("bg.exit", null);
  w.claude.set("bg.out", "backgrounded · 0badc0de\n");
  w.claude.agents([claudeRecord(4250, 1795639120000, { cwd: w.claude.dir, name: "spawn-target" })]);
  w.codex.threads([codexThread(T, { type: "idle" }, { name: "Codex helper" })]);
  w.codex.on("thread/queue/add", ({ clientUserMessageId }) => {
    queue.push(`sub-${clientUserMessageId}`);
    return { queuedSubmission: { id: `sub-${clientUserMessageId}`, clientUserMessageId, input: [] } };
  });
  w.codex.on("thread/queue/list", () => ({ data: queue.map((id) => ({ id })), nextCursor: null }));

  const p = await w.h.openPanel();
  try {
    await expect(p.locator("#agentsBox")).toBeVisible();
    await expect(p.locator("#sessions")).toContainText("No sessions.");
    const codexRow = p.locator(`#agents [data-agent-id="codex:${T}"]`);
    const claudeRow = p.locator(`#agents [data-agent-id="claude:4250:1795639120000"]`);
    await expect(codexRow).toContainText("Codex helper");
    await expect(codexRow).toContainText("queued (Codex)");
    await expect(claudeRow).toContainText("spawn-target");
    await expect(claudeRow).toContainText("starts a new session");
    await expect(claudeRow).toContainText("pid 4250");
    await expect(p.locator("#agentSelection")).toBeDisabled();

    // Codex: queued, then delivered once the submission leaves the queue.
    const adds = w.codex.calls("thread/queue/add").length;
    await codexRow.click();
    await p.fill("#agentPrompt", "Summarise the page");
    await expect(p.locator("#agentSend")).toHaveText("Send");
    await p.click("#agentSend");
    const codexLine = p.locator("#agentFeed li").filter({ hasText: "Codex helper" });
    await expect(codexLine).toContainText("queued", { timeout: 15_000 });
    expect(w.codex.calls("thread/queue/add").length).toBe(adds + 1);
    queue.length = 0;
    w.codex.notify("thread/queue/changed", { threadId: T });
    await expect(codexLine).toContainText("delivered", { timeout: 15_000 });

    // Claude spawn target: Start new session, started with the attach hint.
    await claudeRow.click();
    await p.fill("#agentPrompt", "Write tests");
    await expect(p.locator("#agentSend")).toHaveText("Start new session");
    await p.click("#agentSend");
    const claudeLine = p.locator("#agentFeed li").filter({ hasText: "spawn-target" });
    await expect(claudeLine).toContainText("started", { timeout: 15_000 });
    await expect(claudeLine).toContainText("claude attach 0badc0de");
    expect(w.claude.read("bg.text")).toBe("[TabAgent: message from the user via the side panel]\nWrite tests");

    // Over the AD13 prompt limit: blocked in the panel, nothing reaches the bridge.
    const bgCalls = w.claude.calls().filter((c) => c.startsWith("--bg")).length;
    await p.fill("#agentPrompt", "x".repeat(8001));
    await expect(p.locator("#agentSend")).toBeDisabled();
    await expect(p.locator("#agentComposerNote")).toContainText("the limit is 8,000");
    await p.locator("#agentSend").click({ force: true });
    expect(w.claude.calls().filter((c) => c.startsWith("--bg")).length).toBe(bgCalls);
    await expect(p.locator("#agentFeed li")).toHaveCount(2);
  } finally {
    await p.close();
  }
});
