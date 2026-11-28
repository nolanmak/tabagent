// Send to agent P2c (#92, spec AD14, §7): the context menu, the pending intent the menu hands the panel,
// the recent-agents list and the composer's selection. Pure logic.
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS, type Agent } from "@tabagent/protocol";
import { agentRowView, buildAgentSend, composerState } from "../src/pure/agents";
import {
  INTENT_MAX_AGE_MS,
  intentFromClick,
  intentOutcome,
  MENU_CHOOSE_ID,
  MENU_ROOT_ID,
  menuAgentId,
  menuItems,
  parseIntent,
  RECENT_AGENTS_MAX,
  reconcileSelection,
  sanitizeRecent,
  selectionPreview,
  selectionView,
  updateRecent,
} from "../src/pure/sendIntent";

const NOW = 1_800_000_000_000;

describe("menu ids", () => {
  it("maps an agent item to its id, Choose… to null, and anything else to undefined", () => {
    const items = menuItems([{ id: "codex:t1", name: "Codex helper" }], null);
    const agentItem = items.find((i) => i.title === "Codex helper")!;
    expect(menuAgentId(agentItem.id)).toBe("codex:t1");
    expect(menuAgentId(MENU_CHOOSE_ID)).toBeNull();
    expect(menuAgentId(MENU_ROOT_ID)).toBeUndefined();
    expect(menuAgentId("something-else")).toBeUndefined();
    expect(menuAgentId(42)).toBeUndefined();
  });

  it("keeps agent ids with colons intact", () => {
    const [, item] = menuItems([{ id: "claude:4242:1795639119768", name: "x" }], null);
    expect(menuAgentId(item.id)).toBe("claude:4242:1795639119768");
  });
});

describe("menuItems", () => {
  it("builds the root on page and selection, then recent agents, a separator and Choose…", () => {
    const items = menuItems([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], null);
    expect(items[0]).toEqual({ id: MENU_ROOT_ID, title: "Send to agent", contexts: ["page", "selection"] });
    expect(items.slice(1).map((i) => [i.parentId, i.type ?? "normal", i.title])).toEqual([
      [MENU_ROOT_ID, "normal", "Alpha"],
      [MENU_ROOT_ID, "normal", "Beta"],
      [MENU_ROOT_ID, "separator", ""],
      [MENU_ROOT_ID, "normal", "Choose…"],
    ]);
    expect(items[items.length - 1].id).toBe(MENU_CHOOSE_ID);
    for (const i of items) expect(i.contexts).toEqual(["page", "selection"]);
  });

  it("with no recent agents shows only Choose…", () => {
    const items = menuItems([], null);
    expect(items.map((i) => i.title)).toEqual(["Send to agent", "Choose…"]);
  });

  it("re-validates against the current list: drops agents that are gone and uses the current name", () => {
    const items = menuItems(
      [
        { id: "a", name: "Old name" },
        { id: "gone", name: "Gone" },
      ],
      [{ id: "a", title: "New name" }, { id: "other", title: "Other" }],
    );
    expect(items.map((i) => i.title)).toEqual(["Send to agent", "New name", "", "Choose…"]);
  });

  it("caps at 5 agents, shortens long names and defuses %s (Chrome replaces it with the selection)", () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, name: `n${i}` }));
    expect(menuItems(recent, null).filter((i) => menuAgentId(i.id))).toHaveLength(RECENT_AGENTS_MAX);
    const [, long] = menuItems([{ id: "x", name: "y".repeat(200) }], null);
    expect(long.title.length).toBeLessThanOrEqual(60);
    expect(long.title.endsWith("…")).toBe(true);
    const [, pct] = menuItems([{ id: "x", name: "100%sure" }], null);
    expect(pct.title).not.toContain("%s");
    const [, blank] = menuItems([{ id: "x", name: "   " }], null);
    expect(blank.title).toBe("x");
  });
});

