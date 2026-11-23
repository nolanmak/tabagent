import { describe, expect, it, vi } from "vitest";
import { getTool, TabAgentError, validateParams, type ToolDef } from "@tabagent/protocol";
import { createRouter, RouterError, type AuthorizeRequest, type CommandLike, type RouterDeps } from "../src/background/router";
import { resolve, type PolicyState, type SensitiveCategory, type TabOwnership } from "../src/background/policy";

const meta = { id: "s1", label: "agent", cap: "full" as const, sites: [] as string[] };
const cmd = (tool: string, params: unknown = {}, id = "c1"): CommandLike => ({ type: "command", id, session: meta, tool, params });

/** A registry-shaped tool carrying a D18 category (no M0 tool has one; later milestones add them). */
const gated = (name: string, sensitive: SensitiveCategory, level: "read" | "act" | "full" = "full") => ({ ...(getTool("nav.reload") as ToolDef), name, level, sensitive });
const FAKE_TOOLS: Record<string, unknown> = {
  "x.eval": gated("x.eval", "c"),
  "x.cookies": gated("x.cookies", "d"),
  "x.submit": gated("x.submit", "a", "act"),
  "x.click": gated("x.click", "b", "act"),
  "x.upload": gated("x.upload", "e", "act"),
  "x.attach": gated("x.attach", "f", "read"),
};

/** Fake session/tab world + an authorize() that applies the pure D17 interim policy. */
function world(over: Partial<RouterDeps<{ tabs: number[] }>> = {}, state: PolicyState = {}) {
  const owners = new Map<number, string>([
    [1, "s1"],
    [2, "s2"],
    [3, "s1"],
  ]);
  const urls = new Map<number, string>([
    [1, "https://a.example/page"],
    [2, "https://a.example/other"],
    [3, "chrome://settings"],
  ]);
  const calls: string[] = [];
  const authorize = vi.fn(async (r: AuthorizeRequest) => {
    calls.push(`authorize:${r.tool}`);
    const o = r.tabId == null ? undefined : owners.get(r.tabId);
    const tab: TabOwnership = r.tabId == null ? "none" : o === r.meta.id ? "own" : o ? "other" : "nobody";
    const d = resolve(state, { url: r.url, level: r.level, sensitive: r.sensitive, tab });
    if (d.decision === "deny") throw new RouterError(d.code, d.message, d.hint);
  });
  const handler = vi.fn(async (c: any) => {
    calls.push("handler");
    return { tool: c.tool.name, tab: c.p.tabId, __side: { navigation: { url: "u", title: "t", kind: "back" } } };
  });
  const deps: RouterDeps<{ tabs: number[] }> = {
    getTool: (n) => (FAKE_TOOLS[n] ?? getTool(n)) as any,
    validate: (t, p) => validateParams(t as any, p),
    getSession: async () => ({ tabs: [1] }),
    resolveTab: async (_s, id) => {
      if (id == null) throw new RouterError("NOT_FOUND", "This session has no tabs yet", "call tabs new");
      const o = owners.get(id);
      if (o === "s1") return id;
      if (o) throw new RouterError("TAB_BUSY", `Tab ${id} belongs to another agent session`);
      throw new RouterError("NOT_FOUND", `Tab ${id} is not in this session`);
    },
    tabUrl: async (id) => urls.get(id) ?? "",
    authorize,
    handler: () => handler,
    ...over,
  };
  return { deps, authorize, handler, calls, router: createRouter(deps) };
}

