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
  it("a handler that signed in without asking marks the audit record authAuto (#131)", async () => {
    const w = world({ handler: (n) => (n === "page.snapshot" ? async (c: any) => (c.auditNote({ authAuto: true }), { ok: true }) : undefined) });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.audit).toMatchObject({ tool: "page.snapshot", outcome: "ok", authAuto: true });
    const plain = await world().router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(plain.audit).not.toHaveProperty("authAuto");
  });
  it("the authAuto mark survives a handler error", async () => {
    const w = world({ handler: () => async (c: any) => {
      c.auditNote({ authAuto: true });
      throw new RouterError("NOT_FOUND", "no code");
    } });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.audit).toMatchObject({ outcome: "error", authAuto: true });
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

describe("nav.wait for=fn is held to js.eval's level (security review H2)", () => {
  const readTok = { id: "s1", label: "ci", cap: "read" as const, sites: [] as string[] };
  it("a read-capped token cannot run a JS predicate, even under YOLO", async () => {
    const w = world({}, { yolo: true });
    const fn = await w.router.handle({ type: "command", id: "c1", session: readTok, tool: "nav.wait", params: { for: "fn", value: "fetch('/api/x',{method:'DELETE'}).then(()=>1)", tabId: 1 } });
    expect(fn.error?.code).toBe("PERMISSION_DENIED");
    expect(fn.error?.message).toContain('limited to "read"');
    expect(w.handlers["nav.wait"]).not.toHaveBeenCalled();
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ level: "full", sensitive: "c" });
  });
  it("a site set to read does not cover for=fn", async () => {
    const w = world({}, { sites: { "https://a.example": { policy: "read", preapproved: { c: true } } } });
    const r = await w.router.handle(cmd("nav.wait", { for: "fn", value: "true", tabId: 1 }));
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(r.error?.message).toContain("would ask (site)");
  });
});

describe("DA1 credential readback (security review H1)", () => {
  const taintedWorld = async (over: Partial<RouterDeps<{ tabs: number[] }>> = {}) => {
    const { AuthTaint, credentialGuard } = await import("../src/background/authTaint");
    const taint = new AuthTaint();
    taint.filled(1, "password", "hunter2-secret");
    // YOLO: the policy alone would allow every read below without asking.
    const w = world({ guard: (r) => credentialGuard(taint, r), leaks: (t) => taint.leaks(t), ...over }, { yolo: true });
    return { w, taint };
  };

  it("js.eval, nav.wait fn, network.get, storage.get and cookies.get are refused on the tab after a fill, even under YOLO; handler never runs", async () => {
    const { w } = await taintedWorld();
    for (const [tool, p] of [
      ["js.eval", { expression: "document.querySelector('input[type=password]').value" }],
      ["nav.wait", { for: "fn", value: "document.forms[0].password.value" }],
      ["network.get", { id: "n1" }],
      ["storage.get", { kind: "local" }],
      ["cookies.get", {}],
    ] as const) {
      const r = await w.router.handle(cmd(tool, { ...p, tabId: 1 }));
      expect(r.error?.code, tool).toBe("PERMISSION_DENIED");
    }
    expect(w.handlers["js.eval"]).not.toHaveBeenCalled();
    expect(w.handlers["nav.wait"]).not.toHaveBeenCalled();
    expect(w.authorize).not.toHaveBeenCalled(); // refused before any prompt
  });

  it("after a worker restart (state restored from storage.session) js.eval on the filled tab is still refused", async () => {
    const { AuthTaint, credentialGuard, persistAuthTaint } = await import("../src/background/authTaint");
    const mk = () => {
      const data: Record<string, unknown> = {};
      return { get: async (k: string) => (k in data ? { [k]: structuredClone(data[k]) } : {}), set: async (o: Record<string, unknown>) => void Object.assign(data, structuredClone(o)) };
    };
    const areas = { session: mk(), local: mk() };
    const old = new AuthTaint();
    await persistAuthTaint(old, areas);
    old.filled(1, "password", "hunter2-secret");
    await new Promise((r) => setTimeout(r, 0));
    const fresh = new AuthTaint();
    await persistAuthTaint(fresh, areas);
    const w = world({ guard: (r) => credentialGuard(fresh, r) }, { yolo: true });
    const r = await w.router.handle(cmd("js.eval", { expression: "document.querySelector('input[type=password]').value", tabId: 1 }));
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(w.handlers["js.eval"]).not.toHaveBeenCalled();
  });

  it("other tools on the tainted tab still work", async () => {
    const { w } = await taintedWorld();
    expect((await w.router.handle(cmd("page.snapshot", { tabId: 1 }))).ok).toBe(true);
  });

  it("any result carrying the typed secret is withheld, from every tool, and the secret reaches neither audit nor feed", async () => {
    const { w } = await taintedWorld({
      handler: () => async () => ({ snapshot: "body", __side: { navigation: { url: "https://a.example/?password=hunter2-secret", title: "t", kind: "navigate" } } }),
    });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(r)).not.toContain("hunter2-secret");
    expect(JSON.stringify((w.deps.feed as any).mock.calls)).not.toContain("hunter2-secret");
  });

  it("an error message quoting the secret is withheld too", async () => {
    const { w } = await taintedWorld({ handler: () => async () => Promise.reject(new TabAgentError("BAD_REQUEST", "The expression threw: hunter2-secret")) });
    const r = await w.router.handle(cmd("page.snapshot", { tabId: 1 }));
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(r)).not.toContain("hunter2-secret");
  });
});

