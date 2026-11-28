// #164: which linked agents are working in the browser (agentBrowser, badges) and the chat page's live view
// strip (state machine and HTML). Pure view logic.
import { describe, expect, it } from "vitest";
import { AgentBrowserSchema, BROWSER_BUSY_WINDOW_MS, type Agent, type AgentBrowser } from "@tabagent/protocol";
import { activityReducer, agentBrowser, browserBadgeHtml, enrichAgents, initialActivity, initialLive, liveReducer, liveStripHtml, liveWant, type ActivityState } from "../src/pure/liveView";
import { agentRowHtml, agentRowView } from "../src/pure/agents";
import { chatRailHtml } from "../src/pure/chat";

const NOW = 1_800_000_000_000;
const SID = "mcp:local:100-aaaaaa";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "claude:4242:1",
  vendor: "claude",
  name: "fix-tests",
  cwd: "/Users/me/code/tabagent",
  startedAt: NOW - 5 * 60_000,
  pid: 4242,
  status: "idle",
  linked: true,
  canDriveTab: true,
  delivery: "piggyback",
  tabagentSessionId: SID,
  ...over,
});

const sessions = [
  { id: SID, tabIds: [11, 12], active: 12 },
  { id: "mcp:local:other", tabIds: [99], active: 99 },
];
const tabs = { 11: { title: "Docs", url: "https://docs.example/" }, 12: { title: "Search results", url: "https://example.com/q" }, 99: { title: "Someone else", url: "https://x.example/" } };

const run = (s: ActivityState, sessionId: string, id: number, status: "running" | "ok" | "error" | "denied", ts: number) => activityReducer(s, { sessionId, id, status, ts });

describe("activityReducer", () => {
  it("counts running commands per session and records when the last one finished", () => {
    let s = run(initialActivity, SID, 1, "running", NOW);
    s = run(s, SID, 2, "running", NOW + 1);
    expect(s.running[SID]).toEqual([1, 2]);
    s = run(s, SID, 1, "ok", NOW + 50);
    expect(s.running[SID]).toEqual([2]);
    expect(s.last[SID]).toBe(NOW + 50);
    s = run(s, SID, 2, "error", NOW + 60);
    expect(s.running[SID]).toBeUndefined();
    expect(s.last[SID]).toBe(NOW + 60);
  });
  it("a command refused before it ran (only a final event) still counts as an action", () => {
    const s = run(initialActivity, SID, 7, "denied", NOW);
    expect(s.running[SID]).toBeUndefined();
    expect(s.last[SID]).toBe(NOW);
  });
  it("forget(sessionId) drops a session's activity", () => {
    const s = activityReducer(run(initialActivity, SID, 1, "running", NOW), { forget: SID });
    expect(s.running[SID]).toBeUndefined();
    expect(s.last[SID]).toBeUndefined();
  });
});