describe("router order and envelope", () => {
  it("unknown tool / bad params -> BAD_REQUEST; handler not called", async () => {
    const w = world();
    const r1 = await w.router.handle(cmd("no.such.tool"));
    expect(r1).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" }, audit: { tool: "no.such.tool", outcome: "error" } });
    const r2 = await w.router.handle(cmd("nav.back", { tabId: "x" }));
    expect(r2.error?.code).toBe("BAD_REQUEST");
    const r3 = await w.router.handle(cmd("tabs", { action: "attach" }));
    expect(r3.error?.code).toBe("BAD_REQUEST");
    expect(w.handler).not.toHaveBeenCalled();
    expect(w.authorize).not.toHaveBeenCalled();
  });
  it("authorize is called exactly once before every handler", async () => {
    const w = world();
    const r = await w.router.handle(cmd("nav.back", { tabId: 1 }));
    expect(r.ok).toBe(true);
    expect(w.authorize).toHaveBeenCalledTimes(1);
    expect(w.calls).toEqual(["authorize:nav.back", "handler"]);
    for (const [tool, p] of [
      ["tabs", { action: "list" }],
      ["tabs", { action: "new" }],
      ["tabs", { action: "select", tabId: 1 }],
      ["tabs", { action: "close", tabId: 1 }],
      ["nav.goto", { url: "https://a.example/" }],
      ["nav.forward", { tabId: 1 }],
      ["nav.reload", { tabId: 1 }],
    ] as const) {
      const before = w.calls.length;
      await w.router.handle(cmd(tool, p));
      expect(w.calls.slice(before), `${tool} ${JSON.stringify(p)}`).toEqual([`authorize:${tool}`, "handler"]);
    }
  });
  it("a deny short-circuits with PERMISSION_DENIED and the handler is not reached", async () => {
    const w = world();
    const r = await w.router.handle(cmd("nav.reload", { tabId: 3 }));
    expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" }, audit: { outcome: "denied", errorCode: "PERMISSION_DENIED", origin: null } });
    expect(w.handler).not.toHaveBeenCalled();
  });
  it("lifts __side to top-level envelope fields and builds the audit record", async () => {
    const w = world();
    const r = await w.router.handle(cmd("nav.back", { tabId: 1 }));
    expect(r.result).toEqual({ tool: "nav.back", tab: 1 });
    expect(r.navigation).toEqual({ url: "u", title: "t", kind: "back" });
    expect(r.audit).toMatchObject({ tool: "nav.back", origin: "https://a.example", outcome: "ok", resultSummary: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(JSON.stringify(r.audit)).not.toContain('"tool":"nav.back","tab"');
  });
  it("tabs records its action in the audit record", async () => {
    const w = world();
    const r = await w.router.handle(cmd("tabs", { action: "list" }));
    expect(r.audit).toMatchObject({ tool: "tabs", action: "list", origin: null });
  });
});

describe("interim policy table (D17) through the router", () => {
  it("owned tab allowed; another session's tab TAB_BUSY; unowned NOT_FOUND", async () => {
    const w = world();
    expect((await w.router.handle(cmd("nav.reload", { tabId: 1 }))).ok).toBe(true);
    expect((await w.router.handle(cmd("nav.reload", { tabId: 2 }))).error?.code).toBe("TAB_BUSY");
    expect((await w.router.handle(cmd("nav.reload", { tabId: 7 }))).error?.code).toBe("NOT_FOUND");
    expect((await w.router.handle(cmd("nav.goto", { url: "https://a.example/", tabId: 2 }))).error?.code).toBe("TAB_BUSY");
    expect(w.handler).toHaveBeenCalledTimes(1);
  });
  it("authorize itself refuses a tab the session does not own, even if resolveTab let it through", async () => {
    const w = world({ resolveTab: async (_s, id) => id! });
    expect((await w.router.handle(cmd("nav.reload", { tabId: 2 }))).error?.code).toBe("TAB_BUSY");
    expect((await w.router.handle(cmd("nav.reload", { tabId: 7 }))).error?.code).toBe("NOT_FOUND");
    expect(w.handler).not.toHaveBeenCalled();
  });
  it.each(["chrome://settings", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/x", "devtools://devtools/x", "javascript:alert(1)"])(
    "nav.goto %s -> PERMISSION_DENIED",
    async (url) => {
      const w = world({}, { devAllowSensitive: true });
      const r = await w.router.handle(cmd("nav.goto", { url }));
      expect(r.error?.code).toBe("PERMISSION_DENIED");
      expect(w.handler).not.toHaveBeenCalled();
    },
  );
  it("tabs new with a hard-denied url is refused; without a url it is allowed", async () => {
    const w = world();
    expect((await w.router.handle(cmd("tabs", { action: "new", url: "chrome://settings" }))).error?.code).toBe("PERMISSION_DENIED");
    expect((await w.router.handle(cmd("tabs", { action: "new" }))).ok).toBe(true);
    expect((await w.router.handle(cmd("tabs", { action: "new", url: "https://a.example/" }))).ok).toBe(true);
  });
  it.each(Object.keys(FAKE_TOOLS))("D18 gated effect %s is refused with PERMISSION_DENIED unless devAllowSensitive", async (tool) => {
    const off = world();
    const r = await off.router.handle(cmd(tool, { tabId: 1 }));
    expect(r.error).toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("needs the user's approval") });
    expect(off.handler).not.toHaveBeenCalled();
    const on = world({}, { devAllowSensitive: true });
    expect((await on.router.handle(cmd(tool, { tabId: 1 }))).ok).toBe(true);
  });
  it("devAllowSensitive never unlocks browser pages", async () => {
    const w = world({}, { devAllowSensitive: true });
    expect((await w.router.handle(cmd("x.eval", { tabId: 3 }))).error?.code).toBe("PERMISSION_DENIED");
  });
  it("no session tabs + tool needing a tab -> NOT_FOUND with the tabs new hint", async () => {
    const w = world();
    const r = await w.router.handle(cmd("nav.reload"));
    expect(r.error).toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("tabs new") });
    expect(w.authorize).not.toHaveBeenCalled();
  });
  it("nav.goto authorizes the target origin, not the current tab", async () => {
    const w = world();
    await w.router.handle(cmd("nav.goto", { url: "a.example/x" }));
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ url: "https://a.example/x", level: "act" });
    await w.router.handle(cmd("nav.goto", { url: "https://b.example/", tabId: 1 }));
    expect(w.authorize.mock.calls[1][0]).toMatchObject({ url: "https://b.example/", tabId: 1 });
  });
  it("handlers get the resolved tab in p.tabId and ctx.cmdId", async () => {
    const seen: any[] = [];
    const w = world({ handler: () => async (c) => (seen.push(c), {}) });
    await w.router.handle(cmd("nav.reload", { tabId: 1 }, "cmd-7"));
    expect(seen[0]).toMatchObject({ tabId: 1, url: "https://a.example/page", cmdId: "cmd-7", p: { tabId: 1 } });
  });
});

