// Send to agent P1c (#90, spec §7): the side panel's Agents section, composer and send feed. Pure view logic.
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS, type Agent } from "@tabagent/protocol";
import {
  AGENT_FEED_MAX,
  agentFeedLineHtml,
  agentFeedReducer,
  agentRowHtml,
  agentRowView,
  buildAgentSend,
  agentListHtml,
  composerState,
  CONNECT_DOCS_URL,
  cwdBasename,
  groupAgents,
  formatAge,
  ROUTE_WORDS,
  sendTarget,
  shareableTab,
  sourcesNotes,
  type AgentFeedEntry,
} from "../src/pure/agents";

const NOW = 1_800_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "claude:4242:1",
  vendor: "claude",
  name: "fix-tests",
  cwd: "/Users/me/code/tabagent",
  startedAt: NOW - 5 * 60_000,
  pid: 4242,
  status: "idle",
  linked: false,
  canDriveTab: false,
  delivery: "none",
  ...over,
});

describe("cwdBasename and formatAge", () => {
  it.each([
    ["/Users/me/code/tabagent", "tabagent"],
    ["/Users/me/code/tabagent/", "tabagent"],
    ["C:\\work\\proj", "proj"],
    ["/", "/"],
    ["", ""],
  ])("basename(%j) = %j", (cwd, base) => expect(cwdBasename(cwd)).toBe(base));

  it.each([
    [-5_000, "0s"],
    [12_000, "12s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [3 * 3_600_000, "3h"],
    [2 * 86_400_000 + 5, "2d"],
  ])("formatAge(%d) = %j", (ms, s) => expect(formatAge(ms)).toBe(s));
});

describe("agent rows (§7)", () => {
  it("names the route in words for every route", () => {
    expect(ROUTE_WORDS).toEqual({
      channel: "instant",
      piggyback: "on its next browser action",
      queue: "queued (Codex)",
      spawn: "starts a new session",
      none: "cannot take messages",
    });
  });

  it("#137: an unlinked Claude row says it is not connected, links the connect docs, and offers a new session in its folder", () => {
    const v = agentRowView(agent(), NOW);
    expect(v).toMatchObject({ id: "claude:4242:1", vendorLabel: "Claude", title: "fix-tests", cwdBase: "tabagent", age: "5m", pid: 4242, status: "idle", sendable: false, notConnected: true, actionLabel: "Send", spawnLabel: "Start a new session in tabagent", badges: [] });
    expect(v.reason).toBe("Not connected — can't message this session");
    expect(v.routeWords).toBe("Not connected — can't message this session");
    const html = agentRowHtml(v, false);
    expect(html).toContain("Not connected — can&#39;t message this session");
    expect(html).toContain("Connect it: update TabAgent and restart this session");
    expect(html).toContain(`href="${CONNECT_DOCS_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("starts a new session");
  });

  it("#137: an older bridge that still lists unlinked Claude as spawn is treated the same (never a surprise spawn)", () => {
    expect(agentRowView(agent({ delivery: "spawn" }), NOW)).toMatchObject({ sendable: false, notConnected: true, spawnLabel: "Start a new session in tabagent" });
  });

  it("#137: the title is the primary label; cwd basename · age · pid is secondary", () => {
    const v = agentRowView(agent({ name: "nolanmakatche-22", title: "Pending user input check" }), NOW);
    expect(v).toMatchObject({ title: "Pending user input check", titled: true });
    const html = agentRowHtml(v, false);
    expect(html).toContain("<b>Pending user input check</b>");
    expect(html).toContain("tabagent · 5m · pid 4242");
    expect(html).not.toContain("nolanmakatche-22");
    // A title that is only the vendor's auto name is not a real title.
    expect(agentRowView(agent({ name: "nolanmakatche-22", title: "nolanmakatche-22" }), NOW)).toMatchObject({ title: "nolanmakatche-22", titled: false });
    expect(agentRowView(agent({ name: "x-1", title: undefined }), NOW)).toMatchObject({ title: "x-1", titled: false });
  });

  it("a linked Claude row is sendable (piggyback) and still offers a new session instead; no cwd means no spawn", () => {
    expect(agentRowView(agent({ linked: true, delivery: "piggyback" }), NOW)).toMatchObject({ sendable: true, notConnected: false, actionLabel: "Send", spawnLabel: "Start a new session in tabagent instead" });
    expect(agentRowView(agent({ cwd: "" }), NOW).spawnLabel).toBeUndefined();
  });

  it("a queue-route Codex row with no name falls back to cwd basename · age, and uses statusLabel", () => {
    const v = agentRowView(agent({ id: "codex:t1", vendor: "codex", name: null, cwd: "/work/cx", pid: undefined, status: "busy", statusLabel: "waitingOnApproval", delivery: "queue" }), NOW);
    expect(v).toMatchObject({ vendorLabel: "Codex", title: "cx · 5m", status: "waitingOnApproval", routeWords: "queued (Codex)", sendable: true, notConnected: false, actionLabel: "Send" });
    expect(v.pid).toBeUndefined();
    expect(v.spawnLabel).toBeUndefined();
  });

  it("an empty name also falls back", () => {
    expect(agentRowView(agent({ name: "  " }), NOW).title).toBe("tabagent · 5m");
  });

  it("a none-route row that is not an unlinked Claude session is not sendable and says why", () => {
    expect(agentRowView(agent({ vendor: "codex", status: "error", statusLabel: "systemError", delivery: "none" }), NOW)).toMatchObject({ sendable: false, notConnected: false, actionLabel: "Send", reason: "This agent cannot take messages (systemError)" });
    expect(agentRowView(agent({ vendor: "codex", status: "idle", delivery: "none" }), NOW).reason).toBe("No way to deliver to this agent");
  });

  it("shows linked and can-drive-tab badges when true", () => {
    expect(agentRowView(agent({ linked: true, canDriveTab: true, delivery: "piggyback" }), NOW)).toMatchObject({ badges: ["linked", "can drive tab"], actionLabel: "Send", routeWords: "on its next browser action" });
  });

  it("row HTML escapes every agent-supplied string and marks selection and disabled rows", () => {
    const evil = agent({ name: `<img src=x onerror=alert(1)>`, cwd: `/x/"><script>` , statusLabel: "<b>", id: `claude:"1` });
    const html = agentRowHtml(agentRowView(evil, NOW), true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('data-agent-id="claude:&quot;1"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("pid 4242");
    const none = agentRowHtml(agentRowView(agent({ vendor: "codex", delivery: "none" }), NOW), false);
    expect(none).toContain('aria-selected="false"');
    expect(none).toContain("agent-none");
    expect(none).toContain("No way to deliver to this agent");
    expect(agentRowHtml(agentRowView(agent({ linked: true, canDriveTab: true }), NOW), false)).toContain("can drive tab");
  });

  it("#137: sorts linked first, then most recent; collapses not-connected untitled sessions", () => {
    const rows = [
      agent({ id: "claude:1:1", name: "old-untitled", startedAt: NOW - 9_000 }),
      agent({ id: "claude:2:2", name: "n-2", title: "Titled but not connected", startedAt: NOW - 1_000 }),
      agent({ id: "claude:3:3", name: "linked-old", linked: true, delivery: "piggyback", startedAt: NOW - 99_000 }),
      agent({ id: "codex:t", vendor: "codex", name: null, delivery: "queue", startedAt: NOW - 500 }),
      agent({ id: "claude:4:4", name: "new-untitled", startedAt: NOW - 100 }),
    ].map((a) => agentRowView(a, NOW));
    const g = groupAgents(rows);
    expect(g.main.map((v) => v.id)).toEqual(["claude:3:3", "codex:t", "claude:2:2"]);
    expect(g.other.map((v) => v.id)).toEqual(["claude:4:4", "claude:1:1"]);
  });

  it("#137: list HTML puts collapsed sessions under an 'N other sessions' disclosure, open when asked or when one is selected", () => {
    const rows = [agent({ id: "claude:1:1", title: "Real work" }), agent({ id: "claude:2:2", name: "a-1" }), agent({ id: "claude:3:3", name: "b-2" })].map((a) => agentRowView(a, NOW));
    const closed = agentListHtml(rows, null, false);
    expect(closed).toContain("2 other sessions");
    expect(closed).toContain('data-agent-id="claude:2:2"');
    expect(closed).not.toMatch(/<details[^>]* open/);
    expect(agentListHtml(rows, null, true)).toMatch(/<details[^>]* open/);
    expect(agentListHtml(rows, "claude:3:3", false)).toMatch(/<details[^>]* open/);
    expect(agentListHtml(rows.slice(0, 2), null, false)).toContain("1 other session<");
    expect(agentListHtml(rows.slice(0, 1), null, false)).not.toContain("<details");
    expect(agentListHtml([], null, false)).toBe("");
  });

  it("sources notes name each unavailable source", () => {
    expect(sourcesNotes({ claude: "ok", codex: "ok" })).toEqual([]);
    expect(sourcesNotes({ claude: "ok", codex: "unavailable" })).toEqual(["Codex: not running"]);
    expect(sourcesNotes({ claude: "unavailable", codex: "unavailable" })).toEqual(["Claude Code: not available", "Codex: not running"]);
    expect(sourcesNotes(undefined)).toEqual([]);
  });
});

describe("composer (§7, AD13)", () => {
  const unlinked = agentRowView(agent(), NOW);
  const linked = agentRowView(agent({ linked: true, delivery: "piggyback" }), NOW);
  const queue = agentRowView(agent({ id: "codex:t", vendor: "codex", delivery: "queue" }), NOW);
  const none = agentRowView(agent({ id: "codex:t", vendor: "codex", status: "error", statusLabel: "systemError", delivery: "none" }), NOW);
  const off = { spawnLabel: null, canSpawn: false };

  it("needs an agent and a prompt", () => {
    expect(composerState({ agent: null, prompt: "hi", share: null })).toEqual({ canSend: false, label: "Send", note: "Select an agent above.", ...off });
    expect(composerState({ agent: queue, prompt: "   ", share: null })).toEqual({ canSend: false, label: "Send", note: "", ...off });
  });

  it("Codex and linked targets: Send as before", () => {
    expect(composerState({ agent: queue, prompt: "go", share: null })).toEqual({ canSend: true, label: "Send", note: "", ...off });
    expect(composerState({ agent: linked, prompt: "go", share: null })).toEqual({ canSend: true, label: "Send", note: "", spawnLabel: "Start a new session in tabagent instead", canSpawn: true });
  });

  it("#137: unlinked Claude: Send is disabled; the separate Start a new session button is the only way to spawn", () => {
    expect(composerState({ agent: unlinked, prompt: "go", share: null })).toEqual({
      canSend: false,
      label: "Send",
      note: "This session is not connected to TabAgent, so it can't get messages. You can start a new session in tabagent instead.",
      spawnLabel: "Start a new session in tabagent",
      canSpawn: true,
    });
    expect(composerState({ agent: unlinked, prompt: "  ", share: null })).toMatchObject({ canSend: false, canSpawn: false });
  });

  it("disables none targets with the reason", () => {
    expect(composerState({ agent: none, prompt: "go", share: null })).toEqual({ canSend: false, label: "Send", note: "This agent cannot take messages (systemError)", ...off });
  });

  it("blocks an over-limit prompt and shows the limit, without truncating (both buttons)", () => {
    const prompt = "x".repeat(AGENT_LIMITS.prompt + 1);
    expect(composerState({ agent: queue, prompt, share: null })).toEqual({ canSend: false, label: "Send", note: "The message is 8,001 characters; the limit is 8,000.", ...off });
    expect(composerState({ agent: queue, prompt: "x".repeat(AGENT_LIMITS.prompt), share: null }).canSend).toBe(true);
    expect(composerState({ agent: unlinked, prompt, share: null })).toMatchObject({ canSend: false, canSpawn: false, note: "The message is 8,001 characters; the limit is 8,000." });
  });

  it("blocks an over-limit shared title or URL and says to untick sharing", () => {
    const title = "t".repeat(AGENT_LIMITS.title + 1);
    expect(composerState({ agent: queue, prompt: "go", share: { tabId: 1, title, url: "https://a.test/" } })).toEqual({ canSend: false, label: "Send", note: "The tab title is 501 characters; the limit is 500. Untick Share this tab to send without it.", ...off });
    const url = "https://a.test/" + "u".repeat(AGENT_LIMITS.url);
    expect(composerState({ agent: queue, prompt: "go", share: { tabId: 1, title: "ok", url } }).note).toContain("The tab URL is");
  });
});

describe("shareable tab and the send message", () => {
  it("shares only http(s) tabs", () => {
    expect(shareableTab({ id: 7, title: "Docs", url: "https://a.test/x" })).toEqual({ tabId: 7, title: "Docs", url: "https://a.test/x" });
    expect(shareableTab({ id: 7, url: "http://a.test/" })).toEqual({ tabId: 7, title: "", url: "http://a.test/" });
    expect(shareableTab({ id: 7, title: "Ext", url: "chrome-extension://abc/sidepanel.html" })).toBeNull();
    expect(shareableTab({ id: 7, title: "x", url: "chrome://settings" })).toBeNull();
    expect(shareableTab({ title: "x", url: "https://a.test/" })).toBeNull();
    expect(shareableTab(undefined)).toBeNull();
  });

  it("builds ui.agent_send with the tab fields only when a tab is shared", () => {
    expect(buildAgentSend({ requestId: "r1", agentId: "codex:t", prompt: "hi", share: { tabId: 3, title: "T", url: "https://a.test/" } })).toEqual({ type: "ui.agent_send", requestId: "r1", agentId: "codex:t", prompt: "hi", includeTab: true, tabId: 3, title: "T", url: "https://a.test/" });
    expect(buildAgentSend({ requestId: "r2", agentId: "codex:t", prompt: "hi", share: null })).toEqual({ type: "ui.agent_send", requestId: "r2", agentId: "codex:t", prompt: "hi", includeTab: false });
  });

  it("#137: a new session's feed line names its folder and the spawn route; a plain send names the agent", () => {
    const v = agentRowView(agent({ title: "Pending user input check" }), NOW);
    expect(sendTarget(v, true)).toEqual({ agentName: "New session in tabagent", route: "spawn" });
    expect(sendTarget(v, false)).toEqual({ agentName: "Pending user input check", route: "none" });
  });

  it("#137: forceSpawn is sent only for the explicit Start a new session button", () => {
    expect(buildAgentSend({ requestId: "r3", agentId: "claude:1:1", prompt: "hi", share: null, forceSpawn: true })).toEqual({ type: "ui.agent_send", requestId: "r3", agentId: "claude:1:1", prompt: "hi", includeTab: false, forceSpawn: true });
    expect(buildAgentSend({ requestId: "r4", agentId: "claude:1:1", prompt: "hi", share: null, forceSpawn: false })).not.toHaveProperty("forceSpawn");
    expect(buildAgentSend({ requestId: "r5", agentId: "claude:1:1", prompt: "hi", share: null })).not.toHaveProperty("forceSpawn");
  });
});

describe("agent send feed reducer (AD7)", () => {
  const sending = (requestId: string, ts = 1) => ({ type: "sending" as const, requestId, ts, agentName: "Codex helper", vendor: "codex" as const, route: "queue" as const });

  it("adds a sending line, then applies agent.sent, then agent.status by requestId", () => {
    let f: AgentFeedEntry[] = agentFeedReducer([], sending("r1"));
    expect(f).toEqual([{ requestId: "r1", ts: 1, agentName: "Codex helper", vendor: "codex", route: "queue", state: "sending" }]);
    f = agentFeedReducer(f, { type: "sent", msg: { requestId: "r1", route: "queue", state: "queued" } });
    expect(f[0]).toMatchObject({ state: "queued", route: "queue" });
    f = agentFeedReducer(f, { type: "status", msg: { requestId: "r1", state: "delivered" } });
    expect(f[0]).toMatchObject({ state: "delivered" });
  });

  it("records the failure code and detail, and the route actually used", () => {
    let f = agentFeedReducer([], sending("r1"));
    f = agentFeedReducer(f, { type: "sent", msg: { requestId: "r1", route: "spawn", state: "failed", code: "WORKSPACE_UNTRUSTED", detail: "Workspace not trusted." } });
    expect(f[0]).toMatchObject({ route: "spawn", state: "failed", code: "WORKSPACE_UNTRUSTED", detail: "Workspace not trusted." });
  });

  it("ignores replies and events for requestIds it never sent (another panel's sends)", () => {
    const f = agentFeedReducer([], sending("r1"));
    expect(agentFeedReducer(f, { type: "status", msg: { requestId: "other", state: "delivered" } })).toBe(f);
    expect(agentFeedReducer(f, { type: "sent", msg: { requestId: "other", route: "queue", state: "queued" } })).toBe(f);
  });

  it("a late immediate reply never overwrites a later state that arrived first", () => {
    let f = agentFeedReducer([], sending("r1"));
    f = agentFeedReducer(f, { type: "status", msg: { requestId: "r1", state: "delivered" } });
    f = agentFeedReducer(f, { type: "sent", msg: { requestId: "r1", route: "queue", state: "queued" } });
    expect(f[0]).toMatchObject({ state: "delivered", route: "queue" });
  });

  it("keeps the existing detail when a status carries none, and replaces it when it does", () => {
    let f = agentFeedReducer([], sending("r1"));
    f = agentFeedReducer(f, { type: "sent", msg: { requestId: "r1", route: "spawn", state: "started", detail: "Attach with: claude attach ab12" } });
    f = agentFeedReducer(f, { type: "status", msg: { requestId: "r1", state: "expired" } });
    expect(f[0].detail).toBe("Attach with: claude attach ab12");
    f = agentFeedReducer(f, { type: "status", msg: { requestId: "r1", state: "expired", detail: "TTL" } });
    expect(f[0].detail).toBe("TTL");
  });

  it("does not add a duplicate sending line and caps the feed", () => {
    let f: AgentFeedEntry[] = [];
    for (let i = 0; i < AGENT_FEED_MAX + 3; i++) f = agentFeedReducer(f, sending(`r${i}`, i));
    expect(f).toHaveLength(AGENT_FEED_MAX);
    expect(f[0].requestId).toBe("r3");
    expect(agentFeedReducer(f, sending("r10"))).toBe(f);
  });

  it("feed line HTML escapes and shows agent, route, state, code and detail", () => {
    const html = agentFeedLineHtml({ requestId: `r"1`, ts: 0, agentName: "<i>x</i>", vendor: "claude", route: "spawn", state: "failed", code: "WORKSPACE_UNTRUSTED", detail: "Run `claude` in <dir>" });
    expect(html).toContain('data-request-id="r&quot;1"');
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).toContain("starts a new session");
    expect(html).toContain("failed");
    expect(html).toContain("WORKSPACE_UNTRUSTED");
    expect(html).toContain("Run `claude` in &lt;dir&gt;");
    expect(html).not.toContain("<i>");
    expect(agentFeedLineHtml({ requestId: "r", ts: 0, agentName: "a", vendor: "codex", route: "queue", state: "sending" })).toContain("sending");
    expect(agentFeedLineHtml({ requestId: "r", ts: 0, agentName: "a", vendor: "claude", route: "spawn", state: "started", detail: "Attach with: claude attach ab12" })).toContain("Attach with: claude attach ab12");
  });
});
