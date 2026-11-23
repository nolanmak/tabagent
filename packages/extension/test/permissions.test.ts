import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChrome } from "./fakes/chrome";

const fake = installChrome();
let P: typeof import("../src/background/permissions");
let Set_: typeof import("../src/background/settings");

const A = "https://a.example";
const meta = (id = "s1") => ({ id, label: "bot", cap: "full" as const, sites: [] as string[] });

beforeAll(async () => {
  P = await import("../src/background/permissions");
  Set_ = await import("../src/background/settings");
});

beforeEach(async () => {
  await Set_.updateSettings({ devAllowSensitive: false });
});

describe("gate (D17 interim): requireSite", () => {
  it("any level on an ordinary page passes without a prompt", async () => {
    for (const l of ["read", "act", "full"] as const) await P.requireSite(meta(), `${A}/x`, l, "nav.goto", "open");
  });
  it("browser pages are PERMISSION_DENIED", async () => {
    await expect(P.requireSite(meta(), "chrome://settings", "read", "page.snapshot", "")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("gate (D17 interim): requireSensitive", () => {
  it("every category is refused unless devAllowSensitive", async () => {
    for (const c of ["a", "b", "c", "d", "e", "f"] as const) {
      await expect(P.requireSensitive(meta(), `${A}/`, c, "t", "summary", [])).rejects.toMatchObject({ code: "PERMISSION_DENIED", hint: expect.stringContaining("devAllowSensitive") });
    }
    await Set_.updateSettings({ devAllowSensitive: true });
    for (const c of ["a", "b", "c", "d", "e", "f"] as const) await P.requireSensitive(meta(), `${A}/`, c, "t", "summary", []);
  });
  it("authorize is the same chokepoint", async () => {
    await expect(P.authorize({ meta: meta(), url: `${A}/`, level: "act", sensitive: "e", tool: "act.upload", summary: "", reasons: [] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await P.authorize({ meta: meta(), url: `${A}/`, level: "act", tool: "act.click", summary: "", reasons: [] });
  });
  it("effectivePolicy reports the interim policy", async () => {
    expect(await P.effectivePolicy(`${A}/`)).toMatchObject({ origin: A, policy: "full", sensitiveAllowed: false });
    await Set_.updateSettings({ devAllowSensitive: true });
    expect((await P.effectivePolicy(`${A}/`)).sensitiveAllowed).toBe(true);
  });
});

describe("settings module", () => {
  it("persists to storage.local; legacy autoAcceptBeforeUnload folds into beforeUnload", async () => {
    await Set_.updateSettings({ autoAcceptBeforeUnload: false });
    expect((await Set_.getSettings()).beforeUnload).toBe("dismiss");
    expect((await fake.chrome.storage.local.get("settings")).settings.beforeUnload).toBe("dismiss");
    await Set_.updateSettings({ beforeUnload: "accept" });
    expect((await Set_.getSettings()).autoAcceptBeforeUnload).toBe(true);
  });
});
