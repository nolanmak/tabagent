// Side panel Sessions list (#133): each session's tabs, the click-to-view row and the focus check.
import { describe, expect, it } from "vitest";
import { focusRefusal, sessionRowHtml, sessionTabs, sessionView, truncateTitle, TITLE_MAX } from "../src/pure/sessionsView";

const base = { id: "s1", label: "local", color: "purple", cap: "full", lastUsed: 1 };

describe("sessionTabs", () => {
  it("puts the active tab first, then the rest most recent first", () => {
    const tabs = sessionTabs({ tabIds: [1, 2, 3, 4], active: 2 }, { 1: "One", 2: "Two", 3: "Three", 4: "Four" });
    expect(tabs).toEqual([
      { tabId: 2, title: "Two", active: true },
      { tabId: 4, title: "Four", active: false },
      { tabId: 3, title: "Three", active: false },
      { tabId: 1, title: "One", active: false },
    ]);
  });

  it("falls back to the most recently added tab when active is unset or stale", () => {
    expect(sessionTabs({ tabIds: [5, 6] }, {}).map((t) => [t.tabId, t.active])).toEqual([
      [6, true],
      [5, false],
    ]);
    expect(sessionTabs({ tabIds: [5, 6], active: 99 }, {})[0]).toMatchObject({ tabId: 6, active: true });
  });

  it("names untitled tabs by id", () => {
    expect(sessionTabs({ tabIds: [7], active: 7 }, { 7: "  " })[0].title).toBe("Tab 7");
    expect(sessionTabs({ tabIds: [8], active: 8 }, {})[0].title).toBe("Tab 8");
  });

  it("is empty for a session without tabs", () => {
    expect(sessionTabs({ tabIds: [] }, {})).toEqual([]);
  });
});

describe("truncateTitle", () => {
  it("keeps short titles and shortens long ones with an ellipsis", () => {
    expect(truncateTitle("Short")).toBe("Short");
    const long = "x".repeat(TITLE_MAX + 20);
    const t = truncateTitle(long);
    expect(t.length).toBe(TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(truncateTitle("  padded  ")).toBe("padded");
  });
});

describe("sessionView", () => {
  it("adds the tab list and the tab a row click views", () => {
    const v = sessionView({ ...base, tabs: 2, tabIds: [1, 2], active: 1 }, { 1: "A", 2: "B" });
    expect(v).toMatchObject({ id: "s1", label: "local", tabs: 2, viewTabId: 1 });
    expect(v.tabList.map((t) => t.tabId)).toEqual([1, 2]);
  });

  it("has no view tab without tabs", () => {
    expect(sessionView({ ...base, tabs: 0, tabIds: [] }, {}).viewTabId).toBeUndefined();
  });
});

describe("sessionRowHtml", () => {
  it("renders a view button for the active tab and an End button", () => {
    const html = sessionRowHtml(sessionView({ ...base, tabs: 1, tabIds: [42], active: 42 }, { 42: "Home" }));
    expect(html).toContain('data-view-tab="42"');
    expect(html).toContain('data-end="s1"');
    expect(html).toContain("1 tab · full");
    // one tab: no separate tab list
    expect(html).not.toContain("session-tabs");
  });

  it("lists every tab of a multi-tab session, escaped and truncated, active marked", () => {
    const long = `<img src=x onerror=alert(1)> ${"y".repeat(200)}`;
    const html = sessionRowHtml(sessionView({ ...base, tabs: 2, tabIds: [1, 2], active: 2 }, { 1: long, 2: "Second" }));
    expect(html).toContain("session-tabs");
    expect(html).toContain("2 tabs");
    expect(html.match(/data-view-tab="2"/g)?.length).toBe(2); // row + its list entry
    expect(html).toContain('data-view-tab="1"');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    const shown = [...html.matchAll(/class="session-tab[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(shown[1].endsWith("…")).toBe(true);
    expect(shown[1].length).toBeLessThan(TITLE_MAX + 20); // escaping adds a few characters
    expect(html).toMatch(/class="session-tab active"[^>]*data-view-tab="2"/);
    expect(html).toContain('aria-current="true"');
  });

  it("has no view action for a session without tabs", () => {
    const html = sessionRowHtml(sessionView({ ...base, tabs: 0, tabIds: [] }, {}));
    expect(html).not.toContain("data-view-tab");
    expect(html).toContain("0 tabs");
    expect(html).toContain('data-end="s1"');
  });

  it("escapes label, color and cap", () => {
    const html = sessionRowHtml(sessionView({ ...base, label: '<b>"x"</b>', color: '"><script>', cap: "<i>", tabs: 0, tabIds: [] }, {}));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>\"x\"</b>");
    expect(html).toContain("&lt;i&gt;");
  });
});

describe("focusRefusal", () => {
  const owners = new Map([[10, "s1"]]);
  const ownerOf = (id: number) => owners.get(id);
  it("allows a tab a session owns", () => {
    expect(focusRefusal(10, ownerOf)).toBeNull();
  });
  it("refuses a tab no session owns, and bad ids", () => {
    expect(focusRefusal(11, ownerOf)).toMatch(/not a TabAgent session tab/);
    expect(focusRefusal("10", ownerOf)).toMatch(/Invalid tab/);
    expect(focusRefusal(1.5, ownerOf)).toMatch(/Invalid tab/);
    expect(focusRefusal(undefined, ownerOf)).toMatch(/Invalid tab/);
  });
});
