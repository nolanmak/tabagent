// Send to agent P2a (docs/specs/agent-inbox.md AD4, AD5, AD8): a stub MCP client runs the real
// `tabagent mcp` under an npx-style wrapper whose parent is a process named `claude`. The proxy's ancestor
// walk finds that pid, the stub `claude agents --json` lists it, so the agent is linked; a send to it is
// held, its next successful tool call carries the message block first, and a held message expires.
// P3 (AD9): launched with `--dangerously-load-development-channels server:tabagent`, the proxy declares
// claude/channel and a send is pushed to the client as notifications/claude/channel, `sent` after the ack.
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
      // #151: never the real ~/.claude/sessions (Remote Control ids) or ~/.claude/projects.
      process.env.TABAGENT_CLAUDE_SESSIONS_DIR = claude.sessionsDir;
      process.env.TABAGENT_CLAUDE_PROJECTS_DIR = claude.projectsDir;
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = oldPath;
        delete process.env.TABAGENT_HOLD_TTL_MS;
        delete process.env.TABAGENT_CLAUDE_SESSIONS_DIR;
        delete process.env.TABAGENT_CLAUDE_PROJECTS_DIR;
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
async function agentUnderClaude(w: W, claudeArgs: string[] = []): Promise<{ client: Client; pid: number; notes: { method: string; params?: any }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "ta-tree-"));
  const launcher = join(dir, "claude");
  symlinkSync(process.execPath, launcher);
  const pidFile = join(dir, "pid");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: w.h.home, TA_NODE: process.execPath, TA_CLI: CLI, TA_PID_FILE: pidFile };
  const transport = new StdioClientTransport({ command: launcher, args: [TREE, "claude", ...claudeArgs, "--profile", "full"], env, stderr: "pipe" });
  const client = new Client({ name: "claude-code", version: "2.1.332" });
  const notes: { method: string; params?: any }[] = [];
  client.fallbackNotificationHandler = async (n) => void notes.push(n);
  await client.connect(transport);
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  return { client, pid: Number(readFileSync(pidFile, "utf8")), notes };
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

/** Open a user tab on a unique fixture URL and return its Chrome tab id. */
async function userTab(w: W, tag: string): Promise<{ page: Page; tabId: number; url: string }> {
  const url = `${w.h.A}/article.html?${tag}=${Date.now()}`;
  const page = await w.h.ctx.newPage();
  await page.goto(url);
  const tabId = await w.h.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);
  return { page, tabId, url };
}
const sessionOf = (w: W, tabId: number) => w.h.sw.evaluate((id) => (globalThis as any).__tabagent.listSessions().find((s: any) => s.tabIds.includes(id)) ?? null, tabId);
const groupOf = (w: W, tabId: number) => w.h.sw.evaluate(async (id) => (await chrome.tabs.get(id).catch(() => null))?.groupId ?? -2, tabId);

