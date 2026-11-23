import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChrome } from "./fakes/chrome";

const fake = installChrome();
let P: typeof import("../src/background/permissions");
let S: typeof import("../src/background/sessions");
let Set_: typeof import("../src/background/settings");

const meta = (id: string) => ({ id, label: id, cap: "full" as const, sites: [] as string[] });

beforeAll(async () => {
  P = await import("../src/background/permissions");
  S = await import("../src/background/sessions");
  Set_ = await import("../src/background/settings");
});

beforeEach(async () => {
  S.__resetForTests();
  fake.tabs.clear();
  fake.chrome.storage.session._reset();
  await Set_.updateSettings({ devAllowSensitive: false });
});

describe("authorize() gate (D17) with live settings and tab ownership", () => {
  it("allows the session's own tab, refuses others' and unowned tabs", async () => {
    const a = await S.getSession(meta("a"));
    await S.getSession(meta("b"));
    const t = await S.newTab(a);
    const g = { url: "https://a.example/", level: "act" as const, tool: "nav.reload" };
    await expect(P.authorize({ ...g, meta: meta("a"), tabId: t.id })).resolves.toBeUndefined();
    await expect(P.authorize({ ...g, meta: meta("b"), tabId: t.id })).rejects.toMatchObject({ code: "TAB_BUSY" });
    const u = fake.addUserTab("https://u.example/");
    await expect(P.authorize({ ...g, meta: meta("a"), tabId: u.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(P.authorize({ ...g, meta: meta("a") })).resolves.toBeUndefined();
  });
  it("hard denylist and the devAllowSensitive setting", async () => {
    await expect(P.authorize({ meta: meta("a"), url: "chrome://settings", level: "act", tool: "nav.goto" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const g = { meta: meta("a"), url: "https://a.example/", level: "full" as const, sensitive: "c" as const, tool: "x.eval" };
    await expect(P.authorize(g)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await Set_.updateSettings({ devAllowSensitive: true });
    await expect(P.authorize(g)).resolves.toBeUndefined();
    expect((await Set_.getSettings()).devAllowSensitive).toBe(true);
  });
});
