// Send to agent P2a (docs/specs/agent-inbox.md AD4, AD5, AD8): a stub MCP client runs the real
// `tabagent mcp` under an npx-style wrapper whose parent is a process named `claude`. The proxy's ancestor
// walk finds that pid, the stub `claude agents --json` lists it, so the agent is linked; a send to it is
// held, its next successful tool call carries the message block first, and a held message expires.
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeRecord, StubClaude } from "../packages/bridge/test/agents-fakes";
import { Harness } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "packages/bridge/dist/cli.js");
const TREE = join(HERE, "stubs/agent-tree.mjs");
const H = "[TabAgent: message from the user via the side panel]";
/** Shortened piggyback TTL for this bridge process (production: 30 min). */
const TTL_MS = 6000;

interface W {
  h: Harness;
  claude: StubClaude;
  panel: Page;
}

const test = base.extend<{}, { w: W }>({
  w: [
    async ({}, use) => {
      const claude = new StubClaude();
      const oldPath = process.env.PATH;
      process.env.PATH = `${claude.dir}:${oldPath}`;
      process.env.TABAGENT_HOLD_TTL_MS = String(TTL_MS);
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = oldPath;
        delete process.env.TABAGENT_HOLD_TTL_MS;
      }
      const panel = await h.openPanel();
      await use({ h, claude, panel });
      await h.stop();
      claude.cleanup();
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

function ui(w: W, msg: Record<string, unknown>): Promise<any> {
  return w.panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

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

/** Launch `claude` (node via a symlink) -> npm-exec stand-in -> `tabagent mcp`, and connect a client to it. */
async function agentUnderClaude(w: W): Promise<{ client: Client; pid: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ta-tree-"));
  const launcher = join(dir, "claude");
  symlinkSync(process.execPath, launcher);
  const pidFile = join(dir, "pid");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: w.h.home, TA_NODE: process.execPath, TA_CLI: CLI, TA_PID_FILE: pidFile };
  const transport = new StdioClientTransport({ command: launcher, args: [TREE, "claude", "--profile", "full"], env, stderr: "pipe" });
  const client = new Client({ name: "claude-code", version: "2.1.332" });
  await client.connect(transport);
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  return { client, pid: Number(readFileSync(pidFile, "utf8")) };
}

test("linked through the npx-style wrapper: held, delivered on the next successful tool call, then expired after the TTL", async ({ w }) => {
  await w.h.trustFixtures();
  const { client, pid } = await agentUnderClaude(w);
  const startedAt = 1_795_639_200_000;
  const agentId = `claude:${pid}:${startedAt}`;
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir })]);
  try {
    // AD4: the proxy registered with the ancestor pid, so discovery links the agent.
    await expect
      .poll(async () => (await ui(w, { type: "ui.agents_list" })).agents.find((a: any) => a.id === agentId), { timeout: 15_000 })
      .toMatchObject({ linked: true, canDriveTab: true, delivery: "piggyback" });

    await watchStatus(w);
    const held = await ui(w, { type: "ui.agent_send", requestId: "e2e-pb", agentId, prompt: "Reply with PIGGY-OK", includeTab: false });
    expect(held).toEqual({ type: "agent.sent", requestId: "e2e-pb", route: "piggyback", state: "held" });

    // AD8: the next successful tool result carries the message as its own block, before the tool output.
    const r: any = await client.callTool({ name: "tabs", arguments: { action: "list" } });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toEqual({ type: "text", text: `${H}\nReply with PIGGY-OK` });
    expect(r.content.length).toBeGreaterThan(1);
    expect(r.content[1].text).not.toContain(H);
    await expect.poll(() => statuses(w), { timeout: 5000 }).toContainEqual({ type: "agent.status", requestId: "e2e-pb", state: "delivered" });

    // A held message that no tool call picks up expires after the (shortened) TTL.
    const later = await ui(w, { type: "ui.agent_send", requestId: "e2e-exp", agentId, prompt: "Never picked up", includeTab: false });
    expect(later).toMatchObject({ route: "piggyback", state: "held" });
    await expect.poll(() => statuses(w), { timeout: TTL_MS + 5000 }).toContainEqual(expect.objectContaining({ requestId: "e2e-exp", state: "expired" }));
    const after: any = await client.callTool({ name: "tabs", arguments: { action: "list" } });
    expect(after.content.some((c: any) => c.type === "text" && c.text.startsWith(H))).toBe(false);
  } finally {
    await client.close();
  }
  // AD5: the proxy is gone, so its stream closed and the agent is unlinked at once.
  await expect
    .poll(async () => (await ui(w, { type: "ui.agents_list" })).agents.find((a: any) => a.id === agentId)?.linked, { timeout: 10_000 })
    .toBe(false);
});

test("'Start new session instead' (forceSpawn) spawns and drops the held message", async ({ w }) => {
  const { client, pid } = await agentUnderClaude(w);
  const startedAt = 1_795_639_300_000;
  const agentId = `claude:${pid}:${startedAt}`;
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir })]);
  w.claude.set("bg.out", "backgrounded · 0badc0de\nclaude attach 0badc0de\n");
  try {
    await expect
      .poll(async () => (await ui(w, { type: "ui.agents_list" })).agents.find((a: any) => a.id === agentId)?.delivery, { timeout: 15_000 })
      .toBe("piggyback");
    await watchStatus(w);
    expect(await ui(w, { type: "ui.agent_send", requestId: "e2e-h", agentId, prompt: "Held one", includeTab: false })).toMatchObject({ state: "held" });
    const spawned = await ui(w, { type: "ui.agent_send", requestId: "e2e-fs", agentId, prompt: "Start over", includeTab: false, forceSpawn: true });
    expect(spawned).toMatchObject({ route: "spawn", state: "started" });
    expect(w.claude.read("bg.text")).toBe(`${H}\nStart over`);
    await expect.poll(() => statuses(w), { timeout: 5000 }).toContainEqual(expect.objectContaining({ requestId: "e2e-h", state: "expired" }));
  } finally {
    await client.close();
  }
});
