// #151: a session opens as a chat page. A linked stub agent (launched with channels, so sends are instant)
// has a stub transcript: clicking its row opens chat.html with the history; a message sent from the page
// shows pending, and when the stub appends the delivered message and an assistant reply to the transcript,
// both appear live. An unlinked agent with a bridgeSessionId shows "Open in Claude" and no composer.
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeRecord, StubClaude, tx } from "../packages/bridge/test/agents-fakes";
import { DEV_EXTENSION_ID } from "../packages/protocol/src/index";
import { Harness } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "packages/bridge/dist/cli.js");
const TREE = join(HERE, "stubs/agent-tree.mjs");
const CHAT = `chrome-extension://${DEV_EXTENSION_ID}/chat.html`;

interface W {
  h: Harness;
  claude: StubClaude;
}

const test = base.extend<{}, { w: W }>({
  w: [
    async ({}, use) => {
      const claude = new StubClaude();
      const saved = { PATH: process.env.PATH, P: process.env.TABAGENT_CLAUDE_PROJECTS_DIR, S: process.env.TABAGENT_CLAUDE_SESSIONS_DIR };
      process.env.PATH = `${claude.dir}:${saved.PATH}`;
      process.env.TABAGENT_CLAUDE_PROJECTS_DIR = claude.projectsDir;
      process.env.TABAGENT_CLAUDE_SESSIONS_DIR = claude.sessionsDir;
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = saved.PATH;
        for (const [k, v] of [["TABAGENT_CLAUDE_PROJECTS_DIR", saved.P], ["TABAGENT_CLAUDE_SESSIONS_DIR", saved.S]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      await use({ h, claude });
      await h.stop();
      claude.cleanup();
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

/** `claude` (node via a symlink) -> npm-exec stand-in -> `tabagent mcp`, with channels, so the agent links. */
async function agentUnderClaude(w: W): Promise<{ client: Client; pid: number; notes: { method: string; params?: any }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "ta-tree-"));
  const launcher = join(dir, "claude");
  symlinkSync(process.execPath, launcher);
  const pidFile = join(dir, "pid");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: w.h.home, TA_NODE: process.execPath, TA_CLI: CLI, TA_PID_FILE: pidFile };
  const transport = new StdioClientTransport({ command: launcher, args: [TREE, "claude", "--dangerously-load-development-channels", "server:tabagent", "--profile", "full"], env, stderr: "pipe" });
  const client = new Client({ name: "claude-code", version: "2.1.332" });
  const notes: { method: string; params?: any }[] = [];
  client.fallbackNotificationHandler = async (n) => void notes.push(n);
  await client.connect(transport);
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  return { client, pid: Number(readFileSync(pidFile, "utf8")), notes };
}

async function noHorizontalScroll(p: Page) {
  const { scrollWidth, clientWidth } = await p.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("click a linked session -> chat page with history; a sent message is pending, then the reply appears live", async ({ w }) => {
  const { client, pid, notes } = await agentUnderClaude(w);
  const startedAt = 1_795_639_600_000;
  const agentId = `claude:${pid}:${startedAt}`;
  const SID = "cccccccc-1111-4222-8333-444444444444";
  w.claude.transcript(w.claude.dir, SID, [
    tx.title("Chat stub session"),
    tx.user("Earlier question about the build"),
    tx.assistant([tx.text("Here is **the plan**:\n\n- step one\n- step two\n\n```sh\nnpm test\n```"), tx.toolUse("toolu_e2e", "Bash", { command: "npm test -- --run" })]),
    tx.toolResult("toolu_e2e", "12 passed"),
    tx.system(),
    tx.assistant([tx.text("All tests pass.")]),
  ]);
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir, sessionId: SID, name: "chat-stub" })]);
  const pages: Page[] = [];
  try {
    const panel = await w.h.openPanel();
    pages.push(panel);
    await panel.setViewportSize({ width: 320, height: 800 });
    const row = panel.locator(`#agents [data-agent-id="${agentId}"]`);
    await expect(row).toContainText("Connected · instant", { timeout: 15_000 });
    await expect(row).toContainText("Chat stub session");
    await noHorizontalScroll(panel);

    // The row opens the chat page in a new tab.
    const [chat] = await Promise.all([w.h.ctx.waitForEvent("page", (pg) => pg.url().startsWith(CHAT)), row.locator(".agent-title").click()]);
    pages.push(chat);
    expect(new URL(chat.url()).searchParams.get("agent")).toBe(agentId);
    await expect(chat.locator("#title")).toHaveText("Chat stub session", { timeout: 15_000 });
    await expect(chat.locator("#conn")).toHaveText("Connected · instant");
    const log = chat.locator("#log");
    await expect(log.locator(".msg-user").first()).toContainText("Earlier question about the build");
    await expect(log.locator(".msg-assistant strong")).toHaveText("the plan");
    await expect(log.locator(".msg-assistant pre.code")).toContainText("npm test");
    await expect(log.locator(".tool-chip summary")).toContainText("Bash: npm test -- --run");
    await log.locator(".tool-chip summary").click();
    await expect(log.locator(".tool-chip .tool-body")).toContainText("12 passed");
    await expect(log).toContainText("All tests pass.");
    await expect(chat.locator("#composer")).toBeVisible();
    await expect(chat.locator("#card")).toBeHidden();

    // Clicking the row again reuses the open chat tab.
    const again = await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "ui.agent_open_chat", agentId: id }), agentId);
    expect(again).toMatchObject({ ok: true, reused: true });

    // Send from the composer (Enter). It shows at once as pending, and reaches the agent as a channel push.
    await chat.locator("#input").fill("Reply with CHAT-OK");
    await chat.locator("#input").press("Enter");
    const pending = chat.locator("#pending .pending");
    await expect(pending).toContainText("Reply with CHAT-OK");
    await expect(pending.locator(".pending-state")).toHaveText("Sent · waiting for the agent", { timeout: 15_000 });
    await expect(chat.locator("#input")).toHaveValue("");
    await expect.poll(() => notes.filter((n) => n.method === "notifications/claude/channel").length, { timeout: 5000 }).toBe(1);

    // The agent (here: the test) writes the delivered message and its reply to the transcript; both appear live.
    w.claude.appendTranscript(w.claude.dir, SID, [tx.channel("Reply with CHAT-OK"), tx.assistant([tx.text("CHAT-OK, replying live.")])]);
    await expect(log).toContainText("CHAT-OK, replying live.", { timeout: 5000 });
    await expect(pending).toHaveCount(0);
    const mine = log.locator(".msg-user").filter({ hasText: "Reply with CHAT-OK" });
    await expect(mine.locator(".via")).toHaveText("via TabAgent");

    // Layout: no horizontal scroll, header and composer stay put.
    await noHorizontalScroll(chat);
    await chat.setViewportSize({ width: 360, height: 700 });
    await noHorizontalScroll(chat);
    await expect(chat.locator(".chat-foot")).toBeInViewport();
    await expect(chat.locator(".chat-head")).toBeInViewport();
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    await client.close();
  }
});

