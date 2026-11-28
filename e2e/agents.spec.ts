// Send to agent (docs/specs/agent-inbox.md): the panel's ui.* messages through the real worker, the
// real bridge process and its /ext socket, against a stub `claude` on PATH and a fake Codex app-server.
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { claudeRecord, codexThread, FakeCodex, StubClaude } from "../packages/bridge/test/agents-fakes";
import { DEV_EXTENSION_ID } from "../packages/protocol/src/index";
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
      const oldProjects = process.env.TABAGENT_CLAUDE_PROJECTS_DIR;
      // Inherited by the bridge process the harness spawns.
      process.env.PATH = `${claude.dir}:${oldPath}`;
      process.env.TABAGENT_CODEX_SOCKET = codex.socket;
      // #137: session titles come from the stub's transcripts, never the real ~/.claude.
      process.env.TABAGENT_CLAUDE_PROJECTS_DIR = claude.projectsDir;
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = oldPath;
        if (oldSock === undefined) delete process.env.TABAGENT_CODEX_SOCKET;
        else process.env.TABAGENT_CODEX_SOCKET = oldSock;
        if (oldProjects === undefined) delete process.env.TABAGENT_CLAUDE_PROJECTS_DIR;
        else process.env.TABAGENT_CLAUDE_PROJECTS_DIR = oldProjects;
      }
      // A message sender for ui(). It reports itself hidden so its own Agents section never polls the
      // bridge, which would fill the bridge's 5 s list cache before a test sets its stub agents.
      const panel = await h.ctx.newPage();
      await panel.addInitScript(() => Object.defineProperty(Document.prototype, "hidden", { get: () => true }));
      await panel.goto(`chrome-extension://${DEV_EXTENSION_ID}/sidepanel.html`);
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
  w.claude.agents([claudeRecord(4242, 1795639119768, { cwd: w.claude.dir, sessionId: "sid-4242", name: "stub-22" })]);
  w.claude.transcript(w.claude.dir, "sid-4242", [{ type: "user", message: { content: "x" } }, { type: "ai-title", aiTitle: "Pending user input check", sessionId: "sid-4242" }]);
  w.codex.threads([codexThread("019a0000-0000-7000-8000-000000000001", { type: "idle" }, { name: "Codex thread" })]);
  const state = await ui(w, { type: "ui.state" });
  expect(state.agentsSupported).toBe(true);
  // The pairing panel in h.start() already listed agents (before these stubs existed) when it connected,
  // and the bridge caches a list for 5 s (§5), so wait for a fresh one.
  let r: any;
  await expect
    .poll(async () => {
      r = await ui(w, { type: "ui.agents_list" });
      return r.sources;
    }, { timeout: 15_000, intervals: [500] })
    .toEqual({ claude: "ok", codex: "ok" });
  expect(r.supported).toBe(true);
  const ids = r.agents.map((a: any) => `${a.id} ${a.delivery}`).sort();
  // #137: an unlinked Claude session is not messageable (none); its title comes from its transcript.
  expect(ids).toEqual(["claude:4242:1795639119768 none", "codex:019a0000-0000-7000-8000-000000000001 queue"]);
  expect(r.agents.find((a: any) => a.vendor === "claude")).toMatchObject({ name: "stub-22", title: "Pending user input check" });
  // Never `--all` (§5).
  expect([...new Set(w.claude.calls())]).toEqual(["agents --json"]);
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