describe("workflow capture hook", () => {
  it("nav.goto without tabId is captured against the session's current tab", async () => {
    const captureWorkflowStep = vi.fn(async () => undefined);
    const w = world({ captureWorkflowStep, resolveTab: async (_s, id) => id ?? 1 });
    const r = await w.router.handle(cmd("nav.goto", { url: "https://a.example/x" }));
    expect(r.ok).toBe(true);
    expect(captureWorkflowStep).toHaveBeenCalledWith(1, "nav.goto", expect.objectContaining({ url: "https://a.example/x" }), "https://a.example/x", "s1");
  });
  it("nav.goto in a session with no tabs still runs; capture gets no tab", async () => {
    const captureWorkflowStep = vi.fn(async () => undefined);
    const w = world({ captureWorkflowStep });
    const r = await w.router.handle(cmd("nav.goto", { url: "https://a.example/x" }));
    expect(r.ok).toBe(true);
    expect(captureWorkflowStep).toHaveBeenCalledWith(undefined, "nav.goto", expect.anything(), "https://a.example/x", "s1");
    expect(w.handlers["nav.goto"]).toHaveBeenCalled();
  });
});

describe("workflow.edit_draft through the router (#107)", () => {
  const id = "7b0f3c1e-2d4a-4c6b-9e8f-0a1b2c3d4e5f";
  const editWorld = () => {
    const handler = vi.fn(async () => ({ id, status: "draft", needsReview: true, steps: [] }));
    const captureWorkflowStep = vi.fn(async () => undefined);
    const w = world({ handler: (n) => (n === "workflow.edit_draft" ? handler : undefined), captureWorkflowStep, getSession: async () => ({ tabs: [] }) });
    return { ...w, handler };
  };
  it("needs no tab and no prompt: authorize sees no level and no sensitive category", async () => {
    const w = editWorld();
    const r = await w.router.handle(cmd("workflow.edit_draft", { id, ops: [{ op: "remove_step", index: 0 }] }));
    expect(r.ok).toBe(true);
    expect(w.authorize).toHaveBeenCalledWith(expect.objectContaining({ tool: "workflow.edit_draft", level: null, sensitive: undefined, url: "" }));
    expect(w.handler).toHaveBeenCalledWith(expect.objectContaining({ p: { id, ops: [{ op: "remove_step", index: 0 }] } }));
  });
  it("audits every op in the command's params", async () => {
    const w = editWorld();
    const ops = [{ op: "remove_step", index: 1 }, { op: "parameterize", index: 2, name: "SEARCH" }];
    const r = await w.router.handle(cmd("workflow.edit_draft", { id, ops }));
    expect(r.audit).toMatchObject({ tool: "workflow.edit_draft", outcome: "ok", params: { id, ops } });
  });
  it("a malformed op is BAD_REQUEST before authorize or the handler", async () => {
    const w = editWorld();
    const r = await w.router.handle(cmd("workflow.edit_draft", { id, ops: [{ op: "parameterize", index: 0, name: "lower" }] }));
    expect(r.error?.code).toBe("BAD_REQUEST");
    expect(w.authorize).not.toHaveBeenCalled();
    expect(w.handler).not.toHaveBeenCalled();
  });
});

