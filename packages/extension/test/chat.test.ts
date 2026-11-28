// #151 chat page: reducer (history, live entries, pending -> confirmed), items, HTML, header, composer mode,
// safe Markdown and chat-tab reuse. Pure view logic.
import { describe, expect, it } from "vitest";
import type { Agent, AgentEntry } from "@tabagent/protocol";
import { atBottom, CHAT_MAX_ENTRIES, findSpawnedAgent, isHomeFolder, spawnFailureText, chatHeaderView, chatItemHtml, chatItems, chatReducer, composerMode, historyErrorText, initialChat, notConnectedCardHtml, pendingHtml, recentWebTabs, toolLine, type ChatState } from "../src/pure/chat";
import { chatAgentOf, findChatTab } from "../src/pure/chatTabs";
import { renderMarkdown } from "../src/pure/markdown";

const RC = "https://claude.ai/code/session_01AbCdEfGhIjKl";
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "claude:1:1", vendor: "claude", name: "n", title: "Fix the tests", cwd: "/Users/me/code/app", startedAt: Date.now() - 60_000, pid: 1, status: "idle", linked: true, canDriveTab: true, delivery: "channel", ...over });
const user = (uuid: string, text: string, fromTabAgent?: boolean): AgentEntry => ({ uuid, ts: 1, role: "user", text, ...(fromTabAgent ? { fromTabAgent } : {}) });
const asst = (uuid: string, text: string): AgentEntry => ({ uuid, ts: 2, role: "assistant", text });

