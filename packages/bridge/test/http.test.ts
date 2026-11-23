import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_NAME_PATTERN, toMcpName, toolsForProfiles } from "@tabagent/protocol";
import type { Daemon } from "../src/daemon";
import { renderCli, renderMcp } from "../src/format";
import { EXT_ID, okEnvelope, pairedExt, rest, startDaemon } from "./helpers";

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});
async function boot(opts = {}) {
  const r = await startDaemon(opts);
  daemons.push(r.d);
  return r;
}

function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((res, rej) => {
    const rq = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    rq.on("error", rej);
    rq.end();
  });
}

describe("HTTP auth (D2)", () => {
  it("/v1 and /mcp without bearer -> 401 UNAUTHORIZED", async () => {
    const { base } = await boot();
    const r = await rest(base, "/v1/nav.goto", null, {});
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHORIZED");
    expect((await rest(base, "/mcp", null, {})).status).toBe(401);
    expect((await rest(base, "/v1/status", "wrong")).status).toBe(401);
  });
  it("browser Origin other than the paired extension -> 403; Host must be loopback:port", async () => {
    const { d, cfg } = await boot();
    const auth = { authorization: `Bearer ${cfg.secret}`, host: `127.0.0.1:${d.port}` };
    expect(await raw(d.port, "/v1/status", { ...auth, origin: "https://evil.example" })).toBe(403);
    expect(await raw(d.port, "/v1/status", { ...auth, origin: `chrome-extension://${EXT_ID}` })).toBe(403); // not paired yet
    expect(await raw(d.port, "/v1/status", { ...auth, host: `evil.example:${d.port}` })).toBe(403);
    expect(await raw(d.port, "/v1/status", { ...auth, host: `localhost:${d.port}` })).toBe(200);
    expect(await raw(d.port, "/v1/status", auth)).toBe(200);
    const e = await pairedExt(d);
    expect(await raw(d.port, "/v1/status", { ...auth, origin: `chrome-extension://${EXT_ID}` })).toBe(200);
    expect(await raw(d.port, "/v1/status", { ...auth, origin: "chrome-extension://someoneelse" })).toBe(403);
    e.close();
  });
  it("/v1/health needs no auth and returns only {ok, bridgeVersion, protocolVersion}", async () => {
    const { base } = await boot();
    const r = await rest(base, "/v1/health", null);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["bridgeVersion", "ok", "protocolVersion"]);
  });
  it("/v1/status shows the pair code to the secret holder; /v1/pair mints a new one", async () => {
    const { base, cfg, d } = await boot();
    const s = await rest(base, "/v1/status", cfg.secret);
    expect(s.body).toMatchObject({ ok: true, extension: false, paired: false, pairCode: d.pairCode });
    const p = await rest(base, "/v1/pair", cfg.secret, {});
    expect(p.body).toMatchObject({ ok: true, expiresInSec: 600 });
    expect(p.body.pairCode).toBe(d.pairCode);
    expect((await rest(base, "/v1/pair", "not-the-secret", {})).status).toBe(401);
  });
});