describe("agentBrowser", () => {
  it("not linked, or no TabAgent session id: absent", () => {
    expect(agentBrowser(agent({ linked: false, tabagentSessionId: undefined }), { sessions, tabs, activity: initialActivity }, NOW)).toBeUndefined();
    expect(agentBrowser(agent({ tabagentSessionId: undefined }), { sessions, tabs, activity: initialActivity }, NOW)).toBeUndefined();
    // A stale session id on an agent that is no longer linked never shows tabs.
    expect(agentBrowser(agent({ linked: false }), { sessions, tabs, activity: initialActivity }, NOW)).toBeUndefined();
  });
  it("linked: only its own session's tabs, with titles, active tab first-class", () => {
    const b = agentBrowser(agent(), { sessions, tabs, activity: initialActivity }, NOW)!;
    expect(b).toEqual({ tabs: [{ tabId: 11, title: "Docs", url: "https://docs.example/" }, { tabId: 12, title: "Search results", url: "https://example.com/q" }], activeTabId: 12, busy: false });
    expect(AgentBrowserSchema.safeParse(b).success).toBe(true);
    expect(JSON.stringify(b)).not.toContain("Someone else");
  });
  it("linked with no session yet: no tabs, not busy", () => {
    expect(agentBrowser(agent({ tabagentSessionId: "mcp:local:new" }), { sessions, tabs, activity: initialActivity }, NOW)).toEqual({ tabs: [], busy: false });
  });
  it("a tab with no title falls back to its url, then to Tab <id>", () => {
    const b = agentBrowser(agent(), { sessions: [{ id: SID, tabIds: [5, 6] }], tabs: { 5: { url: "https://a.example/" } }, activity: initialActivity }, NOW)!;
    expect(b.tabs.map((t) => t.title)).toEqual(["https://a.example/", "Tab 6"]);
    expect(b.activeTabId).toBeUndefined();
  });
  it("busy while a command is in flight, and for 10 s after the last one finished", () => {
    const ctx = (activity: ActivityState) => ({ sessions, tabs, activity });
    const inflight = run(initialActivity, SID, 1, "running", NOW);
    expect(agentBrowser(agent(), ctx(inflight), NOW + 60_000)!.busy).toBe(true);
    const done = run(inflight, SID, 1, "ok", NOW);
    expect(agentBrowser(agent(), ctx(done), NOW + BROWSER_BUSY_WINDOW_MS - 1)).toMatchObject({ busy: true, lastActionAt: NOW });
    expect(agentBrowser(agent(), ctx(done), NOW + BROWSER_BUSY_WINDOW_MS)).toMatchObject({ busy: false, lastActionAt: NOW });
    // Another session's activity never makes this agent busy.
    expect(agentBrowser(agent(), ctx(run(initialActivity, "mcp:local:other", 1, "running", NOW)), NOW)!.busy).toBe(false);
  });
  it("enrichAgents adds browser to linked agents only and leaves the rest untouched", () => {
    const list = [agent(), agent({ id: "claude:1:1", linked: false, tabagentSessionId: undefined, delivery: "none" })];
    const out = enrichAgents(list, { sessions, tabs, activity: initialActivity }, NOW);
    expect(out[0].browser?.tabs).toHaveLength(2);
    expect(out[1]).toEqual(list[1]);
    expect("browser" in out[1]).toBe(false);
  });
});

const busy = (over: Partial<AgentBrowser> = {}): AgentBrowser => ({ tabs: [{ tabId: 12, title: "Search <results>", url: "https://example.com/q" }], activeTabId: 12, busy: true, ...over });

describe("browserBadgeHtml", () => {
  it("busy: pulsing Working in browser with the active tab's title, escaped", () => {
    const html = browserBadgeHtml(busy());
    expect(html).toContain("Working in browser");
    expect(html).toContain("browser-badge busy");
    expect(html).toContain("pulse");
    expect(html).toContain("Search &lt;results&gt;");
    expect(html).not.toContain("<results>");
  });
  it("busy with several tabs names the active one", () => {
    const html = browserBadgeHtml(busy({ tabs: [{ tabId: 1, title: "First", url: "" }, { tabId: 12, title: "Active", url: "" }] }));
    expect(html).toContain("Active");
    expect(html).not.toContain("First");
  });
  it("idle with tabs: the tab count; no tabs or no browser: nothing", () => {
    expect(browserBadgeHtml(busy({ busy: false }))).toContain("1 tab");
    expect(browserBadgeHtml(busy({ busy: false }))).not.toContain("Working");
    const two = browserBadgeHtml(busy({ busy: false, tabs: [{ tabId: 1, title: "a", url: "" }, { tabId: 2, title: "b", url: "" }] }));
    expect(two).toContain("2 tabs");
    expect(browserBadgeHtml(busy({ busy: false, tabs: [] }))).toBe("");
    expect(browserBadgeHtml(undefined)).toBe("");
  });
  it("busy with no tabs yet still says Working in browser (no title)", () => {
    const html = browserBadgeHtml({ tabs: [], busy: true });
    expect(html).toContain("Working in browser");
  });
  it("the side panel row and the chat rail carry the badge", () => {
    const a = agent({ browser: busy() });
    expect(agentRowHtml(agentRowView(a, NOW), false)).toContain("Working in browser");
    expect(chatRailHtml([agentRowView(a, NOW)], a.id)).toContain("Working in browser");
    const idle = agent({ browser: busy({ busy: false }) });
    expect(agentRowHtml(agentRowView(idle, NOW), false)).toContain("1 tab");
    expect(agentRowHtml(agentRowView(agent(), NOW), false)).not.toContain("browser-badge");
  });
});