test("P2b tab grant: Send with the tab attaches it with no prompt, site policy still asks, a busy tab is refused, an expired send releases it", async ({ w }) => {
  const { h } = w;
  // Every origin is "ask" and every D18 gate is on, so any prompt the grant raised would show up.
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const { client, pid } = await agentUnderClaude(w);
  const startedAt = 1_795_639_500_000;
  const agentId = `claude:${pid}:${startedAt}`;
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir })]);
  const opened: Page[] = [];
  try {
    await expect
      .poll(async () => (await ui(w, { type: "ui.agents_list" })).agents.find((a: any) => a.id === agentId), { timeout: 15_000 })
      .toMatchObject({ linked: true, canDriveTab: true, delivery: "piggyback" });
    await watchStatus(w);

    // 0. The composer is truthful about what this target gets, and offers "Start a new session in <folder> instead".
    const p = await h.openPanel();
    opened.push(p);
    await p.locator(`#agents [data-agent-id="${agentId}"] [data-quick-send]`).click({ timeout: 15_000 });
    await expect(p.locator("#agentShareLabel")).toHaveText("Share this tab (agent can use it)");
    await expect(p.locator("#agentSpawn")).toHaveText(/^Start a new session in .* instead$/);
    await p.close();

    // 1. Send with the tab: the grant attaches it to the agent's group, with no attach (f) prompt.
    const t = await userTab(w, "grant");
    opened.push(t.page);
    const before = (await h.pendingPrompts()).length;
    const sent = await ui(w, { type: "ui.agent_send", requestId: "e2e-grant", agentId, prompt: "Summarize this tab", includeTab: true, tabId: t.tabId, title: "Article", url: t.url });
    expect(sent).toEqual({ type: "agent.sent", requestId: "e2e-grant", route: "piggyback", state: "held" });
    expect(await h.pendingPrompts()).toHaveLength(before);
    const s = await sessionOf(w, t.tabId);
    expect(s).toMatchObject({ label: "claude-code", active: t.tabId });
    expect(s.attached).toContain(t.tabId);
    expect(await groupOf(w, t.tabId)).toBeGreaterThan(-1);

    // 2. The agent's next tool call with that tabId works; the site prompt still appears (policy: ask),
    //    and it is a site prompt, not the attach prompt. The result carries the with-tab message.
    const r = await h.answerPrompt("once", () => h.ok(client, "page.snapshot", { tabId: t.tabId }));
    expect(r.prompt.kind).toBe("site");
    expect(r.prompt.sensitive).toBeUndefined();
    expect(r.title).not.toContain("take over your tab");
    const text = (r.result as any).text as string;
    expect(text.startsWith(`${H}\nSummarize this tab\n\nBrowser tab ${t.tabId} is now in your TabAgent tab group (use tabId ${t.tabId}).`)).toBe(true);
    expect(text).toContain("Article");
    await expect.poll(() => statuses(w), { timeout: 5000 }).toContainEqual({ type: "agent.status", requestId: "e2e-grant", state: "delivered" });

    // 3. A tab owned by another session: "tab not shared: TAB_BUSY" and the no-tab template.
    const other = await h.mcp({ label: "other-agent" });
    const busyTab = (await h.ok(other, "tabs", { action: "new" })).json.tabId as number;
    const busy = await ui(w, { type: "ui.agent_send", requestId: "e2e-busy", agentId, prompt: "Look at the other tab", includeTab: true, tabId: busyTab, title: "Other", url: "about:blank" });
    expect(busy).toEqual({ type: "agent.sent", requestId: "e2e-busy", route: "piggyback", state: "held", detail: "tab not shared: TAB_BUSY" });
    expect((await sessionOf(w, busyTab)).label).toBe("other-agent");
    const next: any = await client.callTool({ name: "tabs", arguments: { action: "list" } });
    expect(next.content[0].text).toContain("The user was looking at this page (you do not have browser access to it):");
    expect(next.content[0].text).not.toContain("is now in your TabAgent tab group");

    // 4. A held send that carried a grant and expires releases the tab: ungrouped, still open.
    const e = await userTab(w, "expire");
    opened.push(e.page);
    expect(await ui(w, { type: "ui.agent_send", requestId: "e2e-rel", agentId, prompt: "Never picked up", includeTab: true, tabId: e.tabId, title: "Article", url: e.url })).toMatchObject({ state: "held" });
    expect(await groupOf(w, e.tabId)).toBeGreaterThan(-1);
    await expect.poll(() => statuses(w), { timeout: TTL_MS + 5000 }).toContainEqual(expect.objectContaining({ requestId: "e2e-rel", state: "expired" }));
    await expect.poll(() => groupOf(w, e.tabId), { timeout: 5000 }).toBe(-1);
    expect(await sessionOf(w, e.tabId)).toBeNull();
    // The tab granted and used earlier stays with the agent.
    expect((await sessionOf(w, t.tabId))?.label).toBe("claude-code");
  } finally {
    await client.close();
    for (const p of opened) await p.close().catch(() => {});
  }
});

test("channel route: launched with --dangerously-load-development-channels server:tabagent, the panel send arrives as notifications/claude/channel and shows sent", async ({ w }) => {
  const { client, pid, notes } = await agentUnderClaude(w, ["--dangerously-load-development-channels", "server:tabagent"]);
  const startedAt = 1_795_639_400_000;
  const agentId = `claude:${pid}:${startedAt}`;
  w.claude.agents([claudeRecord(pid, startedAt, { cwd: w.claude.dir, name: "channel-target" })]);
  try {
    // AD9: the argv check passed, so the proxy declared the channel capability before connecting.
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    await expect
      .poll(async () => (await ui(w, { type: "ui.agents_list" })).agents.find((a: any) => a.id === agentId), { timeout: 15_000 })
      .toMatchObject({ linked: true, delivery: "channel" });

    // Through the real panel: the row says "instant", and the feed line ends at `sent` (never `delivered`).
    const p = w.panel;
    const row = p.locator(`#agents [data-agent-id="${agentId}"]`);
    await expect(row).toContainText("Connected · instant", { timeout: 15_000 });
    await row.locator("[data-quick-send]").click();
    await p.fill("#agentPrompt", "Reply with CHANNEL-OK");
    await p.click("#agentSend");
    const line = p.locator("#agentFeed li").filter({ hasText: "channel-target" });
    await expect(line).toContainText("instant");
    await expect(line.locator(".agent-state")).toHaveText("sent", { timeout: 15_000 });

    // The stub client (acting as Claude) got the composed message as a channel notification.
    await expect.poll(() => notes.filter((n) => n.method === "notifications/claude/channel").length, { timeout: 5000 }).toBe(1);
    const n = notes.find((x) => x.method === "notifications/claude/channel")!;
    expect(n.params).toEqual({ content: `${H}\nReply with CHANNEL-OK`, meta: { source: "tabagent" } });
    // Nothing was held: the next tool result carries no piggyback copy.
    const r: any = await client.callTool({ name: "tabs", arguments: { action: "list" } });
    expect(r.content.some((c: any) => c.type === "text" && c.text.startsWith(H))).toBe(false);
  } finally {
    await client.close();
  }
});