test("ui.agent_send to an unlinked stub Claude agent: plain send never spawns; forceSpawn starts claude --bg; untrusted workspace fails cleanly", async ({ w }) => {
  w.claude.agents([claudeRecord(4243, 1795639119999, { cwd: w.claude.dir })]);
  w.claude.set("bg.out", "backgrounded · 0badc0de\nclaude attach 0badc0de\n");
  // #137: no explicit "Start a new session" -> no spawn.
  const plain = await ui(w, { type: "ui.agent_send", requestId: "e2e-n", agentId: "claude:4243:1795639119999", prompt: "Hello", includeTab: false });
  expect(plain).toMatchObject({ requestId: "e2e-n", route: "none", state: "failed", code: "NO_ROUTE" });
  expect(w.claude.read("bg.text")).toBeNull();
  const ok = await ui(w, { type: "ui.agent_send", requestId: "e2e-s", agentId: "claude:4243:1795639119999", prompt: "Write tests", includeTab: false, forceSpawn: true });
  expect(ok).toMatchObject({ requestId: "e2e-s", route: "spawn", state: "started" });
  expect(ok.detail).toContain("claude attach 0badc0de");
  expect(w.claude.read("bg.text")).toBe("[TabAgent: message from the user via the side panel]\nWrite tests");

  w.claude.set("bg.out", null);
  w.claude.set("bg.err", "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n");
  w.claude.set("bg.exit", 1);
  const bad = await ui(w, { type: "ui.agent_send", requestId: "e2e-u", agentId: "claude:4243:1795639119999", prompt: "Again", includeTab: false, forceSpawn: true });
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
test("panel: lists stub agents, sends to Codex (queued -> delivered), Claude needs the explicit Start a new session button (started + attach hint), blocks over-limit", async ({ w }) => {
  const T = "019a0000-0000-7000-8000-0000000000c1";
  const queue: string[] = [];
  w.claude.set("bg.err", null);
  w.claude.set("bg.exit", null);
  w.claude.set("bg.out", "backgrounded · 0badc0de\n");
  w.claude.set("bg.text", null);
  // #137: one titled session (its transcript has an ai-title) and two untitled ones that collapse.
  w.claude.transcript(w.claude.dir, "sid-4250", [{ type: "ai-title", aiTitle: "Readable stub title", sessionId: "sid-4250" }]);
  w.claude.agents([
    claudeRecord(4250, 1795639120000, { cwd: w.claude.dir, name: "spawn-target", sessionId: "sid-4250" }),
    claudeRecord(4251, 1795639120001, { cwd: w.claude.dir, name: "untitled-a1", sessionId: "sid-4251" }),
    claudeRecord(4252, 1795639120002, { cwd: w.claude.dir, name: "untitled-b2", sessionId: "sid-4252" }),
  ]);
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
    // The bridge caches the list for 5 s (§5); the panel's next 5 s refresh picks up the stubs at the latest.
    await expect(codexRow).toContainText("Codex helper", { timeout: 15_000 });
    await expect(claudeRow).toBeVisible({ timeout: 15_000 });
    await expect(codexRow).toContainText("queued (Codex)");
    await expect(claudeRow).toContainText("Readable stub title");
    await expect(claudeRow).not.toContainText("spawn-target");
    await expect(claudeRow).toContainText("Not connected — can't message this session");
    await expect(claudeRow.getByRole("link", { name: "Connect it: run tabagent setup claude, then restart this session" })).toHaveAttribute("href", /send-to-agent\.md#connect-a-session/);
    await expect(claudeRow).toContainText("pid 4250");
    // The untitled, not-connected sessions are collapsed under a disclosure.
    await expect(p.locator("#agents details summary")).toHaveText("2 other sessions");
    await expect(p.locator('#agents [data-agent-id="claude:4251:1795639120001"]')).toBeHidden();
    await expect(p.locator("#agentSelection")).toBeDisabled();

    // Codex: queued, then delivered once the submission leaves the queue.
    const adds = w.codex.calls("thread/queue/add").length;
    await codexRow.click();
    await p.fill("#agentPrompt", "Summarise the page");
    await expect(p.locator("#agentSend")).toHaveText("Send");
    await p.click("#agentSend");
    const codexLine = p.locator("#agentFeed li").filter({ hasText: "Codex helper" });
    await expect(codexLine).toContainText("queued (Codex)");
    await expect(codexLine.locator(".agent-state")).toHaveText("queued", { timeout: 15_000 });
    expect(w.codex.calls("thread/queue/add").length).toBe(adds + 1);
    queue.length = 0;
    w.codex.notify("thread/queue/changed", { threadId: T });
    await expect(codexLine.locator(".agent-state")).toHaveText("delivered", { timeout: 15_000 });

    // #137: an unlinked Claude session: Send is disabled and plain Send cannot spawn; the separate
    // "Start a new session in <folder>" button does, and the feed says where it runs and how to attach.
    const folder = w.claude.dir.split("/").pop()!;
    await claudeRow.click();
    await p.fill("#agentPrompt", "Write tests");
    await expect(p.locator("#agentSend")).toHaveText("Send");
    await expect(p.locator("#agentSend")).toBeDisabled();
    await expect(p.locator("#agentComposerNote")).toContainText("not connected to TabAgent");
    await p.locator("#agentSend").click({ force: true });
    await p.waitForTimeout(300);
    expect(w.claude.read("bg.text")).toBeNull();
    const spawnBtn = p.locator("#agentSpawn");
    await expect(spawnBtn).toBeVisible();
    await expect(spawnBtn).toHaveText(`Start a new session in ${folder}`);
    await spawnBtn.click();
    const claudeLine = p.locator("#agentFeed li").filter({ hasText: `New session in ${folder}` });
    await expect(claudeLine.locator(".agent-state")).toHaveText("started", { timeout: 15_000 });
    await expect(claudeLine).toContainText("claude attach 0badc0de");
    await expect(claudeLine).toContainText(w.claude.dir);
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

// P2c (#92, AD14): the context menu writes a pending intent and opens the panel; it never sends. The panel
// preselects the agent, includes the selection, sends it, and drops it when the user switches tabs.
test("context menu: intent opens the panel with the agent preselected and the selection included; a tab switch drops it", async ({ w }) => {
  const T = "019a0000-0000-7000-8000-0000000000d1";
  const AGENT = `codex:${T}`;
  const queue: string[] = [];
  w.codex.threads([codexThread(T, { type: "idle" }, { name: "Menu helper" })]);
  w.codex.on("thread/queue/add", ({ clientUserMessageId }) => {
    queue.push(`sub-${clientUserMessageId}`);
    return { queuedSubmission: { id: `sub-${clientUserMessageId}`, clientUserMessageId, input: [] } };
  });
  w.codex.on("thread/queue/list", () => ({ data: queue.map((id) => ({ id })), nextCursor: null }));
  const sw = w.h.sw;

  // A recent agent shows up in the menu by name, plus Choose…. Wait out the bridge's 5 s list cache.
  await sw.evaluate((id) => chrome.storage.local.set({ recentAgents: [{ id, name: "Menu helper" }] }), AGENT);
  let items: any[] = [];
  await expect
    .poll(async () => {
      items = await sw.evaluate(() => (globalThis as any).__tabagent.rebuildMenus());
      return items.map((i) => i.title);
    }, { timeout: 15_000, intervals: [1000] })
    .toEqual(["Send to agent", "Menu helper", "", "Choose…"]);
  expect(items[0].contexts).toEqual(["page", "selection"]);
  const agentItem = items.find((i) => i.title === "Menu helper");

  // Select text on a fixture page, then "right-click > Send to agent > Menu helper".
  const page = await w.h.ctx.newPage();
  await page.goto(`${w.h.A}/article.html`);
  const selected = await page.evaluate(() => {
    const para = document.querySelectorAll("p")[1];
    getSelection()!.selectAllChildren(para);
    return getSelection()!.toString();
  });
  expect(selected.length).toBeGreaterThan(50);
  // Its own window: a panel takes only intents for its own window's tabs, and w.panel lives in the first one.
  const tab: { id: number; windowId: number } = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    const win = await chrome.windows.create({ tabId: t.id! });
    return { id: t.id!, windowId: win!.id! };
  }, `${w.h.A}/article.html`);
  const before = w.codex.calls("thread/queue/add").length;
  await sw.evaluate(([info, t]) => (globalThis as any).__tabagent.contextMenuClick(info, t), [{ menuItemId: agentItem.id, selectionText: selected }, tab] as const);
  // The menu never sends (AD14): it only wrote the intent.
  const intent: any = await sw.evaluate(async () => (await chrome.storage.session.get("agentSendIntent")).agentSendIntent);
  expect(intent).toMatchObject({ agentId: AGENT, tabId: tab.id, selection: selected });
  expect(w.codex.calls("thread/queue/add").length).toBe(before);

  // The side panel for that window. Playwright cannot reach the real side panel, so open sidepanel.html as a
  // background tab in the same window: its active tab is still the fixture page, as the real panel's would be.
  const panelUrl = `chrome-extension://${DEV_EXTENSION_ID}/sidepanel.html`;
  const [p] = await Promise.all([
    w.h.ctx.waitForEvent("page", (pg) => pg.url().startsWith(panelUrl)),
    sw.evaluate(([url, windowId]) => chrome.tabs.create({ url, windowId, active: false }).then(() => undefined), [panelUrl, tab.windowId] as const),
  ]);
  try {
    const row = p.locator(`#agents [data-agent-id="${AGENT}"]`);
    await expect(row).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(p.locator("#agentTarget")).toContainText("Menu helper");
    await expect(p.locator("#agentSelection")).toBeEnabled();
    await expect(p.locator("#agentSelection")).toBeChecked();
    await expect(p.locator("#agentSelectionPreview")).toContainText("Longer paragraph text");
    // The panel consumed the intent.
    await expect.poll(() => sw.evaluate(async () => (await chrome.storage.session.get("agentSendIntent")).agentSendIntent ?? null)).toBeNull();

    await p.locator("#agentPrompt").fill("What does this say?");
    await p.locator("#agentSend").dispatchEvent("click");
    const line = p.locator("#agentFeed li").filter({ hasText: "Menu helper" });
    await expect(line.locator(".agent-state")).toHaveText("queued", { timeout: 15_000 });
    const text: string = w.codex.calls("thread/queue/add").at(-1)!.params.input[0].text;
    expect(text).toContain("[TabAgent: message from the user via the side panel]\nWhat does this say?");
    expect(text).toContain("Selected text: <<<PAGE_DATA");
    expect(text).toContain(selected);
    // A successful send records the agent as recent.
    await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get("recentAgents")).recentAgents as { id: string }[] | undefined)?.[0]?.id)).toBe(AGENT);

    // A second intent while the panel is open (storage.onChanged), naming an agent that is gone.
    await sw.evaluate(([info, t]) => (globalThis as any).__tabagent.contextMenuClick(info, t), [{ menuItemId: String(agentItem.id).replace(AGENT, "codex:gone"), selectionText: "second pick" }, tab] as const);
    await expect(p.locator("#agentTarget")).toContainText("That agent is no longer running.");
    await expect(row).toHaveAttribute("aria-selected", "false");
    await expect(p.locator("#agentSelection")).toBeChecked();
    await expect(p.locator("#agentSelectionPreview")).toContainText("second pick");

    // Switching to another tab before Send drops the selection and shows which tab will be shared.
    const other = await w.h.ctx.newPage();
    await other.goto(`${w.h.A}/index.html`);
    const otherTitle = await other.title();
    await sw.evaluate(async ([url, windowId]) => {
      const [t] = await chrome.tabs.query({ url });
      if (t.windowId !== windowId) await chrome.tabs.move(t.id!, { windowId, index: -1 });
      await chrome.tabs.update(t.id!, { active: true });
    }, [`${w.h.A}/index.html`, tab.windowId] as const);
    await expect(p.locator("#agentSelection")).toBeDisabled();
    await expect(p.locator("#agentSelection")).not.toBeChecked();
    await expect(p.locator("#agentSelectionPreview")).toContainText("dropped: you switched tabs");
    await expect(p.locator("#agentTabTitle")).toContainText(otherTitle || `${w.h.A}/index.html`);
    await other.close();
  } finally {
    await p.close();
    await page.close();
  }
});
