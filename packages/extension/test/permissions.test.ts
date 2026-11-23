import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChrome } from "./fakes/chrome";

const fake = installChrome();
let P: typeof import("../src/background/permissions");
let Set_: typeof import("../src/background/settings");

const A = "https://a.example";
const meta = (id = "s1") => ({ id, label: "bot", cap: "full" as const, sites: [] as string[] });
const tick = () => new Promise((r) => setTimeout(r, 0));

async function nextPrompt() {
  for (let i = 0; i < 50 && !P.pendingPrompts().length; i++) await tick();
  return P.pendingPrompts()[0];
}

beforeAll(async () => {
  P = await import("../src/background/permissions");
  Set_ = await import("../src/background/settings");
});

beforeEach(async () => {
  P.denyAllPrompts();
  await P.clearGrants();
  await Set_.updateSettings({ sites: {}, devAllowSensitive: false, paused: false });
});

describe("gate: requireSite", () => {
  it("unknown origin prompts; once grants this session only; later read needs no prompt", async () => {
    const p = P.requireSite(meta(), `${A}/x`, "act", "nav.goto", "open");
    const pr = await nextPrompt();
    expect(pr).toMatchObject({ kind: "site", origin: A, level: "act", sessionLabel: "bot", promptId: expect.any(String) });
    P.answerPrompt(pr.promptId, "once");
    await p;
    await P.requireSite(meta(), `${A}/y`, "read", "page.snapshot", "");
    expect(P.pendingPrompts()).toHaveLength(0);
    expect(JSON.stringify((await fake.chrome.storage.session.get("grants")).grants)).toContain(A);
    const other = P.requireSite(meta("s2"), `${A}/x`, "read", "x", "");
    expect(await nextPrompt()).toBeTruthy();
    P.denyAllPrompts();
    await expect(other).rejects.toMatchObject({ code: "KILLED" });
  });
  it("always stores the level in sites; deny -> PERMISSION_DENIED and sticks", async () => {
    const p = P.requireSite(meta(), `${A}/`, "read", "t", "");
    P.answerPrompt((await nextPrompt()).promptId, "always");
    await p;
    expect((await Set_.getSettings()).sites[A].policy).toBe("read");
    const d = P.requireSite(meta(), `${A}/`, "act", "t", "");
    P.answerPrompt((await nextPrompt()).promptId, "deny");
    await expect(d).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(P.requireSite(meta(), `${A}/`, "act", "t", "")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(P.pendingPrompts()).toHaveLength(0);
  });
  it("kill clears allow-once grants", async () => {
    const p = P.requireSite(meta(), `${A}/`, "read", "t", "");
    P.answerPrompt((await nextPrompt()).promptId, "once");
    await p;
    await P.clearGrants();
    const again = P.requireSite(meta(), `${A}/`, "read", "t", "");
    expect(await nextPrompt()).toBeTruthy();
    P.denyAllPrompts();
    await expect(again).rejects.toMatchObject({ code: "KILLED" });
  });
  it("paused -> KILLED without a prompt", async () => {
    await Set_.updateSettings({ paused: true });
    await expect(P.requireSite(meta(), `${A}/`, "read", "t", "")).rejects.toMatchObject({ code: "KILLED" });
  });
});

describe("gate: requireSensitive", () => {
  beforeEach(async () => Set_.updateSettings({ sites: { [A]: { policy: "full" } } }));
  it("new signature asks with the category; always pre-approves that category only", async () => {
    const p = P.requireSensitive(meta(), `${A}/`, "b", "act.click", 'click "Delete"', ["looks like delete"]);
    const pr = await nextPrompt();
    expect(pr).toMatchObject({ kind: "sensitive", sensitive: { category: "b" }, reasons: ["looks like delete"] });
    P.answerPrompt(pr.promptId, "always");
    await p;
    expect((await Set_.getSettings()).sites[A].preapproved).toEqual({ b: true });
    await P.requireSensitive(meta(), `${A}/`, "b", "act.click", "again", []);
    const c = P.requireSensitive(meta(), `${A}/`, "c", "js.eval", "run", []);
    expect((await nextPrompt()).sensitive?.category).toBe("c");
    P.answerPrompt(P.pendingPrompts()[0].promptId, "deny");
    await expect(c).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("legacy signature maps to a category (form reasons -> a, attach -> f)", async () => {
    const a = P.requireSensitive(meta(), `${A}/`, "form.submit", "submit", ["submits a form with a password field"]);
    expect((await nextPrompt()).sensitive?.category).toBe("a");
    P.denyAllPrompts();
    await expect(a).rejects.toBeTruthy();
    const f = P.requireSensitive(meta(), `${A}/`, "tabs", "take over", [], "attach");
    const pr = await nextPrompt();
    expect(pr).toMatchObject({ kind: "attach", sensitive: { category: "f" } });
    P.answerPrompt(pr.promptId, "once");
    await f;
  });
  it("a router-held approval for this command skips the handler's re-check", async () => {
    const release = P.holdApproval("s1", A, "c");
    await P.requireSensitive(meta(), `${A}/`, "c", "js.eval", "run", []);
    release();
    release();
    const p = P.requireSensitive(meta(), `${A}/`, "c", "js.eval", "run", []);
    expect(await nextPrompt()).toBeTruthy();
    P.denyAllPrompts();
    await expect(p).rejects.toBeTruthy();
  });
  it("effectivePolicy and preapprovalsFor", async () => {
    await Set_.updateSettings({ sites: { [A]: { policy: "act", preapproved: { a: true } } } });
    expect(await P.effectivePolicy(`${A}/`, meta())).toMatchObject({ origin: A, policy: "act" });
    expect(await P.preapprovalsFor(`${A}/`)).toEqual({ a: true });
    expect(await P.preapprovalsFor("about:blank")).toEqual({});
  });
});

describe("settings module", () => {
  it("paused lives in storage.session", async () => {
    await Set_.updateSettings({ paused: true });
    expect((await fake.chrome.storage.session.get("paused")).paused).toBe(true);
    expect((await fake.chrome.storage.local.get("settings")).settings.paused).toBeUndefined();
    expect(await Set_.isPaused()).toBe(true);
    await Set_.updateSettings({ paused: false, autoAcceptBeforeUnload: false });
    expect((await Set_.getSettings()).beforeUnload).toBe("dismiss");
  });
});
