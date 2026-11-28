// #156 design refresh: collapsible panel sections, tool icons, the chat page's session rail and the agent row.
import { describe, expect, it } from "vitest";
import type { Agent } from "@tabagent/protocol";
import { agentRowHtml, agentRowView, vendorShown } from "../src/pure/agents";
import { chatItemHtml, chatRailHtml } from "../src/pure/chat";
import { icon, toolIcon } from "../src/pure/icons";
import { nextOpen, sectionSummaries } from "../src/pure/panelSections";

const NOW = 1_800_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "claude:1:1", vendor: "claude", name: "n", title: "Fix the tests", cwd: "/Users/me/code/app", startedAt: NOW - 60_000, pid: 1, status: "idle", linked: true, canDriveTab: true, delivery: "channel", ...over });

describe("panel sections", () => {
  const facts = { sessions: [], feed: [], workflows: [], capturing: false };

  it("empty sections have no count, no summary and need no attention", () => {
    const s = sectionSummaries(facts);
    for (const id of ["sessions", "activity", "workflows"] as const) expect(s[id]).toEqual({ count: "", meta: "", attention: false });
  });

  it("live sessions, drafts to review and a recording capture need attention; activity never does", () => {
    const s = sectionSummaries({
      sessions: [{ tabs: 2 }, { tabs: 1 }],
      feed: [{ status: "ok" }, { status: "error" }, { status: "denied" }],
      workflows: [{ status: "draft" }, { status: "reviewed" }],
      capturing: false,
    });
    expect(s.sessions).toEqual({ count: "2", meta: "3 tabs", attention: true });
    expect(s.activity).toEqual({ count: "3", meta: "2 failed", attention: false });
    expect(s.workflows).toEqual({ count: "2", meta: "1 to review", attention: true });
    expect(sectionSummaries({ ...facts, sessions: [{ tabs: 1 }] }).sessions.meta).toBe("1 tab");
    expect(sectionSummaries({ ...facts, feed: [{ status: "running" }, { status: "error" }] }).activity.meta).toBe("1 running");
    expect(sectionSummaries({ ...facts, capturing: true }).workflows).toMatchObject({ meta: "Recording", attention: true });
  });

  it("open state: the user's choice wins; otherwise attention opens and nothing closes on its own", () => {
    expect(nextOpen(false, true, false)).toBe(true);
    expect(nextOpen(true, false, false)).toBe(true);
    expect(nextOpen(false, false, false)).toBe(false);
    expect(nextOpen(false, true, true)).toBe(false);
    expect(nextOpen(true, false, true)).toBe(true);
  });
});

describe("icons", () => {
  it("maps tool names to icons", () => {
    expect(toolIcon("Bash")).toBe("terminal");
    expect(toolIcon("exec_command")).toBe("terminal");
    expect(toolIcon("Edit")).toBe("pencil");
    expect(toolIcon("MultiEdit")).toBe("pencil");
    expect(toolIcon("Grep")).toBe("search");
    expect(toolIcon("ls")).toBe("search");
    expect(toolIcon("WebFetch")).toBe("globe");
    expect(toolIcon("mcp__tabagent__page_snapshot")).toBe("globe");
    expect(toolIcon("Read")).toBe("file");
    expect(toolIcon("TodoWrite")).toBe("pencil");
    expect(toolIcon("ExitPlanMode")).toBe("list");
    expect(toolIcon("Task")).toBe("spark");
    expect(toolIcon("Interrupted")).toBe("stop");
    expect(toolIcon("Result")).toBe("reply");
    expect(toolIcon("Mystery")).toBe("wrench");
  });

  it("renders decorative inline SVG", () => {
    const svg = icon("chevron");
    expect(svg).toMatch(/^<svg class="icon" viewBox="0 0 16 16"/);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('stroke="currentColor"');
  });
});

describe("tool rows", () => {
  it("show the tool's icon, its name and the first argument line, escaped", () => {
    const html = chatItemHtml({ kind: "tool", key: "t", name: "Bash", summary: "npm <b>test</b>\n--watch", ts: 0 });
    expect(html).toContain('<span class="tool-name">Bash:</span> <span class="tool-arg">npm &lt;b&gt;test&lt;/b&gt;</span>');
    expect(html).toContain('title="Bash: npm &lt;b&gt;test&lt;/b&gt;"');
    expect(html).toContain("<svg");
    expect(chatItemHtml({ kind: "tool", key: "t", name: "Interrupted", summary: "", ts: 0 })).toContain('<span class="tool-name">Interrupted</span></span>');
  });
});

describe("chat rail", () => {
  it("lists every session, linked first, with the current one marked and escaped links", () => {
    const views = [
      agentRowView(agent({ id: "claude:2:2", title: "<b>Other</b>", linked: false, delivery: "none", startedAt: NOW - 120_000 }), NOW),
      agentRowView(agent({ status: "busy" }), NOW),
      agentRowView(agent({ id: "codex:t", vendor: "codex", title: "Codex job", linked: false, delivery: "queue" }), NOW),
    ];
    const html = chatRailHtml(views, "claude:2:2");
    expect(html.indexOf("Fix the tests")).toBeLessThan(html.indexOf("Other"));
    expect(html).toContain('href="chat.html?agent=claude%3A2%3A2" data-rail-agent="claude:2:2" aria-current="page"');
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toContain("&lt;b&gt;Other&lt;/b&gt;");
    expect(html).not.toContain("<b>Other");
    expect(html).toContain("busy-dot");
    expect(html).toContain("Claude · Connected · instant · 1m");
    expect(html).toContain("Codex · queued · 1m");
    expect(html).not.toContain("Codex · Codex");
    expect(chatRailHtml([], "x")).toContain("No sessions running.");
  });
});

describe("agent row (#156)", () => {
  it("one status dot, the vendor once, no 'linked' word, hover actions and a connect hint only without Remote Control", () => {
    const linked = agentRowHtml(agentRowView(agent(), NOW), false);
    expect(linked).toContain('class="status-dot tone-instant"');
    expect(linked).toContain('<span class="vendor-name">Claude</span>');
    expect(linked).not.toContain("badge-word\">linked");
    expect(linked).toContain("can drive tab");
    const codex = agentRowView(agent({ vendor: "codex", delivery: "queue", linked: false }), NOW);
    expect(vendorShown(codex)).toBe(false);
    expect(agentRowHtml(codex, false)).not.toContain("vendor-name");
    const rc = agentRowHtml(agentRowView(agent({ linked: false, delivery: "none", remoteControlUrl: "https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv" }), NOW), false);
    expect(rc).toContain("rc-link");
    expect(rc).not.toContain("How to connect");
    expect(rc).toContain("tone-remote");
  });
});