test("an unlinked session with Remote Control: Open in Claude with the right URL and no composer; the row says Remote Control only", async ({ w }) => {
  const pid = 4301;
  const startedAt = 1_795_639_700_000;
  const agentId = `claude:${pid}:${startedAt}`;
  const RC = "session_01E2eRemoteControl";
  const SID = "dddddddd-1111-4222-8333-444444444444";
  w.claude.transcript(w.claude.dir, SID, [tx.title("Remote-only stub"), tx.user("hello from the terminal"), tx.assistant([tx.text("hi there")])]);
  w.claude.session(pid, { startedAt, sessionId: SID, bridgeSessionId: RC, status: "idle" });
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir, sessionId: SID, name: "remote-stub" })]);
  const pages: Page[] = [];
  try {
    const panel = await w.h.openPanel();
    pages.push(panel);
    await panel.setViewportSize({ width: 320, height: 800 });
    const row = panel.locator(`#agents [data-agent-id="${agentId}"]`);
    await expect(row).toContainText("Remote Control only", { timeout: 15_000 });
    await expect(row.locator("a.rc-link")).toHaveAttribute("href", `https://claude.ai/code/${RC}`);
    await expect(row.locator("a.rc-link")).toHaveAttribute("rel", "noopener noreferrer");
    await expect(row.locator("[data-quick-send]")).toHaveCount(0);
    await noHorizontalScroll(panel);

    const chat = await w.h.ctx.newPage();
    pages.push(chat);
    await chat.goto(`${CHAT}?agent=${encodeURIComponent(agentId)}`);
    await expect(chat.locator("#title")).toHaveText("Remote-only stub", { timeout: 15_000 });
    await expect(chat.locator("#log")).toContainText("hello from the terminal");
    await expect(chat.locator("#rcBtn")).toHaveAttribute("href", `https://claude.ai/code/${RC}`);
    const card = chat.locator("#card");
    await expect(card).toContainText("This session isn't connected to TabAgent.");
    await expect(card.locator("a[data-rc]")).toHaveAttribute("href", `https://claude.ai/code/${RC}`);
    await expect(card.locator("a[data-rc]")).toHaveAttribute("target", "_blank");
    await expect(chat.locator("#composer")).toBeHidden();
    await noHorizontalScroll(chat);

    // The secondary action: start a new session in its folder (the only spawn path).
    w.claude.set("bg.out", "backgrounded · 0badc0de\nclaude attach 0badc0de\n");
    await card.locator("[data-spawn-start]").click();
    await expect(chat.locator("#composer")).toBeVisible();
    await expect(chat.locator("#sendBtn")).toHaveText("Start session");
    await chat.locator("#input").fill("Start fresh");
    await chat.locator("#input").press("Enter");
    const p = chat.locator("#pending .pending");
    await expect(p.locator(".pending-state")).toHaveText("Started a new session", { timeout: 15_000 });
    await expect(p).toContainText("claude attach 0badc0de");
    expect(w.claude.read("bg.text")).toBe("[TabAgent: message from the user via the side panel]\nStart fresh");
    await expect(chat.locator("#composer")).toBeHidden();
  } finally {
    for (const p of pages) await p.close().catch(() => {});
  }
});

test("chat page states: no agent id, and a session that is not running", async ({ w }) => {
  const chat = await w.h.ctx.newPage();
  try {
    await chat.goto(CHAT);
    await expect(chat.locator("#notice")).toContainText("No session selected");
    await chat.goto(`${CHAT}?agent=${encodeURIComponent("claude:1:2")}`);
    await expect(chat.locator("#card")).toContainText("This session is no longer running.", { timeout: 15_000 });
    await expect(chat.locator("#notice")).toContainText("no longer running");
    await expect(chat.locator("#composer")).toBeHidden();
  } finally {
    await chat.close();
  }
});
