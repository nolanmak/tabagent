import { describe, expect, it, vi } from "vitest";
import { getTool, TabAgentError, validateParams } from "@tabagent/protocol";
import { createRouter, RouterError, type AuthorizeRequest, type CommandLike, type RouterDeps } from "../src/background/router";
import { resolve, type PolicyState } from "../src/background/policy";

const meta = { id: "s1", label: "agent", cap: "full" as const, sites: [] as string[] };
const cmd = (tool: string, params: unknown = {}, id = "c1"): CommandLike => ({ type: "command", id, session: meta, tool, params });

/** Fake session/tab world + an authorize() that applies the pure policy (D17 interim when sites are empty). */
function world(over: Partial<RouterDeps<{ tabs: number[] }>> = {}, state: Partial<PolicyState> = {}) {
  const owners = new Map<number, string>([
    [1, "s1"],
    [2, "s2"],
  ]);
  const urls = new Map<number, string>([
    [1, "https://a.example/page"],
    [2, "https://a.example/other"],
    [3, "chrome://settings"],
  ]);
  const calls: string[] = [];
  const authorize = vi.fn(async (r: AuthorizeRequest) => {
    calls.push(`authorize:${r.tool}`);
    const st: PolicyState = { paused: false, sites: { "https://a.example": { policy: "full" } }, denylist: [], grants: {}, ...state };
    const d = resolve(st, { sessionId: r.meta.id, cap: r.meta.cap, sites: r.meta.sites, url: r.url, level: r.level, sensitive: r.sensitive });
    if (d.decision === "deny") throw new RouterError(d.code, d.message);
    if (d.decision === "ask") throw new RouterError("PERMISSION_DENIED", `would ask (${d.kind})`);
  });
  const handlers: Record<string, any> = {
    "page.snapshot": vi.fn(async (c) => {
      calls.push("handler");
      return { snapshot: "x", tab: c.p.tabId, __side: { snapshotDiff: "+ a" } };
    }),
    "nav.goto": vi.fn(async () => ({ url: "u" })),
    "js.eval": vi.fn(async () => ({ value: 2 })),
    "act.type": vi.fn(async () => ({ ok: true })),
    "act.click": vi.fn(async () => {
      throw new Error("boom\n    at secretFrame (file.ts:1:1)");
    }),
    "nav.wait": vi.fn(() => new Promise(() => {})),
    tabs: vi.fn(async (c) => ({ action: c.p.action, tabId: c.p.tabId })),
    "downloads.list": vi.fn(async () => ({ downloads: [] })),
  };
  const deps: RouterDeps<{ tabs: number[] }> = {
    getTool: (n) => getTool(n) as any,
    validate: (t, p) => validateParams(t as any, p),
    isPaused: () => false,
    getSession: async () => ({ tabs: [1] }),
    resolveTab: async (_s, id) => {
      if (id == null) throw new RouterError("NOT_FOUND", "This session has no tabs yet", "call tabs new");
      const o = owners.get(id);
      if (o === "s1") return id;
      if (o) throw new RouterError("TAB_BUSY", `Tab ${id} belongs to another agent session`);
      throw new RouterError("NOT_FOUND", `Tab ${id} is not in this session`);
    },
    tabUrl: async (id) => urls.get(id) ?? "",
    attachTarget: async (_m, id) => ({ tabId: id ?? 9, url: urls.get(id ?? 9) ?? "https://a.example/user", title: "User tab" }),
    downloadUrl: () => "https://a.example/file.csv",
    authorize,
    handler: (n) => handlers[n],
    feed: vi.fn(),
    ...over,
  };
  return { deps, authorize, handlers, calls, router: createRouter(deps) };
}

