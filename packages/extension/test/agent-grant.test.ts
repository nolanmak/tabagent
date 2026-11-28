// Send to agent P2b (#97, spec AD11): the tab grant on Send. A user-initiated Send is the attach consent
// (amends D9/D18f): the worker attaches the tab to the linked agent's session with no prompt, or refuses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installChrome } from "./fakes/chrome";
import { grantRefusal } from "../src/pure/grant";

vi.mock("../src/background/cdp", () => ({ detachTab: vi.fn(async () => {}) }));
vi.mock("../src/background/driver", () => ({ disposeDrivers: vi.fn() }));

const fake = installChrome();
let S: typeof import("../src/background/sessions");
let G: typeof import("../src/background/agentGrant");
let settings: typeof import("../src/background/settings");

const meta = (id: string, over: Partial<{ cap: "read" | "act" | "full"; sites: string[] }> = {}) => ({ id, label: id, cap: "full" as const, sites: [] as string[], ...over });

beforeAll(async () => {
  S = await import("../src/background/sessions");
  G = await import("../src/background/agentGrant");
  settings = await import("../src/background/settings");
});

beforeEach(async () => {
  S.__resetForTests();
  fake.tabs.clear();
  fake.groups.clear();
  fake.calls.length = 0;
  fake.chrome.storage.session._reset();
  fake.chrome.storage.local._reset();
  await settings.updateSettings({ paused: false });
});

describe("grantRefusal (pure decision table, AD11)", () => {
  const base = { sessionId: "a", sites: [] as string[], paused: false, isPrivate: false, inHandoff: false, owner: undefined as string | undefined, url: "https://docs.test/a" as string | null };
  it.each([
    ["a free tab", {}, null],
    ["a tab this session already owns", { owner: "a" }, null],
    ["paused (kill switch)", { paused: true }, "PAUSED"],
    ["a private sign-in tab", { isPrivate: true }, "PERMISSION_DENIED"],
    ["a tab in a handoff", { inHandoff: true }, "TAB_BUSY"],
    ["a tab owned by another session", { owner: "b" }, "TAB_BUSY"],
    ["a closed tab", { url: null }, "NOT_FOUND"],
    ["a token whose sites do not cover the tab", { sites: ["other.test"] }, "PERMISSION_DENIED"],
    ["a token whose sites cover the tab", { sites: ["*.docs.test", "docs.test"] }, null],
    ["a token-scoped session on a blank tab", { sites: ["other.test"], url: "about:blank" }, null],
  ] as const)("%s", (_name, over, code) => {
    expect(grantRefusal({ ...base, ...over })).toBe(code);
  });
  it("a private tab wins over a busy one (never reveal it as owned)", () => {
    expect(grantRefusal({ ...base, isPrivate: true, owner: "b" })).toBe("PERMISSION_DENIED");
  });
});

