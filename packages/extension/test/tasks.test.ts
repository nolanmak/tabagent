// #158 Timed tasks, extension side: the worker's tasks.* requests over the bridge socket and the side panel's
// Tasks view (rows, live duration, timeline with gaps, labels, closed-section summary).
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@tabagent/protocol";
import { labelTask, listTasks, onTasksBridgeMessage, setTasksChangedListener, setTasksSender, tasksSupported } from "../src/background/bridgeTasks";
import { formatDuration, liveDurationText, taskItemHtml, taskRowView, tasksHtml, tasksSummary, timelineRows } from "../src/pure/tasksView";

let sent: any[];
beforeEach(() => {
  sent = [];
  setTasksSender((m) => (sent.push(m), true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

const task = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  taskId: "t-1",
  session: "S",
  caller: "claude-code",
  goal: "Add mozzarella to the order",
  explicit: true,
  startedAt: 1_000_000,
  endedAt: 1_067_000,
  durationMs: 67_000,
  outcome: "success",
  callCount: 3,
  browserMs: 4_500,
  origins: ["https://www.shop.test"],
  lastAt: 1_067_000,
  calls: [
    { ts: 1_000_000, tool: "nav.goto", origin: "https://www.shop.test", outcome: "ok", durationMs: 2000 },
    { ts: 1_004_000, tool: "act.click", origin: "https://www.shop.test", outcome: "denied", errorCode: "PERMISSION_DENIED", durationMs: 500 },
    { ts: 1_020_000, tool: "tabs", action: "list", origin: null, outcome: "ok" },
  ],
  ...over,
});

describe("worker: tasks over the bridge socket", () => {
  it.each([
    [["tasks"], ["tasks"], true],
    [["tasks"], [], false],
    [[], ["tasks"], false],
  ])("feature: ext %j + bridge %j -> %s", (ext, br, want) => {
    expect(tasksSupported(ext, br)).toBe(want);
  });
  it("listTasks sends tasks.list and resolves with the matching tasks.listed", async () => {
    const p = listTasks(10, "t-1");
    expect(sent[0]).toMatchObject({ type: "tasks.list", limit: 10, calls: "t-1" });
    expect(onTasksBridgeMessage({ type: "tasks.listed", id: "other", tasks: [] })).toBe(true);
    onTasksBridgeMessage({ type: "tasks.listed", id: sent[0].id, tasks: [task()] });
    await expect(p).resolves.toEqual([task()]);
    // a malformed reply is swallowed
    expect(onTasksBridgeMessage({ type: "tasks.listed", id: 5 })).toBe(true);
  });
  it("labelTask resolves with ok / code", async () => {
    const p = labelTask("t-1", "failed");
    expect(sent[0]).toMatchObject({ type: "tasks.label", taskId: "t-1", outcome: "failed" });
    onTasksBridgeMessage({ type: "tasks.labeled", id: sent[0].id, ok: false, code: "NOT_FOUND" });
    await expect(p).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    const q = labelTask("t-1", "success");
    onTasksBridgeMessage({ type: "tasks.labeled", id: sent[1].id, ok: true });
    await expect(q).resolves.toEqual({ ok: true });
  });
  it("NO_EXTENSION when the socket is down; TIMEOUT when the bridge never answers", async () => {
    const p = listTasks(undefined, undefined, 1000);
    expect(sent[0]).not.toHaveProperty("limit");
    expect(sent[0]).not.toHaveProperty("calls");
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    setTasksSender(() => false);
    await expect(labelTask("t", "success")).rejects.toMatchObject({ code: "NO_EXTENSION" });
  });
  it("tasks.changed reaches the listener; other messages are not ours", () => {
    const fn = vi.fn();
    setTasksChangedListener(fn);
    expect(onTasksBridgeMessage({ type: "tasks.changed" })).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onTasksBridgeMessage({ type: "agents.listed" })).toBe(false);
    expect(onTasksBridgeMessage(null)).toBe(false);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [450, "450ms"],
    [4_250, "4.2s"],
    [38_900, "38s"],
    [67_000, "1m 7s"],
    [7_500_000, "2h 5m"],
    [-1, "—"],
    [NaN, "—"],
  ])("%s -> %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
  it("liveDurationText counts from the start", () => {
    expect(liveDurationText(1000, 13_000)).toBe("12s");
    expect(liveDurationText(5000, 1000)).toBe("0ms");
  });
});

describe("task rows", () => {
  it("an ended task: total, browser vs between-call time, sites, badge", () => {
    expect(taskRowView(task(), 9e9)).toMatchObject({ title: "Add mozzarella to the order", durationMs: 67_000, browserMs: 4_500, betweenMs: 62_500, sites: ["www.shop.test"], badge: "success", running: false, canLabel: false });
  });
  it("a running task's duration runs to now", () => {
    const v = taskRowView(task({ endedAt: undefined, durationMs: undefined, outcome: null }), 1_010_000);
    expect(v).toMatchObject({ running: true, durationMs: 10_000, badge: "running", canLabel: false });
  });
  it("an untitled ended task with no outcome can be labeled", () => {
    const v = taskRowView(task({ goal: null, explicit: false, outcome: "unknown" }), 0);
    expect(v).toMatchObject({ title: "Untitled task · www.shop.test", badge: "unlabeled", canLabel: true });
    expect(taskRowView(task({ goal: null, origins: [], outcome: "abandoned", durationMs: undefined }), 0)).toMatchObject({ title: "Untitled task", badge: "abandoned", durationMs: 67_000 });
  });
  it("timeline: offset, duration and the wait since the previous call ended", () => {
    expect(timelineRows(task())).toEqual([
      { tool: "nav.goto", site: "www.shop.test", outcome: "ok", durationMs: 2000, gapMs: 0, atMs: 0 },
      { tool: "act.click", site: "www.shop.test", outcome: "denied", errorCode: "PERMISSION_DENIED", durationMs: 500, gapMs: 2000, atMs: 4000 },
      { tool: "tabs list", site: "", outcome: "ok", gapMs: 15_500, atMs: 20_000 },
    ]);
  });
});

describe("tasks HTML", () => {
  const dom = (html: string) => {
    const ul = document.createElement("ul");
    ul.innerHTML = html;
    return ul;
  };
  it("closed row: title, meta, duration, badge; no timeline", () => {
    const ul = dom(taskItemHtml(task(), 0, false));
    expect(ul.querySelector(".task-title")!.textContent).toBe("Add mozzarella to the order");
    expect(ul.querySelector(".task-meta")!.textContent).toContain("3 calls");
    expect(ul.querySelector(".task-dur")!.textContent).toBe("1m 7s");
    expect(ul.querySelector(".task-badge")!.textContent).toBe("✓ Done");
    expect(ul.querySelector(".task-timeline")).toBeNull();
    expect(ul.querySelector("[data-task-toggle]")!.getAttribute("aria-expanded")).toBe("false");
  });
  it("open row: split line and one timeline item per call, waits of a second or more shown", () => {
    const ul = dom(taskItemHtml(task(), 0, true));
    expect(ul.querySelector(".task-split")!.textContent).toBe("In the browser 4.5s · between calls 1m 2s · total 1m 7s");
    const items = ul.querySelectorAll(".task-timeline li");
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toContain("PERMISSION_DENIED");
    expect(items[1].querySelector(".tl-gap")!.textContent).toBe("+2.0s wait");
    expect(items[0].querySelector(".tl-gap")!.textContent).toBe("");
    expect(items[2].querySelector(".tl-dur")!.textContent).toBe("—");
  });
  it("running row carries data-started for the 1 s tick; unlabeled row has ✓/✗; truncated calls say so", () => {
    const running = dom(taskItemHtml(task({ endedAt: undefined, outcome: null, callCount: 1, calls: [] }), 1_005_000, true));
    expect(running.querySelector(".task-dur.live")!.getAttribute("data-started")).toBe("1000000");
    expect(running.querySelector(".task-timeline")!.textContent).toContain("Loading calls…");
    expect(dom(taskItemHtml(task({ callCount: 0, calls: [] }), 0, true)).querySelector(".task-timeline")!.textContent).toBe("No calls.");
    const unl = dom(taskItemHtml(task({ outcome: "unknown", note: "out of stock", callCount: 250 }), 0, true));
    expect([...unl.querySelectorAll("[data-task-label]")].map((b) => b.getAttribute("data-task-label"))).toEqual(["success", "failed"]);
    expect(unl.textContent).toContain("out of stock");
    expect(unl.textContent).toContain("…and 247 more calls");
    expect(dom(taskItemHtml(task({ callCount: 1 }), 0, false)).querySelector(".task-meta")!.textContent).toContain("1 call");
  });
  it("escapes goals and lists the empty state", () => {
    expect(tasksHtml([task({ goal: "<img src=x onerror=alert(1)>" })], 0, null)).not.toContain("<img");
    expect(tasksHtml([], 0, null)).toContain("No tasks yet");
    expect(tasksHtml([task(), task({ taskId: "t-2" })], 0, "t-2").match(/class="task open"/g)).toHaveLength(1);
  });
  it("closed-section summary: count, running first, then to-label", () => {
    expect(tasksSummary([])).toEqual({ count: "", meta: "" });
    expect(tasksSummary([task(), task({ endedAt: undefined, outcome: null })])).toEqual({ count: "2", meta: "1 running" });
    expect(tasksSummary([task({ outcome: "unknown" }), task()])).toEqual({ count: "2", meta: "1 to label" });
    expect(tasksSummary([task()])).toEqual({ count: "1", meta: "" });
  });
});