describe("failures", () => {
  it("a handler that throws -> INTERNAL with no stack in message", async () => {
    const w = world({
      handler: () => async () => {
        throw new Error("boom\n    at secretFrame (file.ts:1:1)");
      },
    });
    const r = await w.router.handle(cmd("nav.reload", { tabId: 1 }));
    expect(r.error?.code).toBe("INTERNAL");
    expect(r.error?.message).toContain("boom");
    expect(r.error?.message).not.toContain("secretFrame");
    expect(r.error?.message).not.toContain("\n");
  });
  it("a TabAgentError keeps its code and hint", async () => {
    const w = world({ handler: () => async () => Promise.reject(new TabAgentError("TIMEOUT", "slow", "try again")) });
    const r = await w.router.handle(cmd("nav.reload", { tabId: 1 }));
    expect(r.error).toMatchObject({ code: "TIMEOUT", message: "slow", hint: "try again" });
  });
  it("missing handler -> UNSUPPORTED", async () => {
    const w = world({ handler: () => undefined });
    expect((await w.router.handle(cmd("nav.reload", { tabId: 1 }))).error?.code).toBe("UNSUPPORTED");
  });
  it("audit params are redacted (a card-like value never reaches the record)", async () => {
    const w = world();
    const r = await w.router.handle(cmd("tabs", { action: "new", url: "4242424242424242" }));
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(r.audit)).not.toContain("4242424242424242");
  });
});