describe("router order and envelope", () => {
  it("unknown tool / bad params -> BAD_REQUEST; handler not called", async () => {
    const w = world();
    const r1 = await w.router.handle(cmd("no.such.tool"));
    expect(r1).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" }, audit: { tool: "no.such.tool", outcome: "error" } });
    const r2 = await w.router.handle(cmd("page.snapshot", { tabId: "x" }));
    expect(r2.error?.code).toBe("BAD_REQUEST");
    expect(w.handlers["page.snapshot"]).not.toHaveBeenCalled();
    expect(w.authorize).not.toHaveBeenCalled();
  });
  it("authorize is called exactly once before every handler", async () => {
    const w = world();
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.ok).toBe(true);
    expect(w.authorize).toHaveBeenCalledTimes(1);
    expect(w.calls).toEqual(["authorize:page.snapshot", "handler"]);
    await w.router.handle(cmd("downloads.list"));
    expect(w.authorize).toHaveBeenCalledTimes(2);
  });
  it("a deny short-circuits with PERMISSION_DENIED and the handler is not reached", async () => {
    const w = world({}, { sites: {} });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" }, audit: { outcome: "denied", errorCode: "PERMISSION_DENIED", origin: "https://a.example" } });
    expect(w.handlers["page.snapshot"]).not.toHaveBeenCalled();
  });
  it("lifts __side to top-level envelope fields and builds the audit record", async () => {
    const w = world();
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.result).toEqual({ snapshot: "x", tab: 1 });
    expect(r.snapshotDiff).toBe("+ a");
    expect(r.audit).toMatchObject({ tool: "page.snapshot", origin: "https://a.example", outcome: "ok", resultSummary: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(JSON.stringify(r.audit)).not.toContain('"snapshot":"x"');
  });
  it("feed gets a running entry then a final one with the same id", async () => {
    const w = world();
    await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    const feed = (w.deps.feed as any).mock.calls.map((c: any[]) => c[0]);
    expect(feed.map((e: any) => e.status)).toEqual(["running", "ok"]);
    expect(feed[0].id).toBe(feed[1].id);
  });
});

describe("interim policy table (D17) through the router", () => {
  it("owned tab allowed; another session's tab TAB_BUSY; unowned NOT_FOUND", async () => {
    const w = world();
    expect((await w.router.handle(cmd("page.snapshot", { tabId: 1 }))).ok).toBe(true);
    expect((await w.router.handle(cmd("page.snapshot", { tabId: 2 }))).error?.code).toBe("TAB_BUSY");
    expect((await w.router.handle(cmd("page.snapshot", { tabId: 7 }))).error?.code).toBe("NOT_FOUND");
  });
  it("chrome:// target -> PERMISSION_DENIED", async () => {
    const w = world();
    const r = await w.router.handle(cmd("nav.goto", { url: "chrome://settings" }));
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(w.handlers["nav.goto"]).not.toHaveBeenCalled();
  });
  it("each D18 static gate is refused unless devAllowSensitive", async () => {
    const off = world();
    expect((await off.router.handle(cmd("js.eval", { expression: "1", tabId: 1 }))).error?.message).toContain("would ask (sensitive)");
    const on = world({}, { devAllowSensitive: true });
    expect((await on.router.handle(cmd("js.eval", { expression: "1", tabId: 1 }))).ok).toBe(true);
  });
  it("no session tabs + tool needing a tab -> NOT_FOUND with the tabs new hint", async () => {
    const w = world();
    const r = await w.router.handle(cmd("page.snapshot"));
    expect(r.error).toMatchObject({ code: "NOT_FOUND", hint: expect.stringContaining("tabs new") });
  });
  it("nav.goto authorizes the target origin, not the current tab", async () => {
    const w = world();
    await w.router.handle(cmd("nav.goto", { url: "a.example/x" }));
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ url: "https://a.example/x", level: "act" });
  });
  it("tabs attach goes through the f gate with the target tab's url", async () => {
    const w = world({}, { devAllowSensitive: true });
    const r = await w.router.handle(cmd("tabs", { action: "attach" }));
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ sensitive: "f", level: "read", tabId: 9, summary: expect.stringContaining("User tab") });
    expect(r.error?.message).toContain("would ask (sensitive)");
    expect(w.handlers.tabs).not.toHaveBeenCalled();
  });
  it("downloads.read authorizes the download's origin for category e", async () => {
    const w = world({ handler: () => async () => ({}) }, { devAllowSensitive: true });
    const r = await w.router.handle(cmd("downloads.read", { id: 1 }));
    expect(r.ok).toBe(true);
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ url: "https://a.example/file.csv", sensitive: "e" });
  });
  it("handlers get the resolved tab in p.tabId and ctx.cmdId", async () => {
    const seen: any[] = [];
    const w = world({ handler: () => async (c) => (seen.push(c), {}) });
    await w.router.handle(cmd("page.snapshot", { tabId: 1 }, "cmd-7"));
    expect(seen[0]).toMatchObject({ tabId: 1, url: "https://a.example/page", cmdId: "cmd-7", p: { tabId: 1 } });
  });
});