describe("grantTab (the agent.grant handler's worker side)", () => {
  it("attaches the tab to the session's group, marked attached and active, with no prompt", async () => {
    const u = fake.addUserTab("https://docs.test/a");
    const r = await G.grantTab(meta("mcp:local:1"), u.id);
    expect(r).toEqual({ ok: true, added: true });
    const s = S.sessionById("mcp:local:1")!;
    expect(s.tabIds).toEqual([u.id]);
    expect(s.attached).toEqual([u.id]);
    expect(s.active).toBe(u.id);
    expect(fake.tabs.get(u.id)!.groupId).toBe(s.groupId);
    expect(S.ownerOf(u.id)).toBe("mcp:local:1");
    // D10: never focuses or activates anything.
    expect(fake.calls.some((c) => c.startsWith("tabs.update") || c.startsWith("windows.update"))).toBe(false);
  });

  it("makes the granted tab the session's active tab even when it already has tabs", async () => {
    const s = await S.getSession(meta("a"));
    const own = await S.newTab(s);
    const u = fake.addUserTab("https://docs.test/a");
    await G.grantTab(meta("a"), u.id);
    expect(s.active).toBe(u.id);
    expect(s.tabIds).toEqual([own.id, u.id]);
    // The resolver now uses it with no tabId, and with its tabId (the next tool call works).
    expect(await S.resolveTab(s)).toBe(u.id);
    expect(await S.resolveTab(s, u.id)).toBe(u.id);
  });

  it("a tab already in the session: ok, but not newly added", async () => {
    const u = fake.addUserTab("https://docs.test/a");
    await G.grantTab(meta("a"), u.id);
    expect(await G.grantTab(meta("a"), u.id)).toEqual({ ok: true, added: false });
  });

  it("TAB_BUSY when another session owns the tab; nothing changes", async () => {
    const b = await S.getSession(meta("b"));
    const t = await S.newTab(b);
    expect(await G.grantTab(meta("a"), t.id!)).toEqual({ ok: false, code: "TAB_BUSY" });
    expect(S.ownerOf(t.id!)).toBe("b");
    expect(S.sessionById("a")).toBeUndefined();
  });

  it("TAB_BUSY while the tab is handed to the user", async () => {
    const u = fake.addUserTab("https://docs.test/a");
    void S.startHandoff({ tabId: u.id, sessionId: "x", sessionLabel: "x", origin: "https://docs.test", reason: "sign in" });
    expect(await G.grantTab(meta("a"), u.id)).toEqual({ ok: false, code: "TAB_BUSY" });
    expect(S.ownerOf(u.id)).toBeUndefined();
    S.endHandoff(u.id, "cancel");
  });

  it("PERMISSION_DENIED for a private sign-in tab", async () => {
    const u = fake.addUserTab("https://login.test/");
    await S.markPrivateTab(u.id);
    expect(await G.grantTab(meta("a"), u.id)).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(S.ownerOf(u.id)).toBeUndefined();
  });

  it("NOT_FOUND for a closed tab", async () => {
    expect(await G.grantTab(meta("a"), 9999)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(S.sessionById("a")).toBeUndefined();
  });

  it("a token-capped session: refused with PERMISSION_DENIED when the tab is outside the token's sites", async () => {
    const u = fake.addUserTab("https://bank.test/");
    expect(await G.grantTab(meta("mcp:ci:1", { cap: "read", sites: ["docs.test"] }), u.id)).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(S.ownerOf(u.id)).toBeUndefined();
    const ok = fake.addUserTab("https://docs.test/x");
    expect(await G.grantTab(meta("mcp:ci:1", { cap: "read", sites: ["docs.test"] }), ok.id)).toEqual({ ok: true, added: true });
    // The session keeps the token's limits for every later command.
    expect(S.sessionById("mcp:ci:1")!.meta).toMatchObject({ cap: "read", sites: ["docs.test"] });
  });

  it("PAUSED while the kill switch is on", async () => {
    await settings.updateSettings({ paused: true });
    const u = fake.addUserTab("https://docs.test/a");
    expect(await G.grantTab(meta("a"), u.id)).toEqual({ ok: false, code: "PAUSED" });
    expect(S.ownerOf(u.id)).toBeUndefined();
  });
});

describe("releaseGrantedTab (an expired piggyback message, AD11)", () => {
  it("ungroups the granted tab and leaves it open; the session no longer owns it", async () => {
    const u = fake.addUserTab("https://docs.test/a");
    await G.grantTab(meta("a"), u.id);
    expect(await G.releaseGrantedTab("a", u.id)).toBe(true);
    expect(fake.tabs.has(u.id)).toBe(true);
    expect(fake.calls).toContain(`tabs.ungroup ${u.id}`);
    expect(fake.calls.some((c) => c.startsWith("tabs.remove"))).toBe(false);
    expect(S.ownerOf(u.id)).toBeUndefined();
    const s = S.sessionById("a")!;
    expect(s.tabIds).toEqual([]);
    expect(s.attached).toEqual([]);
    expect(s.active).toBeUndefined();
  });

  it("never touches a tab the session created itself, another session's tab, or an unknown session", async () => {
    const s = await S.getSession(meta("a"));
    const own = await S.newTab(s);
    expect(await G.releaseGrantedTab("a", own.id!)).toBe(false);
    expect(S.ownerOf(own.id!)).toBe("a");
    const u = fake.addUserTab("https://docs.test/a");
    await G.grantTab(meta("b"), u.id);
    expect(await G.releaseGrantedTab("a", u.id)).toBe(false);
    expect(await G.releaseGrantedTab("nobody", u.id)).toBe(false);
    expect(S.ownerOf(u.id)).toBe("b");
    expect(fake.calls.some((c) => c.startsWith("tabs.ungroup") || c.startsWith("tabs.remove"))).toBe(false);
  });
});

describe("the grant path has exactly one caller (AD11)", () => {
  it("grantTab is called only from the agent.grant handler in the worker entry", () => {
    const src = join(__dirname, "../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(src);
    const callers = files.filter((f) => !f.endsWith("agentGrant.ts") && /\bgrantTab\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => f.slice(src.length + 1))).toEqual(["background/index.ts"]);
    const index = readFileSync(join(src, "background/index.ts"), "utf8");
    expect(index.match(/\bgrantTab\(/g)).toHaveLength(1);
    expect(index).toMatch(/case "agent\.grant":[\s\S]{0,400}grantTab\(/);
  });
});