describe("policy.site_change through the router (#104)", () => {
  const params = { origin: "https://app.example.com", changes: { auth: true }, reason: "sign in to download statements" };
  const siteWorld = (over: Partial<RouterDeps<{ tabs: number[] }>> = {}, state: Partial<PolicyState> = {}) => {
    const handler = vi.fn(async (c: any) => ({ status: "applied", snapshot: c.policySnapshot }));
    const w = world({ handler: (n) => (n === "policy.site_change" ? handler : undefined), policySnapshot: vi.fn(async () => "snap-1"), ...over }, state);
    return { ...w, handler };
  };

  it("checks the request and takes the snapshot before the prompt, then hands the snapshot to the handler", async () => {
    const order: string[] = [];
    const w = siteWorld({
      policySnapshot: vi.fn(async (tool: string) => (order.push(`snapshot:${tool}`), "snap-1")),
      authorize: vi.fn(async (r: AuthorizeRequest) => void order.push(`authorize:${r.sensitive}`)),
    });
    const r = await w.router.handle(cmd("policy.site_change", params));
    expect(r.ok).toBe(true);
    expect(order).toEqual(["snapshot:policy.site_change", "authorize:p"]);
    expect(w.handler).toHaveBeenCalledWith(expect.objectContaining({ policySnapshot: "snap-1" }));
  });

  it("the prompt is category p with the origin, each change and the reason in its summary", async () => {
    const authorize = vi.fn(async (_r: AuthorizeRequest) => {});
    const w = siteWorld({ authorize });
    await w.router.handle(cmd("policy.site_change", { origin: "https://app.example.com", changes: { auth: false, policy: "deny", lite: true }, reason: "user asked to lock this down" }));
    const req = authorize.mock.calls[0][0];
    expect(req).toMatchObject({ tool: "policy.site_change", sensitive: "p", level: "full", url: "" });
    expect(req.summary).toContain("https://app.example.com");
    expect(req.summary).toContain("turn sign-in off");
    expect(req.summary).toContain("set policy to deny");
    expect(req.summary).toContain("turn lite mode on");
    expect(req.summary).toContain("user asked to lock this down");
    expect(req.reasons.join(" ")).toMatch(/site/i);
  });

  it("a refused precheck (vault, denylisted, wildcard) never reaches the prompt or the handler", async () => {
    const w = siteWorld({
      policySnapshot: vi.fn(async () => {
        throw new TabAgentError("PERMISSION_DENIED", "blocked.example is on the TabAgent denylist", "Request policy.denylist_change first");
      }),
    });
    const r = await w.router.handle(cmd("policy.site_change", params));
    expect(r.error).toMatchObject({ code: "PERMISSION_DENIED", hint: "Request policy.denylist_change first" });
    expect(w.authorize).not.toHaveBeenCalled();
    expect(w.handler).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", "PERMISSION_DENIED"],
    ["timed out", "PROMPT_TIMEOUT"],
  ])("a %s prompt leaves the handler unrun", async (_label, errCode) => {
    const w = siteWorld({
      authorize: vi.fn(async () => {
        throw new RouterError(errCode, "no");
      }),
    });
    const r = await w.router.handle(cmd("policy.site_change", params));
    expect(r.error?.code).toBe(errCode);
    expect(w.handler).not.toHaveBeenCalled();
  });

  it("YOLO and developer mode do not skip the category p prompt", async () => {
    // world()'s default authorize applies the pure policy and turns an ask into PERMISSION_DENIED.
    const w = siteWorld({}, { yolo: true, devAllowSensitive: true });
    const r = await w.router.handle(cmd("policy.site_change", params));
    expect(r.error?.message).toContain("would ask (sensitive)");
    expect(w.handler).not.toHaveBeenCalled();
  });

  it("empty change sets, unknown policies and empty reasons are refused by the schema", async () => {
    const w = siteWorld();
    expect((await w.router.handle(cmd("policy.site_change", { ...params, changes: {} }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.site_change", { ...params, changes: { policy: "always" } }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.site_change", { ...params, reason: "" }))).error?.code).toBe("BAD_REQUEST");
    expect(w.authorize).not.toHaveBeenCalled();
  });

  it("policy.denylist_change still gets its snapshot", async () => {
    const policySnapshot = vi.fn(async () => "deny-snap");
    const handler = vi.fn(async (c: any) => ({ status: "applied", denylist: [], applied: [], s: c.policySnapshot }));
    const w = world({ handler: () => handler, policySnapshot, authorize: vi.fn(async () => {}) });
    await w.router.handle(cmd("policy.denylist_change", { changes: [{ op: "add", glob: "x.example" }], reason: "r" }));
    expect(policySnapshot).toHaveBeenCalledWith("policy.denylist_change", expect.objectContaining({ reason: "r" }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ policySnapshot: "deny-snap" }));
  });
});