describe("failures", () => {
  it("a handler that throws -> INTERNAL with no stack in message", async () => {
    const w = world();
    const r = await w.router.handle(cmd("act.click", { ref: "e1", tabId: 1 }));
    expect(r.error?.code).toBe("INTERNAL");
    expect(r.error?.message).toContain("boom");
    expect(r.error?.message).not.toContain("secretFrame");
    expect(r.error?.message).not.toContain("\n");
  });
  it("a TabAgentError keeps its code and hint", async () => {
    const w = world({ handler: () => async () => Promise.reject(new TabAgentError("REF_STALE", "stale", "snapshot again")) });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.error).toMatchObject({ code: "REF_STALE", message: "stale", hint: "snapshot again" });
  });
  it("paused -> KILLED before anything else", async () => {
    const w = world({ isPaused: () => true });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.error?.code).toBe("KILLED");
    expect(w.authorize).not.toHaveBeenCalled();
  });
  it("missing handler -> UNSUPPORTED", async () => {
    const w = world({ handler: () => undefined });
    expect((await w.router.handle(cmd("page.snapshot", { tabId: 1 }))).error?.code).toBe("UNSUPPORTED");
  });
  it("kill aborts in-flight commands with KILLED immediately", async () => {
    let n = -1;
    const w = world({ onInflight: (x) => (n = x) });
    const p = w.router.handle(cmd("nav.wait", { for: "text", value: "never", tabId: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(w.router.inflightCount()).toBe(1);
    expect(n).toBe(1);
    w.router.abortAll();
    const r = await p;
    expect(r.error?.code).toBe("KILLED");
    expect(w.router.inflightCount()).toBe(0);
    expect(n).toBe(0);
  });
});

describe("redaction in feed + audit", () => {
  it("sensitivePaths masks a password typed by ref; card-like values always masked", async () => {
    const w = world({ sensitivePaths: async (tool) => (tool === "act.type" ? ["text"] : []) });
    const r = await w.router.handle(cmd("act.type", { ref: "e3", text: "hunter2", tabId: 1 }));
    expect(JSON.stringify(r.audit)).not.toContain("hunter2");
    const feed = JSON.stringify((w.deps.feed as any).mock.calls);
    expect(feed).not.toContain("hunter2");
  });
  it("sensitivePaths failure falls back to key/value heuristics", async () => {
    const w = world({ sensitivePaths: async () => Promise.reject(new Error("x")) });
    const r = await w.router.handle(cmd("act.type", { ref: "e3", text: "4242424242424242", tabId: 1 }));
    expect(JSON.stringify(r.audit)).not.toContain("4242424242424242");
  });
  it("holdApproval is taken after a static gate and released after the handler", async () => {
    const release = vi.fn();
    const hold = vi.fn(() => release);
    const w = world({ holdApproval: hold }, { devAllowSensitive: true });
    await w.router.handle(cmd("js.eval", { expression: "1", tabId: 1 }));
    expect(hold).toHaveBeenCalledWith("s1", "https://a.example", "c");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
