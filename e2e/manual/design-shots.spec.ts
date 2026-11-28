// Opt-in (TABAGENT_MANUAL=1): screenshots of every extension page in a populated state, light and dark, for
// design reviews (#156). Stub agents (a linked one, Remote Control only, Codex, not connected), a pending
// prompt, sessions with tabs, a draft workflow, sites and activity. Output: $SHOTS_DIR (default docs/design/shots).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeRecord, codexThread, FakeCodex, StubClaude, tx } from "../../packages/bridge/test/agents-fakes";
import { DEV_EXTENSION_ID } from "../../packages/protocol/src/index";
import { Harness } from "../harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "packages/bridge/dist/cli.js");
const TREE = join(HERE, "..", "stubs/agent-tree.mjs");
const EXT = `chrome-extension://${DEV_EXTENSION_ID}`;
const OUT = process.env.SHOTS_DIR ?? join(process.cwd(), "docs", "design", "shots");

test.setTimeout(300_000);

test("design screenshots", async () => {
  mkdirSync(OUT, { recursive: true });
  const claude = new StubClaude();
  const codex = await new FakeCodex().listen();
  const saved = { PATH: process.env.PATH, P: process.env.TABAGENT_CLAUDE_PROJECTS_DIR, S: process.env.TABAGENT_CLAUDE_SESSIONS_DIR, C: process.env.TABAGENT_CODEX_SOCKET };
  process.env.PATH = `${claude.dir}:${saved.PATH}`;
  process.env.TABAGENT_CLAUDE_PROJECTS_DIR = claude.projectsDir;
  process.env.TABAGENT_CLAUDE_SESSIONS_DIR = claude.sessionsDir;
  process.env.TABAGENT_CODEX_SOCKET = codex.socket;
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
  const clients: Client[] = [];
  try {
    // A linked Claude session (channels, so instant) with a conversation.
    const dir = mkdtempSync(join(tmpdir(), "ta-tree-"));
    const launcher = join(dir, "claude");
    symlinkSync(process.execPath, launcher);
    const pidFile = join(dir, "pid");
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TABAGENT_HOME: h.home, TA_NODE: process.execPath, TA_CLI: CLI, TA_PID_FILE: pidFile };
    const transport = new StdioClientTransport({ command: launcher, args: [TREE, "claude", "--dangerously-load-development-channels", "server:tabagent", "--profile", "full"], env, stderr: "pipe" });
    const linked = new Client({ name: "claude-code", version: "2.1.332" });
    await linked.connect(transport);
    clients.push(linked);
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const startedAt = Date.now() - 42 * 60_000;
    const agentId = `claude:${pid}:${startedAt}`;
    const SID = "cccccccc-1111-4222-8333-444444444444";
    claude.transcript(claude.dir, SID, [
      tx.title("Fix flaky checkout test"),
      tx.user("The checkout e2e fails about one run in five. Can you find out why?"),
      tx.assistant([
        tx.text("I'll start by running the test a few times to reproduce it."),
        tx.toolUse("t1", "Bash", { command: "npx playwright test e2e/checkout.spec.ts --repeat-each 10" }),
      ]),
      tx.toolResult("t1", "8 passed, 2 failed\n  ✘ checkout › applies coupon (timeout 5000ms)"),
      tx.assistant([tx.toolUse("t2", "Read", { file_path: "e2e/checkout.spec.ts" })]),
      tx.toolResult("t2", "…"),
      tx.assistant([tx.toolUse("t3", "Grep", { pattern: "applyCoupon", path: "src" })]),
      tx.toolResult("t3", "src/cart/coupon.ts:14"),
      tx.assistant([
        tx.text(
          "Found it. The test clicks **Apply** before the cart total finishes loading, so the coupon request races the price fetch.\n\nThe fix:\n\n- wait for the total to render before applying\n- assert on the discounted price, not the toast\n\n```ts\nawait expect(page.getByTestId(\"total\")).toHaveText(/\\$\\d/);\nawait page.getByRole(\"button\", { name: \"Apply\" }).click();\n```",
        ),
        tx.toolUse("t4", "Edit", { file_path: "e2e/checkout.spec.ts" }),
      ]),
      tx.toolResult("t4", "Applied 1 edit"),
      tx.assistant([tx.toolUse("t5", "Bash", { command: "npx playwright test e2e/checkout.spec.ts --repeat-each 20" })]),
      tx.toolResult("t5", "20 passed"),
      tx.system(),
      tx.assistant([tx.text("20 out of 20 runs pass now. Want me to open a PR?")]),
    ]);
    // Remote Control only, a titled not-connected session, and two untitled ones that collapse.
    const RC_SID = "dddddddd-1111-4222-8333-444444444444";
    claude.transcript(claude.dir, RC_SID, [tx.title("Draft release notes"), tx.user("hello"), tx.assistant([tx.text("hi")])]);
    const rcStart = Date.now() - 3 * 3600_000;
    claude.session(4301, { startedAt: rcStart, sessionId: RC_SID, bridgeSessionId: "session_01DesignShots", status: "idle" });
    claude.transcript(claude.dir, "sid-4302", [tx.title("Refactor auth middleware")]);
    claude.agents([
      claudeRecord(pid, startedAt, { cwd: claude.dir, sessionId: SID, name: "checkout" }),
      claudeRecord(4301, rcStart, { cwd: "/Users/me/code/website", sessionId: RC_SID, name: "notes" }),
      claudeRecord(4302, Date.now() - 26 * 3600_000, { cwd: "/Users/me/code/api", sessionId: "sid-4302", name: "auth", status: "busy" }),
      claudeRecord(4303, Date.now() - 5 * 86400_000, { cwd: "/Users/me/code/scratch", sessionId: "sid-4303", name: "untitled-a" }),
      claudeRecord(4304, Date.now() - 6 * 86400_000, { cwd: "/Users/me/code/scratch", sessionId: "sid-4304", name: "untitled-b" }),
    ]);
    codex.threads([codexThread("019a0000-0000-7000-8000-0000000000c1", { type: "idle" }, { name: "Codex: tidy dependencies" })]);

    // Sessions with tabs, a draft workflow and activity.
    await h.trustFixtures();
    const research = await h.mcp({ label: "research-bot" });
    await h.ok(research, "tabs", { action: "new", url: `${h.A}/index.html` });
    await h.ok(research, "tabs", { action: "new", url: `${h.A}/article.html` });
    const shop = await h.mcp({ label: "checkout-flow" });
    const tabId = (await h.ok(shop, "tabs", { action: "new" })).json.tabId;
    await h.ok(shop, "workflow.capture_start", { tabId, source: "agent", name: "Search the fixture shop" });
    await h.ok(shop, "nav.goto", { tabId, url: `${h.A}/index.html` });
    await h.ok(shop, "nav.wait", { tabId, for: "load" });
    const snap = await h.ok(shop, "page.snapshot", { tabId });
    await h.ok(shop, "act.click", { tabId, ref: Harness.ref(snap.text, /button "Click me"/) });
    await h.ok(shop, "act.type", { tabId, ref: Harness.ref(snap.text, /searchbox "Search"/), text: "widgets" });
    await h.ok(shop, "workflow.capture_stop", { tabId });
    await h.ok(shop, "page.markdown", { tabId });

    // Sites, then a pending prompt (B is read-only, so navigating there asks).
    await h.setPolicies(
      { [h.A]: "full", [h.B]: "read", "https://github.com": "act", "https://mail.google.com": "read", "https://app.mercury.com": "deny" },
      { paused: false, devAllowSensitive: false, sites: { "https://github.com": { auth: true, preapproved: { a: true }, authAlways: ["code-source:email"] }, [h.A]: { lite: true } } },
    );
    const deploy = await h.mcp({ label: "deploy-bot" });
    await h.ok(deploy, "tabs", { action: "new" });
    void h.call(deploy, "nav.goto", { url: `${h.B}/index.html` }).catch(() => {});
    await expect.poll(async () => (await h.pendingPrompts()).length, { timeout: 10_000 }).toBe(1);
    const [prompt] = await h.pendingPrompts();

    const pages: Page[] = [];
    const open = async (url: string, w: number, ht: number) => {
      const p = await h.ctx.newPage();
      pages.push(p);
      await p.setViewportSize({ width: w, height: ht });
      await p.goto(url);
      return p;
    };
    const shoot = async (p: Page, name: string, fullPage = true) => {
      // A sticky header would be painted mid-page in a full-page capture.
      if (fullPage) await p.addStyleTag({ content: ".topbar, .chat-head { position: static !important; }" });
      for (const scheme of ["light", "dark"] as const) {
        await p.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await p.waitForTimeout(150);
        await p.screenshot({ path: join(OUT, `${name}-${scheme}.png`), fullPage, animations: "disabled", caret: "hide" });
      }
    };

    // Side panel.
    const panel = await open(`${EXT}/sidepanel.html`, 380, 900);
    await expect(panel.locator(`#agents [data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(`li[data-prompt-id="${prompt.promptId}"]`)).toBeVisible();
    await panel.waitForTimeout(500);
    await shoot(panel, "panel");
    await panel.setViewportSize({ width: 320, height: 900 });
    await shoot(panel, "panel-320");
    await panel.setViewportSize({ width: 380, height: 900 });
    // Quick send open under the linked row.
    await panel.locator(`#agents [data-agent-id="${agentId}"] [data-quick-send]`).click();
    await panel.locator("#agentPrompt").fill("Also run the cart tests");
    await shoot(panel, "panel-quicksend", false);
    await panel.locator(`#agents [data-agent-id="${agentId}"] [data-quick-send]`).click();
    // Settings open (and every other collapsible section).
    for (const id of ["activityBox", "workflowsBox", "settingsBox", "sessionsBox"]) if (!(await panel.locator(`#${id}`).evaluate((d) => (d as HTMLDetailsElement).open))) await panel.click(`#${id} > summary`);
    await panel.locator("#settingsBox").scrollIntoViewIfNeeded();
    await shoot(panel, "panel-expanded");

    // Chat page.
    const chat = await open(`${EXT}/chat.html?agent=${encodeURIComponent(agentId)}`, 1100, 800);
    await expect(chat.locator("#title")).toHaveText("Fix flaky checkout test", { timeout: 15_000 });
    await chat.locator(".tool-chip summary").first().click();
    await chat.mouse.move(5, 790);
    await chat.locator("#scroller").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await chat.waitForTimeout(300);
    await shoot(chat, "chat", false);
    await chat.setViewportSize({ width: 420, height: 800 });
    await shoot(chat, "chat-narrow", false);
    // #159: the header's session picker open on a narrow window (the rail is hidden).
    await chat.locator("#pickerBtn").click();
    await expect(chat.locator("#pickerList")).toBeVisible();
    await shoot(chat, "chat-narrow-picker", false);
    await chat.keyboard.press("Escape");
    // #159: ↑ in the empty composer brings back the last message sent from this page.
    await chat.locator("#input").fill("Also run the cart tests");
    await chat.locator("#input").press("Enter");
    await expect(chat.locator("#pending .pending")).toBeVisible();
    await chat.locator("#input").press("ArrowUp");
    await expect(chat.locator("#editBanner")).toBeVisible();
    await shoot(chat, "chat-narrow-edit", false);
    await chat.locator("#input").press("Escape");
    // A Remote Control only session: the not-connected card instead of the composer.
    const rc = await open(`${EXT}/chat.html?agent=${encodeURIComponent(`claude:4301:${rcStart}`)}`, 1100, 800);
    await expect(rc.locator("#card")).toContainText("isn't connected", { timeout: 15_000 });
    await shoot(rc, "chat-remote", false);

    // Prompt window (the popup is 460x440).
    const pw = await open(`${EXT}/prompt.html?id=${encodeURIComponent(prompt.promptId)}`, 460, 440);
    await expect(pw.locator("#title")).not.toHaveText("Loading…");
    await shoot(pw, "prompt", false);
    for (const p of pages) await p.close().catch(() => {});
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await h.stop();
    await codex.close();
    claude.cleanup();
  }
});