describe("session.kill_all through the router (#106)", () => {
  const killWorld = (over: Partial<RouterDeps<{ tabs: number[] }>> = {}) => {
    const getSession = vi.fn(async () => ({ tabs: [1] }));
    const killAll = vi.fn(async () => ({ status: "killed" as const, alreadyPaused: false }));
    const w = world({ getSession, killAll, ...over });
    return { ...w, getSession, killAll: (over.killAll as typeof killAll) ?? killAll };
  };

  it("stops everything with no prompt, no token-cap check and no session", async () => {
    const w = killWorld();
    const r = await w.router.handle({ ...cmd("session.kill_all"), session: { ...meta, cap: "read" as any, sites: ["only.example"] } });
    expect(r).toMatchObject({ ok: true, result: { status: "killed", alreadyPaused: false }, audit: { tool: "session.kill_all", outcome: "ok" } });
    expect(w.killAll).toHaveBeenCalledTimes(1);
    expect(w.killAll).toHaveBeenCalledWith(expect.objectContaining({ label: "agent" }));
    expect(w.authorize).not.toHaveBeenCalled();
    expect(w.getSession).not.toHaveBeenCalled();
  });

  it("still answers when agents are already stopped (idempotent), instead of KILLED", async () => {
    const killAll = vi.fn(async () => ({ status: "killed" as const, alreadyPaused: true }));
    const w = killWorld({ isPaused: () => true, killAll });
    const r = await w.router.handle(cmd("session.kill_all"));
    expect(r).toMatchObject({ ok: true, result: { alreadyPaused: true } });
  });

  it("is not aborted by its own kill: other in-flight commands end KILLED, kill_all returns ok", async () => {
    const ref: { router?: ReturnType<typeof createRouter<{ tabs: number[] }>> } = {};
    const killAll = vi.fn(async () => {
      ref.router!.abortAll();
      return { status: "killed" as const, alreadyPaused: false };
    });
    const w = killWorld({ killAll });
    const router = (ref.router = w.router);
    const pending = router.handle(cmd("nav.wait", { tabId: 1, for: "text", value: "x" }, "long"));
    await new Promise((r) => setTimeout(r, 5));
    const k = await router.handle(cmd("session.kill_all", {}, "kill"));
    expect(k.ok).toBe(true);
    expect((await pending).error?.code).toBe("KILLED");
    expect(router.inflightCount()).toBe(0);
  });

  it("an extension without the kill hook answers UNSUPPORTED", async () => {
    const w = world();
    expect((await w.router.handle(cmd("session.kill_all"))).error?.code).toBe("UNSUPPORTED");
  });

  it("after a kill every other tool, including settings.get and settings.change, is KILLED", async () => {
    const w = world({ isPaused: () => true });
    for (const [tool, p] of [["settings.get", {}], ["settings.change", { changes: { showOverlay: true } }], ["page.snapshot", { tabId: 1 }]] as const) {
      expect((await w.router.handle(cmd(tool, p))).error?.code, tool).toBe("KILLED");
    }
  });
});

