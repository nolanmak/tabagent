import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installChrome } from "./fakes/chrome";

vi.mock("../src/background/cdp", () => ({ detachTab: vi.fn(async () => {}) }));
vi.mock("../src/background/driver", () => ({ disposeDrivers: vi.fn() }));

const fake = installChrome();
let S: typeof import("../src/background/sessions");

const meta = (id: string, label = id) => ({ id, label, cap: "full" as const, sites: [] as string[] });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  S = await import("../src/background/sessions");
});

beforeEach(async () => {
  S.__resetForTests();
  fake.tabs.clear();
  fake.groups.clear();
  fake.calls.length = 0;
  fake.chrome.storage.session._reset();
  fake.chrome.storage.local._reset();
});

describe("sessions + tab ownership (#5)", () => {
  it("first tabs new creates the group with the label; second reuses it", async () => {
    const s = await S.getSession(meta("a", "alpha"));
    const t1 = await S.newTab(s);
    const t2 = await S.newTab(s);
    expect(s.groupId).toBeDefined();
    expect(fake.tabs.get(t1.id!)!.groupId).toBe(s.groupId);
    expect(fake.tabs.get(t2.id!)!.groupId).toBe(s.groupId);
    expect(fake.groups.size).toBe(1);
    expect(fake.groups.get(s.groupId!)!.title).toBe("🤖 alpha");
    expect(fake.calls.filter((c) => c.startsWith("tabs.create")).every((c) => c.endsWith("active=false"))).toBe(true);
  });
  it("group colour comes from a fixed palette by session index", async () => {
    const a = await S.getSession(meta("a"));
    const b = await S.getSession(meta("b"));
    expect([a.color, b.color]).toEqual([S.COLORS[0], S.COLORS[1]]);
  });
  it("session B naming a tab owned by A -> TAB_BUSY; a tab owned by nobody -> NOT_FOUND", async () => {
    const a = await S.getSession(meta("a"));
    const b = await S.getSession(meta("b"));
    const t = await S.newTab(a);
    await expect(S.resolveTab(b, t.id)).rejects.toMatchObject({ code: "TAB_BUSY" });
    const u = fake.addUserTab("https://u.example/");
    await expect(S.resolveTab(b, u.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(S.addTab(b, t.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
  });
  it("no tabs -> NOT_FOUND with the tabs new hint; create=true makes one", async () => {
    const s = await S.getSession(meta("a"));
    await expect(S.resolveTab(s)).rejects.toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("tabs new") });
    const id = await S.resolveTab(s, undefined, true);
    expect(s.tabIds).toEqual([id]);
  });
  it("two commands from one session to one tab run in arrival order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = S.serialize(5, async () => {
      order.push("1 start");
      await new Promise<void>((r) => (release = r));
      order.push("1 end");
    });
    const second = S.serialize(5, async () => {
      order.push("2 start");
    });
    await tick();
    expect(order).toEqual(["1 start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["1 start", "1 end", "2 start"]);
    // a failing command doesn't block the next one
    await expect(S.serialize(5, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(S.serialize(5, async () => "ok")).resolves.toBe("ok");
  });
  it("tabs select changes the active tab and calls no focus/activate API", async () => {
    const s = await S.getSession(meta("a"));
    const t1 = await S.newTab(s);
    await S.newTab(s);
    fake.calls.length = 0;
    await S.selectTab(s, t1.id!);
    expect(s.active).toBe(t1.id);
    expect(await S.resolveTab(s)).toBe(t1.id);
    expect(fake.calls.filter((c) => c.startsWith("tabs.update") || c.startsWith("windows.update"))).toEqual([]);
  });
  it("popup opened by an owned tab joins the session", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    const pop = fake.addUserTab("https://a.example/popup", { openerTabId: t.id });
    fake.ev.tabsCreated.fire({ ...pop });
    await tick();
    await tick();
    expect(s.tabIds).toContain(pop.id);
    expect(s.active).toBe(t.id); // joining doesn't steal the active tab
    // webNavigation path, idempotent
    fake.ev.navTarget.fire({ sourceTabId: t.id, tabId: pop.id });
    await tick();
    expect(s.tabIds.filter((x) => x === pop.id)).toHaveLength(1);
    // a tab opened by a user tab does not join
    const u = fake.addUserTab("https://u.example");
    const child = fake.addUserTab("https://u.example/2", { openerTabId: u.id });
    await S.adoptOpened(u.id, child.id);
    expect(S.ownerOf(child.id)).toBeUndefined();
  });
  it("user moving a tab out of the group removes ownership", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    await fake.chrome.tabs.ungroup(t.id);
    await tick();
    await tick();
    expect(S.ownerOf(t.id!)).toBeUndefined();
    expect(s.tabIds).toEqual([]);
  });
  it("attach: added as attached; on session end it is ungrouped, not closed; own tabs collapse", async () => {
    const s = await S.getSession(meta("a", "alpha"));
    const own = await S.newTab(s);
    const u = fake.addUserTab("https://u.example");
    await S.addTab(s, u.id, { attached: true });
    expect(s.attached).toEqual([u.id]);
    await S.endSession("a");
    expect(fake.tabs.has(u.id)).toBe(true);
    expect(fake.tabs.get(u.id)!.groupId).toBe(-1);
    expect(fake.tabs.has(own.id!)).toBe(true);
    expect(fake.groups.get(s.groupId!)).toMatchObject({ collapsed: true, title: "✓ alpha" });
    expect(S.ownerOf(u.id)).toBeUndefined();
    expect(await S.endSession("a")).toBe(false);
  });
  it("session end with onSessionEnd=close closes own tabs but never attached ones", async () => {
    const s = await S.getSession(meta("a"));
    const own = await S.newTab(s);
    const u = fake.addUserTab("https://u.example");
    await S.addTab(s, u.id, { attached: true });
    await S.endSession("a", "close");
    expect(fake.tabs.has(own.id!)).toBe(false);
    expect(fake.tabs.has(u.id)).toBe(true);
  });
  it("attach with no tabId targets the active tab of the last-focused window", async () => {
    fake.addUserTab("https://bg.example");
    const act = fake.addUserTab("https://fg.example", { active: true });
    expect((await S.userActiveTab())?.id).toBe(act.id);
  });
  it("ownership survives a simulated service-worker restart (storage.session)", async () => {
    const s = await S.getSession(meta("a", "alpha"));
    const t = await S.newTab(s);
    const u = fake.addUserTab("https://u.example");
    await S.addTab(s, u.id, { attached: true });
    const closed = await S.newTab(s);
    S.__resetForTests(); // in-memory state gone
    fake.tabs.delete(closed.id!); // a tab closed while the worker slept
    await S.restoreSessions();
    expect(S.ownerOf(t.id!)).toBe("a");
    const again = await S.getSession(meta("a", "alpha"));
    expect(again.tabIds).toEqual([t.id, u.id]);
    expect(again.attached).toEqual([u.id]);
    expect(again.active).toBe(u.id);
    expect(S.listSessions()[0]).toMatchObject({ label: "alpha", tabs: 2 });
    // next session index continues after the restored ones
    const b = await S.getSession(meta("b"));
    expect(b.index).toBe(1);
  });
  it("closing a tab removes it from its session", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    await S.removeTab(t.id!);
    expect(s.tabIds).toEqual([]);
    expect(s.active).toBeUndefined();
  });
});

