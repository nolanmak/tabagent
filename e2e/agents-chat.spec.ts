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
      const saved = { PATH: process.env.PATH, P: process.env.TABAGENT_CLAUDE_PROJECTS_DIR, S: process.env.TABAGENT_CLAUDE_SESSIONS_DIR, C: process.env.TABAGENT_CODEX_SOCKET };
      process.env.PATH = `${claude.dir}:${saved.PATH}`;
      process.env.TABAGENT_CLAUDE_PROJECTS_DIR = claude.projectsDir;
      process.env.TABAGENT_CLAUDE_SESSIONS_DIR = claude.sessionsDir;
      // Never the real Codex app-server.
      process.env.TABAGENT_CODEX_SOCKET = join(claude.dir, "no-codex.sock");
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = saved.PATH;
        for (const [k, v] of [["TABAGENT_CLAUDE_PROJECTS_DIR", saved.P], ["TABAGENT_CLAUDE_SESSIONS_DIR", saved.S], ["TABAGENT_CODEX_SOCKET", saved.C]] as const) {
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

    // #159: Quick send on a connected session says Send, the same copy as the chat page; no new-session button.
    await row.locator("[data-quick-send]").click();
    await expect(panel.locator("#agentSend")).toHaveText("Send");
    await expect(panel.locator("#agentSpawn")).toBeHidden();
    await expect(panel.locator("#agents li.quick-send")).not.toContainText("Start a new session");
    await row.locator("[data-quick-send]").click();
    await expect(panel.locator("#agentPrompt")).toBeHidden();

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

    // #159: with the composer empty and focused, ↑ puts the last message sent from this page back for editing;
    // Esc cancels; sending the edit is a new message (the earlier one stays in the transcript as it was).
    const input = chat.locator("#input");
    await input.focus();
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Reply with CHAT-OK");
    await expect(chat.locator("#editBanner")).toBeVisible();
    await expect(chat.locator("#editBanner")).toContainText("Editing your last message");
    await input.press("Escape");
    await expect(input).toHaveValue("");
    await expect(chat.locator("#editBanner")).toBeHidden();
    await expect(input).toBeFocused();
    await input.press("ArrowUp");
    await expect(input).toHaveValue("Reply with CHAT-OK");
    await input.press("End");
    await input.pressSequentially(" again");
    await input.press("Enter");
    await expect(chat.locator("#pending .pending")).toContainText("Reply with CHAT-OK again");
    await expect(chat.locator("#editBanner")).toBeHidden();
    await expect.poll(() => notes.filter((n) => n.method === "notifications/claude/channel").length, { timeout: 5000 }).toBe(2);
    expect(notes.filter((n) => n.method === "notifications/claude/channel").at(-1)!.params.content).toContain("Reply with CHAT-OK again");
    await expect(log.locator(".msg-user .bubble").filter({ hasText: /^Reply with CHAT-OK$/ })).toHaveCount(1);
    // Text in the composer: ↑ is an ordinary cursor key.
    await input.fill("draft");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("draft");
    await expect(chat.locator("#editBanner")).toBeHidden();
    await input.fill("");

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

test("#159: narrow chat page: a header picker lists the sessions (rail hidden) and switches by keyboard, no horizontal overflow", async ({ w }) => {
  const one = { pid: 4401, startedAt: 1_795_639_800_000, sid: "eeeeeeee-1111-4222-8333-444444444441" };
  const two = { pid: 4402, startedAt: 1_795_639_700_000, sid: "eeeeeeee-1111-4222-8333-444444444442" };
  w.claude.transcript(w.claude.dir, one.sid, [tx.title("Picker one"), tx.user("first session"), tx.assistant([tx.text("one")])]);
  w.claude.transcript(w.claude.dir, two.sid, [tx.title("Picker two"), tx.user("second session"), tx.assistant([tx.text("two")])]);
  w.claude.agents([
    claudeRecord(one.pid, one.startedAt, { cwd: w.claude.dir, sessionId: one.sid, name: "picker-one" }),
    claudeRecord(two.pid, two.startedAt, { cwd: w.claude.dir, sessionId: two.sid, name: "picker-two" }),
  ]);
  const idOne = `claude:${one.pid}:${one.startedAt}`;
  const idTwo = `claude:${two.pid}:${two.startedAt}`;
  const chat = await w.h.ctx.newPage();
  try {
    await chat.setViewportSize({ width: 420, height: 760 });
    await chat.goto(`${CHAT}?agent=${encodeURIComponent(idOne)}`);
    const btn = chat.locator("#pickerBtn");
    await expect(btn).toContainText("Picker one", { timeout: 15_000 });
    await expect(chat.locator("#rail")).toBeHidden();
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(chat.locator("#title")).toHaveText("Picker one");

    // Click opens the list with the current session focused and marked; Esc closes back to the button.
    await btn.click();
    const list = chat.locator("#pickerList");
    await expect(list).toBeVisible();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(list.locator(`[data-picker-agent="${idOne}"]`)).toHaveAttribute("aria-current", "page");
    await expect(list.locator(`[data-picker-agent="${idOne}"]`)).toBeFocused();
    await expect(list.locator(`[data-picker-agent="${idTwo}"]`)).toContainText("Picker two");
    await expect(list.locator(`[data-picker-agent="${idTwo}"] .status-dot`)).toHaveCount(1);
    await noHorizontalScroll(chat);
    await chat.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(btn).toBeFocused();

    // Keyboard only: ↓ on the button opens it, ↓ moves to the next session, Enter switches to it.
    await chat.setViewportSize({ width: 360, height: 700 });
    await btn.press("ArrowDown");
    await expect(list).toBeVisible();
    await noHorizontalScroll(chat);
    await chat.keyboard.press("ArrowDown");
    await expect(list.locator(`[data-picker-agent="${idTwo}"]`)).toBeFocused();
    await chat.keyboard.press("Enter");
    await chat.waitForURL((u) => u.searchParams.get("agent") === idTwo);
    await expect(chat.locator("#title")).toHaveText("Picker two", { timeout: 15_000 });
    await expect(chat.locator("#log")).toContainText("second session");
    await expect(chat.locator("#pickerBtn")).toContainText("Picker two");
    await noHorizontalScroll(chat);

    // An outside click closes it.
    await chat.locator("#pickerBtn").click();
    await expect(list).toBeVisible();
    await chat.locator("#scroller").click({ position: { x: 5, y: 5 } });
    await expect(list).toBeHidden();

    // Wide windows keep the rail and hide the picker.
    await chat.setViewportSize({ width: 1100, height: 760 });
    await expect(chat.locator("#rail")).toBeVisible();
    await expect(chat.locator("#pickerBtn")).toBeHidden();
    await expect(chat.locator("#title")).toBeVisible();

    // #159: keyboard focus on a rail link survives the 5 s re-render (the status of another session changes).
    const railLink = chat.locator(`#railList [data-rail-agent="${idOne}"]`);
    await railLink.focus();
    const before = await chat.locator("#railList").innerHTML();
    w.claude.agents([
      claudeRecord(one.pid, one.startedAt, { cwd: w.claude.dir, sessionId: one.sid, name: "picker-one" }),
      claudeRecord(two.pid, two.startedAt, { cwd: w.claude.dir, sessionId: two.sid, name: "picker-two", status: "busy" }),
    ]);
    await expect.poll(() => chat.locator("#railList").innerHTML(), { timeout: 15_000 }).not.toBe(before);
    await expect(chat.locator(`#railList [data-rail-agent="${idTwo}"] .busy-dot`)).toHaveCount(1, { timeout: 15_000 });
    await expect(railLink).toBeFocused();
  } finally {
    await chat.close();
  }
});

test("#159: Working… clears within ~1 s of the final reply, though the polled status still says busy", async ({ w }) => {
  const pid = 4501;
  const startedAt = 1_795_639_900_000;
  const agentId = `claude:${pid}:${startedAt}`;
  const SID = "ffffffff-1111-4222-8333-444444444444";
  w.claude.transcript(w.claude.dir, SID, [tx.title("Busy stub"), tx.user("Run the slow job")]);
  // The stub keeps reporting busy for the whole test: only the transcript can clear the indicator.
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir, sessionId: SID, name: "busy-stub", status: "busy" })]);
  // The bridge caches the list for 5 s; wait until it lists the stub, so the page's history load finds it.
  const panel = await w.h.openPanel();
  await expect(panel.locator(`#agents [data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 15_000 });
  await panel.close();
  const chat = await w.h.ctx.newPage();
  try {
    await chat.goto(`${CHAT}?agent=${encodeURIComponent(agentId)}`);
    await expect(chat.locator("#title")).toHaveText("Busy stub", { timeout: 15_000 });
    await expect(chat.locator("#log")).toContainText("Run the slow job");
    const typing = chat.locator("#typing");
    await expect(typing).toBeVisible();
    await expect(chat.locator("#status")).toHaveText("Working…");

    // A tool call in flight keeps it (append until the watch, which starts with the page, picks it up).
    await expect(async () => {
      w.claude.appendTranscript(w.claude.dir, SID, [tx.assistant([tx.toolUse("toolu_busy", "Bash", { command: "sleep 30" })])]);
      await expect(chat.locator("#log .tool-chip").first()).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 10_000 });
    await expect(typing).toBeVisible();

    // The result and the final reply land: the indicator goes within about a second.
    w.claude.appendTranscript(w.claude.dir, SID, [tx.toolResult("toolu_busy", "done"), tx.assistant([tx.text("The slow job finished.")])]);
    const landed = Date.now();
    await expect(chat.locator("#log")).toContainText("The slow job finished.", { timeout: 3000 });
    await expect(typing).toBeHidden({ timeout: 1500 });
    expect(Date.now() - landed).toBeLessThan(2000);
    await expect(chat.locator("#status")).toHaveText("Idle");
    // A poll that still says busy does not bring it back.
    await chat.waitForTimeout(5500);
    await expect(typing).toBeHidden();
  } finally {
    await chat.close();
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