describe("settings.get / settings.change through the router (#105, #106)", () => {
  const snapshot = { denylist: [], sites: {} };
  const settingsWorld = (over: Partial<RouterDeps<{ tabs: number[] }>> = {}) => {
    const get = vi.fn(async () => snapshot);
    const change = vi.fn(async (c: any) => ({ status: "applied", applied: Object.keys(c.p.changes) }));
    const w = world({ handler: (n) => (n === "settings.get" ? get : n === "settings.change" ? change : undefined), ...over });
    return { ...w, get, change };
  };

  it("settings.get needs no tab, no prompt and works for a read-only token", async () => {
    const w = settingsWorld();
    const r = await w.router.handle({ ...cmd("settings.get"), session: { ...meta, cap: "read" as any } });
    expect(r).toMatchObject({ ok: true, result: snapshot });
    expect(w.authorize).toHaveBeenCalledWith(expect.objectContaining({ tool: "settings.get", level: null, url: "" }));
    expect(w.authorize.mock.calls[0][0].sensitive).toBeUndefined();
  });

  it("settings.change has no prompt but needs an act-capable token", async () => {
    const w = settingsWorld();
    const ok = await w.router.handle(cmd("settings.change", { changes: { showOverlay: false } }));
    expect(ok.ok).toBe(true);
    expect(w.authorize.mock.calls[0][0]).toMatchObject({ level: "act", url: "" });
    expect(w.authorize.mock.calls[0][0].sensitive).toBeUndefined();
    const denied = await w.router.handle({ ...cmd("settings.change", { changes: { showOverlay: false } }, "c2"), session: { ...meta, cap: "read" as any } });
    expect(denied.error?.code).toBe("PERMISSION_DENIED");
    expect(w.change).toHaveBeenCalledTimes(1);
  });

  it("the audit record carries the requested change", async () => {
    const w = settingsWorld();
    const r = await w.router.handle(cmd("settings.change", { changes: { onSessionEnd: "keep", liteSites: ["a.example"] } }));
    expect(r.audit).toMatchObject({ tool: "settings.change", outcome: "ok", params: { changes: { onSessionEnd: "keep", liteSites: ["a.example"] } } });
  });
});