describe("REST dispatch", () => {
  it("Command reaches the extension with D8 session meta; result comes back verbatim", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    e.onCommand = () => okEnvelope({ tabs: [{ tabId: 3, url: "http://a.test/", title: "T" }] }, "tabs");
    const r = await rest(base, "/v1/tabs", cfg.secret, { action: "list" });
    const cmd = e.msgs.find((m) => m.type === "command");
    expect(cmd).toMatchObject({ tool: "tabs", params: { action: "list" }, session: { label: "local", cap: "full", sites: [] } });
    expect(cmd.session.id).toMatch(/^rest:local:default$/);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { tabs: [{ tabId: 3, url: "http://a.test/", title: "T" }] } });
    e.close();
  });
  it("--session names a separate session; legacy /v1/call routes still work", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    e.onCommand = (c) => okEnvelope({ sid: c.session.id }, c.tool);
    const a = await rest(base, "/v1/nav.reload", cfg.secret, {}, { "x-tabagent-session": "work" });
    expect(a.body.result.sid).toBe("rest:local:work");
    const b = await rest(base, "/v1/call/nav.reload", cfg.secret, { params: {} });
    expect(b.body.result.sid).toBe("rest:local:default");
    const c = await rest(base, "/v1/call", cfg.secret, { tool: "nav.reload", params: {}, session: "s2" });
    expect(c.body.result.sid).toBe("rest:local:s2");
    e.close();
  });
  it("no extension -> 503 NO_EXTENSION with pairing hint", async () => {
    const { base, cfg } = await boot();
    const r = await rest(base, "/v1/nav.reload", cfg.secret, {});
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("NO_EXTENSION");
    expect(r.body.error.hint).toMatch(/pair/);
  });
  it("unknown tool 404, bad params 400 (never reaches the extension), bad JSON 400", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    expect((await rest(base, "/v1/nope.tool", cfg.secret, {})).status).toBe(404);
    const bad = await rest(base, "/v1/nav.goto", cfg.secret, {});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_REQUEST");
    const r = await fetch(`${base}/v1/nav.goto`, { method: "POST", headers: { authorization: `Bearer ${cfg.secret}` }, body: "{nope" });
    expect(r.status).toBe(400);
    expect((await rest(base, "/v1/zzz", cfg.secret)).status).toBe(404);
    expect(e.msgs.filter((m) => m.type === "command")).toHaveLength(0);
    e.close();
  });
  it("extension errors map to HTTP status; message and hint pass through", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    e.onCommand = () => ({ ok: false, error: { code: "TAB_BUSY", message: "Tab 4 belongs to another agent session", hint: "use your own tab" }, audit: okEnvelope({}).audit });
    const r = await rest(base, "/v1/nav.reload", cfg.secret, { tabId: 4 });
    expect(r.status).toBe(200);
    expect(r.body.error).toEqual({ code: "TAB_BUSY", message: "Tab 4 belongs to another agent session", hint: "use your own tab" });
    e.onCommand = () => ({ ok: false, error: { code: "PERMISSION_DENIED", message: "no" } });
    expect((await rest(base, "/v1/nav.goto", cfg.secret, { url: "chrome://settings" })).status).toBe(403);
    e.close();
  });
  it("side-effect fields are top-level; a legacy in-result snapshotDiff is lifted", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    e.onCommand = () => okEnvelope({ url: "http://b/" }, "nav.back", { navigation: { url: "http://b/", title: "B", kind: "back" } });
    const r = await rest(base, "/v1/nav.back", cfg.secret, {});
    expect(r.body.navigation).toEqual({ url: "http://b/", title: "B", kind: "back" });
    e.onCommand = () => ({ ok: true, result: { snapshotDiff: "~ x", url: "http://b/" } });
    const l = await rest(base, "/v1/nav.reload", cfg.secret, {});
    expect(l.body.result).toEqual({ url: "http://b/" });
    expect(l.body.snapshotDiff).toBe("~ x");
    e.close();
  });
  it("REST sessions expire after 30 min idle (session.closed sent); stdio proxy sessions do not", async () => {
    let now = 1e9;
    const { d, base, cfg } = await boot({ now: () => now });
    const e = await pairedExt(d);
    e.onCommand = () => okEnvelope({}, "nav.reload");
    await rest(base, "/v1/nav.reload", cfg.secret, {});
    await rest(base, "/v1/nav.reload", cfg.secret, {}, { "x-tabagent-mcp": "1", "x-tabagent-session": "p1", "x-tabagent-client": "claude-code" });
    expect(e.msgs.filter((m) => m.type === "command")[1].session).toMatchObject({ id: "mcp:local:p1", label: "claude-code" });
    now += 31 * 60_000;
    d.gcRestSessions();
    const closed = await e.next("session.closed");
    expect(closed.sessionId).toBe("rest:local:default");
    expect(e.msgs.filter((m) => m.type === "session.closed")).toHaveLength(1);
    await rest(base, "/v1/session/end", cfg.secret, {}, { "x-tabagent-session": "p1", "x-tabagent-mcp": "1" });
    expect((await e.next("session.closed")).sessionId).toBe("mcp:local:p1");
    e.close();
  });
  it("/v1/tools lists by profile; unknown profile 400", async () => {
    const { base, cfg } = await boot();
    const r = await rest(base, "/v1/tools?profile=core", cfg.secret);
    expect(r.body.tools.map((t: any) => t.name).sort()).toEqual(toolsForProfiles("core").map((t) => t.name).sort());
    expect((await rest(base, "/v1/tools?profile=nope", cfg.secret)).status).toBe(400);
    expect((await rest(base, "/v1/tools", cfg.secret)).body.tools.length).toBe(toolsForProfiles("full").length);
  });
});

describe("MCP Streamable HTTP", () => {
  async function mcpClient(base: string, token: string, profile?: string, name = "http-agent") {
    const url = new URL(`${base}/mcp${profile ? `?profile=${profile}` : ""}`);
    const t = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const c = new Client({ name, version: "1" });
    await c.connect(t);
    return c;
  }
  it("tools/list equals the registry filtered by ?profile; names match the wire pattern", async () => {
    const { base, cfg } = await boot();
    for (const p of [undefined, "full", "forms,dev"]) {
      const c = await mcpClient(base, cfg.secret, p);
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(toolsForProfiles(p ?? "core").map((t) => toMcpName(t.name)).sort());
      for (const t of tools) expect(t.name).toMatch(MCP_NAME_PATTERN);
      await c.close();
    }
  });
  it("unknown ?profile is a 400", async () => {
    const { base, cfg } = await boot();
    await expect(mcpClient(base, cfg.secret, "bogus")).rejects.toThrow();
  });
  it("one session per connection; label from clientInfo; output renders like REST and CLI", async () => {
    const { d, base, cfg } = await boot();
    const e = await pairedExt(d);
    const env = okEnvelope({ title: "T", url: "u2" }, "nav.goto", { navigation: { url: "u2", title: "t2", kind: "navigate" } });
    e.onCommand = () => env;
    const c = await mcpClient(base, cfg.secret, undefined, "cursor");
    const r: any = await c.callTool({ name: "nav_goto", arguments: { url: "http://a.test/" } });
    const cmd = e.msgs.find((m) => m.type === "command");
    expect(cmd.session.label).toBe("cursor");
    expect(cmd.session.id).toMatch(/^mcp-/);
    const restBody = (await rest(base, "/v1/nav.goto", cfg.secret, { url: "http://a.test/" })).body;
    expect(r.content[0].text).toBe((renderMcp(restBody).content[0] as { text: string }).text);
    expect(renderCli(restBody)).toBe(r.content[0].text);
    expect(JSON.parse(r.content[0].text)).toEqual({ title: "T", url: "u2", navigation: { url: "u2", title: "t2", kind: "navigate" } });
    await c.close();
    e.close();
  });
  it("requests without a session are rejected", async () => {
    const { base, cfg } = await boot();
    const r = await rest(base, "/mcp", cfg.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(400);
    const r2 = await rest(base, "/mcp", cfg.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "nope" });
    expect(r2.status).toBe(404);
  });
});
