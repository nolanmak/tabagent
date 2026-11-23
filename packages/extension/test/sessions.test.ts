import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChrome } from "./fakes/chrome";

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

describe("sessions + tab ownership (D8-D11)", () => {
  it("tabs new opens a background tab owned by the session; no tab group before #5", async () => {
    const s = await S.getSession(meta("a", "alpha"));
    const t1 = await S.newTab(s);
    const t2 = await S.newTab(s);
    expect(s.tabIds).toEqual([t1.id, t2.id]);
    expect(s.active).toBe(t2.id);
    expect(S.ownerOf(t1.id!)).toBe("a");
    expect(fake.groups.size).toBe(0);
    expect(fake.calls.filter((c) => c.startsWith("tabs.create")).every((c) => c.endsWith("active=false"))).toBe(true);
  });
  it("session B naming a tab owned by A -> TAB_BUSY; a tab owned by nobody -> NOT_FOUND", async () => {
    const a = await S.getSession(meta("a"));
    const b = await S.getSession(meta("b"));
    const t = await S.newTab(a);
    await expect(S.resolveTab(b, t.id)).rejects.toMatchObject({ code: "TAB_BUSY" });
    const u = fake.addUserTab("https://u.example/");
    await expect(S.resolveTab(b, u.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(S.addTab(b, t.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
    expect(await S.resolveTab(a, t.id)).toBe(t.id);
  });
  it("no tabs -> NOT_FOUND with the tabs new hint; create=true makes one", async () => {
    const s = await S.getSession(meta("a"));
    await expect(S.resolveTab(s)).rejects.toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("tabs new") });
    const id = await S.resolveTab(s, undefined, true);
    expect(s.tabIds).toEqual([id]);
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
  it("ownership survives a simulated service-worker restart (storage.session)", async () => {
    const s = await S.getSession(meta("a", "alpha"));
    const t = await S.newTab(s);
    const closed = await S.newTab(s);
    S.__resetForTests(); // in-memory state gone
    fake.tabs.delete(closed.id!); // a tab closed while the worker slept
    await S.restoreSessions();
    expect(S.ownerOf(t.id!)).toBe("a");
    const again = await S.getSession(meta("a", "alpha"));
    expect(again.tabIds).toEqual([t.id]);
    expect(again.active).toBe(t.id);
    expect(S.listSessions()[0]).toMatchObject({ label: "alpha", tabs: 1 });
  });
  it("closing a tab removes it from its session (also via tabs.onRemoved)", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    await S.removeTab(t.id!);
    expect(s.tabIds).toEqual([]);
    expect(s.active).toBeUndefined();
    const t2 = await S.newTab(s);
    await fake.chrome.tabs.remove(t2.id);
    fake.ev.tabsRemoved.fire(t2.id);
    await tick();
    expect(S.ownerOf(t2.id!)).toBeUndefined();
    expect(s.tabIds).toEqual([]);
  });
  it("session end releases its tabs and leaves them open", async () => {
    const s = await S.getSession(meta("a"));
    const t = await S.newTab(s);
    expect(await S.endSession("a")).toBe(true);
    expect(fake.tabs.has(t.id!)).toBe(true);
    expect(S.ownerOf(t.id!)).toBeUndefined();
    expect(S.listSessions()).toEqual([]);
    expect(await S.endSession("a")).toBe(false);
  });
});