describe("chatReducer", () => {
  it("loads the newest page, prepends older pages and appends live entries without duplicates", () => {
    let s = initialChat();
    expect(s.loading).toBe(true);
    s = chatReducer(s, { type: "history", entries: [user("u2", "b"), asst("a2", "c")], hasMore: true, before: "100" });
    expect(s).toMatchObject({ loading: false, hasMore: true, before: "100" });
    s = chatReducer(s, { type: "loadingOlder" });
    s = chatReducer(s, { type: "history", entries: [user("u1", "a"), user("u2", "b")], hasMore: false, older: true });
    expect(s.entries.map((e) => e.uuid)).toEqual(["u1", "u2", "a2"]);
    expect(s).toMatchObject({ hasMore: false, loadingOlder: false });
    s = chatReducer(s, { type: "entries", entries: [asst("a2", "c"), asst("a3", "d")] });
    expect(s.entries.map((e) => e.uuid)).toEqual(["u1", "u2", "a2", "a3"]);
    // Live entries that are all known change nothing.
    expect(chatReducer(s, { type: "entries", entries: [asst("a3", "d")] })).toBe(s);
  });

  it("a history error shows on first load; an older-page error only stops the spinner", () => {
    let s = chatReducer(initialChat(), { type: "historyError", code: "NO_TRANSCRIPT", detail: "none" });
    expect(s).toMatchObject({ loading: false, error: { code: "NO_TRANSCRIPT", detail: "none" } });
    s = chatReducer(s, { type: "loading" });
    expect(s.error).toBeUndefined();
    s = chatReducer({ ...s, loadingOlder: true }, { type: "historyError", detail: "x", older: true });
    expect(s).toMatchObject({ loadingOlder: false, error: undefined });
  });

  it("pending -> sent -> confirmed when the transcript shows the message (whitespace-insensitive)", () => {
    let s: ChatState = chatReducer(initialChat(), { type: "history", entries: [], hasMore: false });
    s = chatReducer(s, { type: "sending", requestId: "r1", text: "Run  the\ntests", ts: 5 });
    s = chatReducer(s, { type: "sending", requestId: "r1", text: "dup", ts: 5 });
    expect(s.pending).toEqual([{ requestId: "r1", text: "Run  the\ntests", ts: 5, state: "sending" }]);
    s = chatReducer(s, { type: "sent", msg: { requestId: "r1", route: "channel", state: "sent" } });
    expect(s.pending[0]).toMatchObject({ state: "sent", route: "channel" });
    // Not from TabAgent, or different text: still pending.
    s = chatReducer(s, { type: "entries", entries: [user("x1", "Run the tests"), user("x2", "other", true)] });
    expect(s.pending).toHaveLength(1);
    s = chatReducer(s, { type: "entries", entries: [user("x3", "Run the tests", true), asst("x4", "ok")] });
    expect(s.pending).toEqual([]);
    expect(s.entries.map((e) => e.uuid)).toEqual(["x1", "x2", "x3", "x4"]);
  });

  it("a reload (history after reset) also confirms; a failed send stays until dismissed; a late reply never undoes a later state", () => {
    let s = chatReducer(initialChat(), { type: "sending", requestId: "r1", text: "hi", ts: 1 });
    s = chatReducer(s, { type: "sending", requestId: "r2", text: "nope", ts: 1 });
    s = chatReducer(s, { type: "sent", msg: { requestId: "r2", route: "piggyback", state: "failed", code: "NO_ROUTE", detail: "gone" } });
    s = chatReducer(s, { type: "history", entries: [user("u", "hi", true), user("u2", "nope", true)], hasMore: false });
    expect(s.pending.map((p) => [p.requestId, p.state, p.code])).toEqual([["r2", "failed", "NO_ROUTE"]]);
    s = chatReducer(s, { type: "dismiss", requestId: "r2" });
    expect(s.pending).toEqual([]);
    let t = chatReducer(initialChat(), { type: "sending", requestId: "r3", text: "x", ts: 1 });
    t = chatReducer(t, { type: "status", msg: { requestId: "r3", state: "delivered" } });
    t = chatReducer(t, { type: "sent", msg: { requestId: "r3", route: "piggyback", state: "held", detail: "tab not shared: TAB_BUSY" } });
    expect(t.pending[0]).toMatchObject({ state: "delivered", route: "piggyback", detail: "tab not shared: TAB_BUSY" });
    expect(chatReducer(t, { type: "status", msg: { requestId: "zzz", state: "expired" } })).toBe(t);
  });

  it("a new-session send is never confirmed by this transcript", () => {
    let s = chatReducer(initialChat(), { type: "sending", requestId: "r", text: "go", ts: 1, spawn: true });
    s = chatReducer(s, { type: "entries", entries: [user("u", "go", true)] });
    expect(s.pending).toHaveLength(1);
  });

  it("keeps at most CHAT_MAX_ENTRIES (drops the oldest on append, the newest on prepend)", () => {
    const many = Array.from({ length: CHAT_MAX_ENTRIES }, (_, i) => user(`u${i}`, "x"));
    let s = chatReducer(initialChat(), { type: "history", entries: many, hasMore: true });
    s = chatReducer(s, { type: "entries", entries: [user("new", "y")] });
    expect(s.entries).toHaveLength(CHAT_MAX_ENTRIES);
    expect(s.entries.at(-1)!.uuid).toBe("new");
    s = chatReducer(s, { type: "history", entries: [user("older", "z")], hasMore: false, older: true });
    expect(s.entries[0].uuid).toBe("older");
    expect(s.entries).toHaveLength(CHAT_MAX_ENTRIES);
  });
});