describe("intentFromClick (the menu never sends; it only records an intent)", () => {
  const tab = { id: 7, windowId: 3 };
  it("records the agent, tab, selection and time", () => {
    const [, item] = menuItems([{ id: "codex:t1", name: "C" }], null);
    expect(intentFromClick({ menuItemId: item.id, selectionText: "hello" }, tab, NOW)).toEqual({ agentId: "codex:t1", tabId: 7, selection: "hello", at: NOW });
  });

  it("Choose… records no agent; no selection is null", () => {
    expect(intentFromClick({ menuItemId: MENU_CHOOSE_ID }, tab, NOW)).toEqual({ agentId: null, tabId: 7, selection: null, at: NOW });
    expect(intentFromClick({ menuItemId: MENU_CHOOSE_ID, selectionText: "" }, tab, NOW)!.selection).toBeNull();
  });

  it("ignores other menu items and clicks without a tab", () => {
    expect(intentFromClick({ menuItemId: "nope" }, tab, NOW)).toBeNull();
    expect(intentFromClick({ menuItemId: MENU_CHOOSE_ID }, undefined, NOW)).toBeNull();
    expect(intentFromClick({ menuItemId: MENU_CHOOSE_ID }, { id: -1 }, NOW)).toBeNull();
    expect(intentFromClick({ menuItemId: MENU_CHOOSE_ID }, {}, NOW)).toBeNull();
  });
});

describe("parseIntent", () => {
  const ok = { agentId: "a", tabId: 7, selection: "s", at: NOW };
  it("accepts a fresh intent", () => {
    expect(parseIntent(ok, NOW + 1000)).toEqual(ok);
    expect(parseIntent({ ...ok, agentId: null, selection: null }, NOW)).toEqual({ ...ok, agentId: null, selection: null });
  });

  it("ignores intents older than 2 minutes, or from the future", () => {
    expect(INTENT_MAX_AGE_MS).toBe(120_000);
    expect(parseIntent(ok, NOW + INTENT_MAX_AGE_MS)).toEqual(ok);
    expect(parseIntent(ok, NOW + INTENT_MAX_AGE_MS + 1)).toBeNull();
    expect(parseIntent(ok, NOW - 60_000)).toBeNull();
  });

  it.each([
    [null],
    ["x"],
    [{ ...ok, agentId: 5 }],
    [{ ...ok, agentId: "" }],
    [{ ...ok, tabId: "7" }],
    [{ ...ok, tabId: 1.5 }],
    [{ ...ok, selection: 3 }],
    [{ ...ok, at: "now" }],
    [{ agentId: "a", selection: null, at: NOW }],
  ])("rejects malformed %j", (raw) => {
    expect(parseIntent(raw, NOW)).toBeNull();
  });

  it("treats an empty selection as none", () => {
    expect(parseIntent({ ...ok, selection: "" }, NOW)!.selection).toBeNull();
  });
});

describe("intentOutcome (the panel preselects only a listed agent)", () => {
  const intent = { agentId: "a", tabId: 7, selection: "picked text", at: NOW };
  it("preselects a listed agent and keeps the selection for its tab", () => {
    expect(intentOutcome(intent, ["a", "b"])).toEqual({ select: "a", notice: "", selection: { tabId: 7, text: "picked text" } });
  });

  it("an unknown agent selects nothing and shows a notice", () => {
    expect(intentOutcome(intent, ["b"])).toEqual({ select: null, notice: "That agent is no longer running.", selection: { tabId: 7, text: "picked text" } });
  });

  it("Choose… leaves the current choice alone", () => {
    expect(intentOutcome({ ...intent, agentId: null, selection: null }, ["a"])).toEqual({ select: undefined, notice: "", selection: null });
  });
});

describe("reconcileSelection (a tab switch drops the selection)", () => {
  const sel = { tabId: 7, text: "t" };
  it("keeps the selection while its tab is active, or while the active tab is unknown", () => {
    expect(reconcileSelection(sel, 7)).toEqual({ selection: sel, dropped: false });
    expect(reconcileSelection(sel, undefined)).toEqual({ selection: sel, dropped: false });
  });
  it("drops it when another tab, or no tab, is active", () => {
    expect(reconcileSelection(sel, 8)).toEqual({ selection: null, dropped: true });
    expect(reconcileSelection(sel, null)).toEqual({ selection: null, dropped: true });
  });
  it("nothing to drop without a selection", () => {
    expect(reconcileSelection(null, 8)).toEqual({ selection: null, dropped: false });
  });
});