describe("policy.mode_change through the router (#109)", () => {
  const modeWorld = (over: Partial<RouterDeps<{ tabs: number[] }>> = {}, state: Partial<PolicyState> = {}) => {
    const handler = vi.fn(async (c: any) => ({ status: "applied", snapshot: c.policySnapshot }));
    const w = world({ handler: (n) => (n === "policy.mode_change" ? handler : undefined), policySnapshot: vi.fn(async () => "mode-snap"), ...over }, state);
    return { ...w, handler };
  };

  it("turning YOLO on is a category p prompt with each change, the duration, the reason and warnings", async () => {
    const authorize = vi.fn(async (_r: AuthorizeRequest) => {});
    const w = modeWorld({ authorize });
    const r = await w.router.handle(cmd("policy.mode_change", { yolo: true, durationMin: 45, reason: "bulk-download statements" }));
    expect(r.ok).toBe(true);
    const req = authorize.mock.calls[0][0];
    expect(req).toMatchObject({ tool: "policy.mode_change", sensitive: "p", level: "full", url: "" });
    expect(req.summary).toContain("turn YOLO mode on for 45 minutes");
    expect(req.summary).toContain("bulk-download statements");
    expect(req.reasons.join(" ")).toMatch(/every site without asking/);
    expect(w.handler).toHaveBeenCalledWith(expect.objectContaining({ policySnapshot: "mode-snap" }));
  });

  it("turning developer mode on warns about sensitive actions", async () => {
    const authorize = vi.fn(async (_r: AuthorizeRequest) => {});
    const w = modeWorld({ authorize });
    await w.router.handle(cmd("policy.mode_change", { devAllowSensitive: true, reason: "debugging a checkout flow" }));
    const req = authorize.mock.calls[0][0];
    expect(req.sensitive).toBe("p");
    expect(req.reasons.join(" ")).toMatch(/JavaScript/);
  });

  it("snapshots before the prompt", async () => {
    const order: string[] = [];
    const w = modeWorld({
      policySnapshot: vi.fn(async (tool: string) => (order.push(`snapshot:${tool}`), "mode-snap")),
      authorize: vi.fn(async (r: AuthorizeRequest) => void order.push(`authorize:${r.sensitive}`)),
    });
    await w.router.handle(cmd("policy.mode_change", { yolo: true, reason: "r" }));
    expect(order).toEqual(["snapshot:policy.mode_change", "authorize:p"]);
  });

  it.each([{ yolo: true }, { devAllowSensitive: true }, { yolo: true, devAllowSensitive: false }])("YOLO, developer mode and saved permissions do not skip the prompt for %j", async (p) => {
    // world()'s default authorize applies the pure policy and turns an ask into PERMISSION_DENIED.
    const w = modeWorld({}, { yolo: true, devAllowSensitive: true, sites: { "https://a.example": { policy: "full", preapproved: { a: true, b: true, c: true, d: true, e: true } } } });
    const r = await w.router.handle(cmd("policy.mode_change", { ...p, reason: "r" }));
    expect(r.error?.message).toContain("would ask (sensitive)");
    expect(w.handler).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", "PERMISSION_DENIED"],
    ["timed out", "PROMPT_TIMEOUT"],
  ])("a %s prompt never applies the change", async (_label, errCode) => {
    const w = modeWorld({
      authorize: vi.fn(async () => {
        throw new RouterError(errCode, "no");
      }),
    });
    const r = await w.router.handle(cmd("policy.mode_change", { yolo: true, reason: "r" }));
    expect(r.error?.code).toBe(errCode);
    expect(w.handler).not.toHaveBeenCalled();
  });

  it.each([{ yolo: false }, { devAllowSensitive: false }, { yolo: false, devAllowSensitive: false }])("turning off (%j) runs with no prompt, audited with the reason", async (p) => {
    const w = modeWorld({}, { yolo: true, devAllowSensitive: true });
    const r = await w.router.handle(cmd("policy.mode_change", { ...p, reason: "task finished" }));
    expect(r.ok).toBe(true);
    expect(w.handler).toHaveBeenCalled();
    expect(w.authorize).toHaveBeenCalledWith(expect.objectContaining({ sensitive: undefined, level: "full" }));
    expect(r.audit).toMatchObject({ tool: "policy.mode_change", outcome: "ok" });
    expect(JSON.stringify(r.audit.params)).toContain("task finished");
  });

  it("turning off still respects the token cap", async () => {
    const w = modeWorld();
    const r = await w.router.handle({ ...cmd("policy.mode_change", { yolo: false, reason: "r" }), session: { ...meta, cap: "read" as any } });
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(w.handler).not.toHaveBeenCalled();
  });

  it("a refused precheck (no-op, bad duration) never reaches the prompt or the handler", async () => {
    const w = modeWorld({
      policySnapshot: vi.fn(async () => {
        throw new TabAgentError("BAD_REQUEST", "Nothing to change: YOLO mode is already on");
      }),
    });
    const r = await w.router.handle(cmd("policy.mode_change", { yolo: true, reason: "r" }));
    expect(r.error?.code).toBe("BAD_REQUEST");
    expect(w.authorize).not.toHaveBeenCalled();
    expect(w.handler).not.toHaveBeenCalled();
  });

  it("schema: reason is required, durationMin is bounded, unknown keys are refused", async () => {
    const w = modeWorld();
    expect((await w.router.handle(cmd("policy.mode_change", { yolo: true }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.mode_change", { yolo: true, reason: "" }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.mode_change", { yolo: true, durationMin: 0, reason: "r" }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.mode_change", { yolo: true, durationMin: 1441, reason: "r" }))).error?.code).toBe("BAD_REQUEST");
    expect((await w.router.handle(cmd("policy.mode_change", { yolo: true, paused: false, reason: "r" }))).error?.code).toBe("BAD_REQUEST");
    expect(w.authorize).not.toHaveBeenCalled();
  });
});