describe("live view strip", () => {
  const two: AgentBrowser = { tabs: [{ tabId: 11, title: "Docs", url: "" }, { tabId: 12, title: "Search", url: "" }], activeTabId: 12, busy: false };

  it("no tabs: hidden, nothing to watch", () => {
    const s = liveReducer(initialLive, { type: "agent", browser: undefined });
    expect(liveWant(s)).toBeNull();
    expect(liveStripHtml(s, undefined)).toBe("");
  });
  it("tabs appear: follows the active tab and starts", () => {
    const s = liveReducer(initialLive, { type: "agent", browser: two });
    expect(s).toMatchObject({ tabId: 12, state: "starting", open: true });
    expect(liveWant(s)).toEqual({ tabId: 12 });
  });
  it("starting -> live on the first frame; state text follows", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    expect(liveStripHtml(s, two)).toContain("Starting");
    s = liveReducer(s, { type: "frame", tabId: 12 });
    expect(s.state).toBe("live");
    expect(liveStripHtml(s, two)).toContain("Live");
    // A frame for a tab no longer picked is ignored.
    expect(liveReducer(s, { type: "frame", tabId: 11 })).toBe(s);
  });
  it("the background reports unavailable or ended for the picked tab", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "state", tabId: 12, state: "unavailable", reason: "This page can't be shown" });
    expect(s.state).toBe("unavailable");
    expect(liveStripHtml(s, two)).toContain("This page can&#39;t be shown");
    s = liveReducer(s, { type: "state", tabId: 11, state: "live" });
    expect(s.state).toBe("unavailable");
  });
  it("the picked tab closes: tab closed, then follows the next tab", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "frame", tabId: 12 });
    s = liveReducer(s, { type: "state", tabId: 12, state: "ended" });
    expect(liveStripHtml(s, two)).toContain("Tab closed");
    const one: AgentBrowser = { tabs: [two.tabs[0]], activeTabId: 11, busy: false };
    s = liveReducer(s, { type: "agent", browser: one });
    expect(s).toMatchObject({ tabId: 11, state: "starting" });
  });
  it("all tabs gone: tab closed, nothing to watch", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "frame", tabId: 12 });
    s = liveReducer(s, { type: "agent", browser: { tabs: [], busy: false } });
    expect(s.state).toBe("ended");
    expect(liveWant(s)).toBeNull();
    expect(liveStripHtml(s, { tabs: [], busy: false })).toBe("");
  });
  it("a pick sticks across refreshes while the tab exists; the picker lists every tab when there are several", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "pick", tabId: 11 });
    expect(s).toMatchObject({ tabId: 11, state: "starting", picked: true });
    s = liveReducer(s, { type: "agent", browser: two });
    expect(s.tabId).toBe(11);
    const html = liveStripHtml(s, two);
    expect(html).toContain("data-live-pick");
    expect(html).toContain("Docs");
    expect(html).toContain("Search");
    // One tab: no picker.
    expect(liveStripHtml(liveReducer(initialLive, { type: "agent", browser: { tabs: [two.tabs[0]], busy: false } }), { tabs: [two.tabs[0]], busy: false })).not.toContain("data-live-pick");
  });
  it("without a pick it follows the agent's active tab", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "agent", browser: { ...two, activeTabId: 11 } });
    expect(s.tabId).toBe(11);
  });
  it("picking a tab the agent does not own is ignored", () => {
    const s = liveReducer(liveReducer(initialLive, { type: "agent", browser: two }), { type: "pick", tabId: 99 });
    expect(s.tabId).toBe(12);
  });
  it("collapse stops watching; open again starts", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "toggle" });
    expect(s.open).toBe(false);
    expect(liveWant(s)).toBeNull();
    expect(liveStripHtml(s, two)).toContain('aria-expanded="false"');
    s = liveReducer(s, { type: "toggle" });
    expect(s).toMatchObject({ open: true, state: "starting" });
    expect(liveWant(s)).toEqual({ tabId: 12 });
  });
  it("expand toggles the larger view; the strip is read-only (an <img>, no inputs forwarded)", () => {
    let s = liveReducer(initialLive, { type: "agent", browser: two });
    s = liveReducer(s, { type: "expand" });
    expect(s.expanded).toBe(true);
    const html = liveStripHtml(s, two);
    expect(html).toContain("<img");
    expect(html).toContain("live-expanded");
    expect(html).not.toMatch(/<input|contenteditable/);
  });
});
