// #159: the chat page's compact session picker (shown when the rail is hidden on narrow windows).
// View model, markup and the keyboard reducer. Pure.
import { describe, expect, it } from "vitest";
import type { Agent } from "@tabagent/protocol";
import { agentRowView } from "../src/pure/agents";
import { closedPicker, pickerButtonHtml, pickerListHtml, pickerReducer, sessionItems, sessionPickerView, type PickerState } from "../src/pure/sessionPicker";

const NOW = 1_800_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({ id: "claude:1:1", vendor: "claude", name: "n", title: "Fix the tests", cwd: "/Users/me/code/app", startedAt: NOW - 60_000, pid: 1, status: "idle", linked: true, canDriveTab: true, delivery: "channel", ...over });
const views = () => [
  agentRowView(agent({ id: "claude:2:2", title: "<b>Other</b>", linked: false, delivery: "none", startedAt: NOW - 120_000 }), NOW),
  agentRowView(agent({ status: "busy" }), NOW),
  agentRowView(agent({ id: "codex:t", vendor: "codex", title: "Codex job", linked: false, delivery: "queue" }), NOW),
];

describe("sessionItems", () => {
  it("orders like the rail (linked first), marks the current one and builds the same meta line", () => {
    const items = sessionItems(views(), "claude:2:2");
    expect(items.map((i) => i.id)).toEqual(["claude:1:1", "codex:t", "claude:2:2"]);
    expect(items[0]).toMatchObject({ title: "Fix the tests", meta: "Claude · Connected · instant · 1m", tone: "instant", busy: true, current: false, href: "chat.html?agent=claude%3A1%3A1" });
    expect(items[1].meta).toBe("Codex · queued · 1m");
    expect(items[2]).toMatchObject({ current: true, tone: "off", busy: false });
  });
});

describe("sessionPickerView", () => {
  it("labels the button with the current session's title, dot and busy state", () => {
    const v = sessionPickerView(views(), "claude:1:1", "Loading…");
    expect(v).toMatchObject({ label: "Fix the tests", tone: "instant", busy: true, currentIndex: 0 });
    expect(v.items).toHaveLength(3);
  });

  it("falls back to the page's title when the current session is not listed", () => {
    const v = sessionPickerView(views(), "claude:9:9", "Session not running");
    expect(v).toMatchObject({ label: "Session not running", tone: null, busy: false, currentIndex: -1 });
    expect(sessionPickerView([], "", "No session")).toMatchObject({ label: "No session", items: [], currentIndex: -1 });
  });
});

describe("picker markup", () => {
  it("the button shows the status dot, the escaped title and a chevron", () => {
    const html = pickerButtonHtml(sessionPickerView([agentRowView(agent({ title: "<i>x</i>", status: "busy" }), NOW)], "claude:1:1", ""));
    expect(html).toContain('class="status-dot tone-instant busy-dot"');
    expect(html).toContain('<span class="picker-title">&lt;i&gt;x&lt;/i&gt;</span>');
    expect(html).toContain("<svg");
    expect(pickerButtonHtml(sessionPickerView([], "", "No session"))).not.toContain("status-dot");
  });

  it("the list links every session, escaped, with the current one marked once", () => {
    const html = pickerListHtml(sessionPickerView(views(), "claude:2:2", ""));
    expect(html).toContain('href="chat.html?agent=claude%3A2%3A2" data-picker-agent="claude:2:2" aria-current="page"');
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toContain("&lt;b&gt;Other&lt;/b&gt;");
    expect(html).not.toContain("<b>Other");
    expect(html).toContain("busy-dot");
    expect(pickerListHtml(sessionPickerView([], "", ""))).toContain("No sessions running.");
  });
});

describe("pickerReducer", () => {
  const ctx = { count: 3, current: 1 };
  const open: PickerState = { open: true, active: 1 };

  it("a click toggles; opening starts on the current session and moves focus into the list", () => {
    expect(pickerReducer(closedPicker, { type: "toggle" }, ctx)).toEqual({ state: { open: true, active: 1 }, handled: true, focus: "item" });
    expect(pickerReducer(open, { type: "toggle" }, ctx)).toEqual({ state: closedPicker, handled: true, focus: "button" });
    // No current session: the first one.
    expect(pickerReducer(closedPicker, { type: "toggle" }, { count: 3, current: -1 }).state).toEqual({ open: true, active: 0 });
    // Nothing to pick: it opens on the empty note, focus stays on the button.
    expect(pickerReducer(closedPicker, { type: "toggle" }, { count: 0, current: -1 })).toEqual({ state: { open: true, active: -1 }, handled: true, focus: null });
  });

  it("from the button: ↓/↑ open (↑ from the end when nothing is current); Esc closes; other keys pass", () => {
    expect(pickerReducer(closedPicker, { type: "key", key: "ArrowDown", from: "button" }, ctx)).toEqual({ state: { open: true, active: 1 }, handled: true, focus: "item" });
    expect(pickerReducer(closedPicker, { type: "key", key: "ArrowUp", from: "button" }, { count: 3, current: -1 }).state).toEqual({ open: true, active: 2 });
    expect(pickerReducer(open, { type: "key", key: "ArrowDown", from: "button" }, ctx)).toEqual({ state: open, handled: true, focus: "item" });
    expect(pickerReducer(open, { type: "key", key: "Escape", from: "button" }, ctx)).toEqual({ state: closedPicker, handled: true, focus: "button" });
    expect(pickerReducer(closedPicker, { type: "key", key: "Escape", from: "button" }, ctx)).toEqual({ state: closedPicker, handled: false, focus: null });
    expect(pickerReducer(closedPicker, { type: "key", key: "a", from: "button" }, ctx).handled).toBe(false);
  });

  it("in the list: ↓/↑ wrap, Home/End jump, Esc closes back to the button, Tab closes and moves on", () => {
    const key = (s: PickerState, k: string) => pickerReducer(s, { type: "key", key: k, from: "list" }, ctx);
    expect(key(open, "ArrowDown")).toEqual({ state: { open: true, active: 2 }, handled: true, focus: "item" });
    expect(key({ open: true, active: 2 }, "ArrowDown").state.active).toBe(0);
    expect(key({ open: true, active: 0 }, "ArrowUp").state.active).toBe(2);
    expect(key(open, "Home").state.active).toBe(0);
    expect(key(open, "End").state.active).toBe(2);
    expect(key(open, "Escape")).toEqual({ state: closedPicker, handled: true, focus: "button" });
    expect(key(open, "Tab")).toEqual({ state: closedPicker, handled: false, focus: null });
    expect(key(open, "x")).toEqual({ state: open, handled: false, focus: null });
    // An empty list ignores arrows.
    expect(pickerReducer({ open: true, active: -1 }, { type: "key", key: "ArrowDown", from: "list" }, { count: 0, current: -1 }).handled).toBe(false);
  });

  it("close (outside click, navigation) always closes without moving focus", () => {
    expect(pickerReducer(open, { type: "close" }, ctx)).toEqual({ state: closedPicker, handled: true, focus: null });
  });
});