describe("chatItems and HTML", () => {
  it("folds a tool result into its call; an orphan result is its own chip", () => {
    const items = chatItems([
      user("u", "go"),
      { uuid: "t1", ts: 3, role: "tool", tool: { name: "Bash", summary: "npm test\n--watch", id: "toolu_1" } },
      { uuid: "r1", ts: 4, role: "tool", tool: { name: "result", summary: "5 passed", id: "toolu_1", result: true, error: true } },
      { uuid: "r2", ts: 5, role: "tool", tool: { name: "result", summary: "orphan", id: "toolu_0", result: true } },
      { uuid: "e", ts: 6, role: "assistant" },
    ]);
    expect(items).toEqual([
      { kind: "msg", key: "u", role: "user", text: "go", ts: 1 },
      { kind: "tool", key: "t1", name: "Bash", summary: "npm test\n--watch", ts: 3, result: { summary: "5 passed", error: true } },
      { kind: "tool", key: "r2", name: "Result", summary: "", ts: 5, result: { summary: "orphan" } },
    ]);
    expect(toolLine(items[1] as any)).toBe("Bash: npm test");
    expect(toolLine({ kind: "tool", key: "k", name: "Interrupted", summary: "", ts: 0 })).toBe("Interrupted");
  });

  it("bubbles render escaped Markdown and label TabAgent messages; chips are collapsed details with an error badge", () => {
    const html = chatItemHtml({ kind: "msg", key: "k<", role: "user", text: "**hi** <script>x</script>", ts: Date.UTC(2026, 0, 1, 12), fromTabAgent: true });
    expect(html).toContain('data-key="k&lt;"');
    expect(html).toContain("<strong>hi</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("via TabAgent");
    expect(html).toContain("msg-user");
    expect(chatItemHtml({ kind: "msg", key: "a", role: "assistant", text: "ok", ts: 0 })).toContain("<span>Claude</span>");
    const chip = chatItemHtml({ kind: "tool", key: "t", name: "Read", summary: "<b>a.ts</b>", ts: 0, result: { summary: "line", error: true } });
    expect(chip).toMatch(/^<details class="tool-chip tool-chip-err" data-key="t">/);
    expect(chip).toContain("Read: &lt;b&gt;a.ts&lt;/b&gt;");
    expect(chip).toContain("tool-err");
    expect(chip).toContain("<div class=\"tool-label\">Result</div>");
    expect(chatItemHtml({ kind: "tool", key: "t", name: "Interrupted", summary: "", ts: 0 }, true)).toContain(" open>");
    expect(chatItemHtml({ kind: "tool", key: "t", name: "Interrupted", summary: "", ts: 0 })).toContain("No details");
  });

  it("pending bubbles say where the message is; failed ones offer edit and dismiss", () => {
    expect(pendingHtml({ requestId: "r", text: "hi", ts: 0, state: "sending" })).toContain("Sending…");
    expect(pendingHtml({ requestId: "r", text: "hi", ts: 0, state: "held" })).toContain("Waiting for its next browser action");
    expect(pendingHtml({ requestId: "r", text: "hi", ts: 0, state: "sent" })).toContain("Sent · waiting for the agent");
    const f = pendingHtml({ requestId: "r\"", text: "<i>", ts: 0, state: "failed", code: "NO_ROUTE", detail: "<b>why</b>" });
    expect(f).toContain("Not sent (NO_ROUTE)");
    expect(f).toContain('data-edit="r&quot;"');
    expect(f).toContain("&lt;b&gt;why&lt;/b&gt;");
    expect(f).not.toContain("<i>");
    expect(pendingHtml({ requestId: "r", text: "go", ts: 0, state: "started", spawn: true })).toContain("new session");
  });
});

describe("header, composer mode and the not-connected card", () => {
  it("header shows title, folder, busy state and connection words", () => {
    expect(chatHeaderView(agent({ status: "busy" }), Date.now())).toMatchObject({ title: "Fix the tests", folder: "/Users/me/code/app", busy: true, statusText: "Working…", connection: { label: "Connected · instant" }, remoteControlUrl: null });
    expect(chatHeaderView(agent({ status: "error", statusLabel: "boom" }), Date.now()).statusText).toBe("Error: boom");
    expect(chatHeaderView(agent({ status: "idle", statusLabel: "waitingOnUserInput" }), Date.now()).statusText).toBe("waitingOnUserInput");
    expect(chatHeaderView(agent({ linked: false, delivery: "none", remoteControlUrl: RC }), Date.now())).toMatchObject({ statusText: "Idle", connection: { label: "Remote Control only" }, remoteControlUrl: RC });
  });

  it("composer mode per agent", () => {
    expect(composerMode(null, { loaded: false, spawnChosen: false })).toBe("loading");
    expect(composerMode(null, { loaded: true, spawnChosen: false })).toBe("gone");
    expect(composerMode(agent(), { loaded: true, spawnChosen: false })).toBe("send");
    expect(composerMode(agent({ vendor: "codex", delivery: "queue", linked: false }), { loaded: true, spawnChosen: false })).toBe("send");
    expect(composerMode(agent({ linked: false, delivery: "none" }), { loaded: true, spawnChosen: false })).toBe("card");
    expect(composerMode(agent({ linked: false, delivery: "none" }), { loaded: true, spawnChosen: true })).toBe("spawn");
    expect(composerMode(agent({ linked: false, delivery: "none", cwd: "" }), { loaded: true, spawnChosen: true })).toBe("card");
    expect(composerMode(agent({ vendor: "codex", delivery: "none", status: "error", linked: false }), { loaded: true, spawnChosen: false })).toBe("none");
  });

  it("not connected with Remote Control: Open in Claude is the primary action; without it, how to get it", () => {
    const withRc = notConnectedCardHtml(agent({ linked: false, delivery: "none", remoteControlUrl: RC }));
    expect(withRc).toContain("This session isn't connected to TabAgent.");
    expect(withRc).toContain(`<a class="btn primary" data-rc href="${RC}" target="_blank" rel="noopener noreferrer">Open in Claude ↗</a>`);
    expect(withRc).toContain("Start a new session in app");
    expect(withRc).toContain("--dangerously-load-development-channels server:tabagent");
    expect(withRc).toContain("<code>tabagent setup claude</code>");
    const without = notConnectedCardHtml(agent({ linked: false, delivery: "none" }));
    expect(without).toContain("<code>--remote-control</code>");
    expect(without).not.toContain("data-rc");
    expect(notConnectedCardHtml(agent({ linked: false, delivery: "none", remoteControlUrl: "javascript:alert(1)" }))).not.toContain("javascript:");
  });

  it("history error words", () => {
    expect(historyErrorText({ code: "UNSUPPORTED", detail: "" })).toContain("History isn't available for Codex yet");
    expect(historyErrorText({ code: "NO_TRANSCRIPT", detail: "" })).toContain("No conversation found");
    expect(historyErrorText({ code: "AGENT_GONE", detail: "" })).toContain("no longer running");
    expect(historyErrorText({ code: "TIMEOUT", detail: "slow" })).toBe("Couldn't load the conversation: slow");
  });

  it("atBottom and recent web tabs", () => {
    expect(atBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(atBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
    const tabs = recentWebTabs([
      { id: 1, url: "https://a.test", lastAccessed: 5 },
      { id: 2, url: "chrome-extension://x/chat.html", lastAccessed: 9 },
      { id: 3, url: "http://b.test", lastAccessed: 7 },
      { url: "https://noid.test" },
    ]);
    expect(tabs.map((t) => t.id)).toEqual([3, 1]);
  });
});

describe("chat tab reuse", () => {
  const base = "chrome-extension://abc/";
  it("finds the open chat tab for an agent", () => {
    expect(chatAgentOf(`${base}chat.html?agent=claude%3A1%3A2`, base)).toBe("claude:1:2");
    expect(chatAgentOf(`${base}sidepanel.html`, base)).toBeNull();
    expect(chatAgentOf(undefined, base)).toBeNull();
    expect(chatAgentOf("chrome-extension://other/chat.html?agent=a", base)).toBeNull();
    const tabs = [{ id: 1, url: `${base}chat.html?agent=a` }, { id: 2, pendingUrl: `${base}chat.html?agent=b` }, { url: `${base}chat.html?agent=c` }];
    expect(findChatTab(tabs, base, "b")?.id).toBe(2);
    expect(findChatTab(tabs, base, "c")).toBeNull();
    expect(findChatTab(tabs, base, "z")).toBeNull();
  });
});

describe("renderMarkdown (escape first)", () => {
  it.each([
    ["plain & <tags>", "<p>plain &amp; &lt;tags&gt;</p>"],
    ["**bold** and *it* and _it2_ and __b2__", "<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <strong>b2</strong></p>"],
    ["a `x <y>` b", "<p>a <code>x &lt;y&gt;</code> b</p>"],
    ["one\ntwo\n\nthree", "<p>one<br>two</p><p>three</p>"],
    ["- a\n- b\n\n1. c\n2. d", "<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>"],
    ["# Title", "<h3>Title</h3>"],
    ["> quoted", "<blockquote>quoted</blockquote>"],
    ["```ts\nconst a = '<b>';\n```", '<pre class="code" data-lang="ts"><code>const a = &#39;&lt;b&gt;&#39;;</code></pre>'],
    ["```\nunclosed **not bold**", '<pre class="code"><code>unclosed **not bold**</code></pre>'],
    ["snake_case_name stays", "<p>snake_case_name stays</p>"],
    ["- item\n  continued", "<ul><li>item continued</li></ul>"],
  ])("%j", (md, html) => {
    expect(renderMarkdown(md)).toBe(html);
  });

  it("links: only http(s), new tab, noopener; no attribute injection", () => {
    expect(renderMarkdown("[docs](https://x.test/a?b=1&c=2)")).toBe('<p><a href="https://x.test/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
    expect(renderMarkdown("see https://x.test/p.")).toBe('<p>see <a href="https://x.test/p" target="_blank" rel="noopener noreferrer">https://x.test/p</a>.</p>');
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
    const evil = renderMarkdown('https://x.test/"onmouseover="alert(1)');
    expect(evil).not.toMatch(/href="[^"]*"onmouseover/);
    expect(evil).not.toContain('"onmouseover="');
    expect(renderMarkdown("`https://x.test`")).toBe("<p><code>https://x.test</code></p>");
    // Placeholder characters in the input cannot forge a slot.
    expect(renderMarkdown("\u00000\u0001 `a`")).toBe("<p>0 <code>a</code></p>");
  });
});


describe("starting a session from the chat window (user-reported bugs)", () => {
  it("knows a home folder, where Claude Code refuses background sessions", () => {
    for (const h of ["/Users/me", "/Users/me/", "/home/me", "C:\\Users\\me"]) expect(isHomeFolder(h)).toBe(true);
    for (const p of ["/Users/me/code/app", "/home/me/proj", "/", "/Users"]) expect(isHomeFolder(p)).toBe(false);
  });
  it("the not-connected card does not offer Start for a home-folder session and says why", () => {
    const html = notConnectedCardHtml(agent({ linked: false, delivery: "spawn", cwd: "/Users/me" }));
    expect(html).not.toContain("data-spawn-start");
    expect(html).toMatch(/home folder/i);
  });
  it("WORKSPACE_UNTRUSTED becomes a plain explanation", () => {
    expect(spawnFailureText({ code: "WORKSPACE_UNTRUSTED", detail: "Workspace not trusted." }, "/Users/me")).toMatch(/home folder.*project folder/i);
    expect(spawnFailureText({ code: "SPAWN_FAILED", detail: "boom" }, "/x")).toBe("boom");
  });
  it("finds the session it just started: same folder, new, started after the click", () => {
    const before = [agent({ id: "claude:1:100", cwd: "/w", startedAt: 100 })];
    const after = [...before, agent({ id: "claude:2:5000", cwd: "/other", startedAt: 5000 }), agent({ id: "claude:3:5100", cwd: "/w", startedAt: 5100 })];
    expect(findSpawnedAgent(before.map((a) => a.id), after, { cwd: "/w", since: 4000 })?.id).toBe("claude:3:5100");
    expect(findSpawnedAgent(after.map((a) => a.id), after, { cwd: "/w", since: 4000 })).toBeNull();
    expect(findSpawnedAgent(before.map((a) => a.id), [agent({ id: "claude:4:1000", cwd: "/w", startedAt: 1000 })], { cwd: "/w", since: 4000 })).toBeNull();
  });
});