describe("selection preview and checkbox", () => {
  it("collapses whitespace and truncates the preview for display only", () => {
    expect(selectionPreview("  a\n\n b\tc ")).toBe("a b c");
    const p = selectionPreview("w".repeat(500));
    expect(p.length).toBeLessThanOrEqual(80);
    expect(p.endsWith("…")).toBe(true);
  });

  it("enabled with a selection while the tab is shared; disabled otherwise with the reason", () => {
    expect(selectionView({ selection: { tabId: 7, text: "hello world" }, dropped: false, shareOn: true })).toEqual({ enabled: true, text: "“hello world”" });
    expect(selectionView({ selection: { tabId: 7, text: "hello" }, dropped: false, shareOn: false })).toEqual({ enabled: false, text: "(sent only with the tab)" });
    expect(selectionView({ selection: null, dropped: true, shareOn: true })).toEqual({ enabled: false, text: "(dropped: you switched tabs)" });
    expect(selectionView({ selection: null, dropped: false, shareOn: true })).toEqual({ enabled: false, text: "(select text on the page, then right-click Send to agent)" });
  });
});

describe("recent agents list", () => {
  it("puts the latest first, dedupes, and caps at 5", () => {
    let r = updateRecent([], { id: "a", name: "A" });
    r = updateRecent(r, { id: "b", name: "B" });
    r = updateRecent(r, { id: "a", name: "A2" });
    expect(r).toEqual([
      { id: "a", name: "A2" },
      { id: "b", name: "B" },
    ]);
    for (let i = 0; i < 10; i++) r = updateRecent(r, { id: `x${i}`, name: `X${i}` });
    expect(r).toHaveLength(RECENT_AGENTS_MAX);
    expect(r[0].id).toBe("x9");
  });

  it("sanitizes whatever is in storage", () => {
    expect(sanitizeRecent(undefined)).toEqual([]);
    expect(sanitizeRecent("x")).toEqual([]);
    expect(sanitizeRecent([{ id: "a", name: "A" }, { id: 3 }, null, { id: "", name: "x" }, { id: "b" }, { id: "a", name: "dup" }])).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "b" },
    ]);
    expect(sanitizeRecent(Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, name: "n" })))).toHaveLength(RECENT_AGENTS_MAX);
  });
});

describe("composer with a selection (AD12, AD13)", () => {
  const a: Agent = { id: "codex:t", vendor: "codex", name: "C", cwd: "/x", startedAt: NOW, status: "idle", linked: false, canDriveTab: false, delivery: "queue" };
  const v = agentRowView(a, NOW);
  const share = { tabId: 3, title: "T", url: "https://a.test/" };

  it("sends the selection untruncated with the tab", () => {
    const selection = "s".repeat(AGENT_LIMITS.selection);
    expect(buildAgentSend({ requestId: "r", agentId: "codex:t", prompt: "hi", share, selection })).toEqual({ type: "ui.agent_send", requestId: "r", agentId: "codex:t", prompt: "hi", includeTab: true, tabId: 3, title: "T", url: "https://a.test/", selection });
  });

  it("never sends a selection without the tab, or an empty one", () => {
    expect(buildAgentSend({ requestId: "r", agentId: "codex:t", prompt: "hi", share: null, selection: "x" })).toEqual({ type: "ui.agent_send", requestId: "r", agentId: "codex:t", prompt: "hi", includeTab: false });
    expect(buildAgentSend({ requestId: "r", agentId: "codex:t", prompt: "hi", share, selection: null })).not.toHaveProperty("selection");
  });

  it("blocks an over-limit selection and says to untick it", () => {
    const selection = "s".repeat(AGENT_LIMITS.selection + 1);
    expect(composerState({ agent: v, prompt: "go", share, selection })).toEqual({ canSend: false, label: "Send", note: "The selection is 16,001 characters; the limit is 16,000. Untick Include selection to send without it." });
    expect(composerState({ agent: v, prompt: "go", share, selection: "s".repeat(AGENT_LIMITS.selection) }).canSend).toBe(true);
  });
});