describe("M6 hooks: private auth tabs and handoff", () => {
  it("a private tab is owned by no session and refused for every command", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    await S.markPrivateTab(t.id!);
    expect(S.ownerOf(t.id!)).toBeUndefined();
    expect(s.tabIds).not.toContain(t.id);
    await expect(S.resolveTab(s, t.id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(S.addTab(s, t.id!)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(S.isPrivateTab(t.id!)).toBe(true);
    S.unmarkPrivateTab(t.id!);
    expect(S.isPrivateTab(t.id!)).toBe(false);
  });
  it("a tab in handoff returns TAB_BUSY until the user presses Done", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    const done = S.startHandoff({ tabId: t.id!, sessionId: "a", sessionLabel: "a", origin: "https://x", reason: "finish sign-in" });
    expect(S.listHandoffs()).toHaveLength(1);
    await expect(S.resolveTab(s, t.id)).rejects.toMatchObject({ code: "TAB_BUSY" });
    await expect(S.resolveTab(s)).rejects.toMatchObject({ code: "TAB_BUSY" });
    expect(S.endHandoff(t.id!, "done")).toBe(true);
    expect(await done).toBe("done");
    expect(S.endHandoff(t.id!, "done")).toBe(false);
    expect(await S.resolveTab(s, t.id)).toBe(t.id);
  });
  it("kill ends every open handoff", async () => {
    const p1 = S.startHandoff({ tabId: 1, sessionId: "a", sessionLabel: "a", origin: "https://x", reason: "r" });
    const p2 = S.startHandoff({ tabId: 2, sessionId: "a", sessionLabel: "a", origin: "https://x", reason: "r" });
    S.endAllHandoffs();
    expect(await Promise.all([p1, p2])).toEqual(["cancel", "cancel"]);
    expect(S.listHandoffs()).toEqual([]);
  });
});
