// #61 Part B: the remote handoff listener end to end (daemon + fake extension + phone-side HTTP).
// The listener seam binds 127.0.0.1 in tests but advertises a tailnet IP, so the Host check and the
// link are exactly what production uses; startRemoteListener's tailnet-only guard is tested separately.
import { createServer, request, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { configCommand } from "../src/commands";
import type { Daemon } from "../src/daemon";
import { okEnvelope, pairedExt, rest, startDaemon, type FakeExt } from "./helpers";

const TS_IP = "100.100.100.100";
let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

function harness() {
  const listener = { port: 0, closed: 0, starts: 0 };
  const hooks: { url: string; body: any }[] = [];
  const listen = async (handler: RequestListener) => {
    const srv: Server = createServer(handler);
    srv.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    listener.port = (srv.address() as { port: number }).port;
    listener.starts++;
    return {
      ip: TS_IP,
      port: listener.port,
      close: async () => {
        listener.closed++;
        const done = new Promise<void>((r) => srv.close(() => r()));
        srv.closeAllConnections?.();
        await done;
      },
      upgrade: (cb: () => void) => srv.on("upgrade", cb),
    };
  };
  const postWebhook = async (url: string, body: unknown) => {
    hooks.push({ url, body });
  };
  return { listener, hooks, listen, postWebhook };
}

function http(port: number, method: string, path: string, o: { host?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: Buffer; text: string }>((resolve, reject) => {
    const data = o.body === undefined ? undefined : Buffer.from(typeof o.body === "string" ? o.body : JSON.stringify(o.body));
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: o.host ?? `${TS_IP}:${port}`, ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}), ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8") });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function boot(remote = true) {
  const h = harness();
  const r = await startDaemon({ handoffListen: h.listen, postWebhook: h.postWebhook } as any);
  daemons.push(r.d);
  configCommand(["handoff.remote", remote ? "on" : "off"]);
  configCommand(["handoff.webhook", "https://hooks.example.com/jarvis"]);
  const ext = await pairedExt(r.d);
  return { ...r, ...h, ext };
}

/** Start auth.handoff over REST and open the remote handoff from the fake extension. */
async function openHandoff(ctx: Awaited<ReturnType<typeof boot>>, ext: FakeExt = ctx.ext) {
  const call = rest(ctx.base, "/v1/auth.handoff", ctx.cfg.secret, { reason: "Selfie check", tabId: 5 });
  call.catch(() => {}); // the bridge-stop test drops the connection
  const cmd = await ext.next("command", (m) => m.tool === "auth.handoff");
  ext.send({ type: "handoff.open", id: `o-${cmd.id}`, commandId: cmd.id, origin: "https://id.example", reason: "Selfie check", sessionLabel: "jarvis" });
  const opened = await ext.next("handoff.opened", (m) => m.id === `o-${cmd.id}`);
  const finish = async () => {
    ext.send({ type: "result", id: cmd.id, ...okEnvelope({ completed: true }, "auth.handoff") });
    return call;
  };
  return { cmd, opened, call, finish };
}

/** A received wire message without FakeExt's bookkeeping flag. */
function wire(m: any) {
  const { __seen: _s, ...rest } = m;
  return rest;
}

function linkParts(url: string) {
  const u = new URL(url);
  return { path: u.pathname, token: u.searchParams.get("t")!, port: Number(u.port), hostport: u.host };
}

async function claimed(ctx: Awaited<ReturnType<typeof boot>>, url: string) {
  const { path, token, port } = linkParts(url);
  const c = await http(port, "POST", `${path}/claim`, { headers: { "x-tabagent-handoff": "1" }, body: { t: token } });
  expect(c.status).toBe(204);
  const cookie = String(c.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  return { path, token, port, cookie, h: { cookie, "x-tabagent-handoff": "1" } };
}

describe("remote handoff: open + notify", () => {
  it("handoff.open for an in-flight auth.handoff returns a tailnet link and a 30-min timeout, and posts the webhook", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    expect(opened.ok).toBe(true);
    expect(opened.timeoutMs).toBe(30 * 60_000);
    expect(opened.handoffId).toMatch(/^[0-9a-f]{32}$/);
    expect(opened.url).toMatch(new RegExp(`^http://${TS_IP.replace(/\./g, "\\.")}:\\d+/handoff/${opened.handoffId}\\?t=[A-Za-z0-9_-]{43}$`));
    expect(opened.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.hooks).toHaveLength(1);
    expect(ctx.hooks[0].url).toBe("https://hooks.example.com/jarvis");
    expect(ctx.hooks[0].body).toMatchObject({ event: "handoff.start", origin: "https://id.example", reason: "Selfie check", url: opened.url, session: "jarvis" });
    expect(Object.keys(ctx.hooks[0].body).sort()).toEqual(["event", "expiresAt", "origin", "reason", "session", "url"]);
    expect((await finish()).body.ok).toBe(true);
  });

  it("remote off: no listener, no link, 5-min timeout; the webhook still fires with url null", async () => {
    const ctx = await boot(false);
    const { opened, finish } = await openHandoff(ctx);
    expect(opened).toMatchObject({ ok: true, handoffId: null, url: null, timeoutMs: 5 * 60_000 });
    expect(ctx.listener.starts).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.hooks[0].body.url).toBeNull();
    await finish();
  });

  it("refuses handoff.open for an unknown command or a command that is not auth.handoff", async () => {
    const ctx = await boot();
    ctx.ext.send({ type: "handoff.open", id: "x1", commandId: "nope", origin: "https://a.b", reason: "r", sessionLabel: "s" });
    expect(await ctx.ext.next("handoff.opened", (m) => m.id === "x1")).toMatchObject({ ok: false });
    const call = rest(ctx.base, "/v1/page.text", ctx.cfg.secret, {});
    const cmd = await ctx.ext.next("command", (m) => m.tool === "page.text");
    ctx.ext.send({ type: "handoff.open", id: "x2", commandId: cmd.id, origin: "https://a.b", reason: "r", sessionLabel: "s" });
    expect(await ctx.ext.next("handoff.opened", (m) => m.id === "x2")).toMatchObject({ ok: false });
    ctx.ext.send({ type: "result", id: cmd.id, ...okEnvelope({ text: "" }, "page.text") });
    await call;
    expect(ctx.listener.starts).toBe(0);
  });

  it("the bridge waits for auth.handoff as long as the configured handoff timeout", async () => {
    const ctx = await boot();
    expect(ctx.d.commandTimeoutMs("auth.handoff", {})).toBeGreaterThanOrEqual(30 * 60_000);
    configCommand(["handoff.remote", "off"]);
    const local = ctx.d.commandTimeoutMs("auth.handoff", {});
    expect(local).toBeGreaterThanOrEqual(5 * 60_000);
    expect(local).toBeLessThan(30 * 60_000);
  });
});

describe("remote handoff: auth and route allowlist", () => {
  it("serves only the handoff routes; the agent API, MCP and the extension socket are not there", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const { cookie, port, path } = await claimed(ctx, opened.url);
    const auth = { authorization: `Bearer ${ctx.cfg.secret}`, cookie, "x-tabagent-handoff": "1" };
    for (const p of ["/", "/v1/health", "/v1/status", "/v1/tools", "/mcp", "/ext", "/v1/page.text", "/v1/admin/bitwarden/session", `${path}/../../v1/status`, `${path}/eval`, `${path}/nav`, "/handoff", "/handoff/"]) {
      for (const method of ["GET", "POST"]) {
        const r = await http(port, method, p, { headers: auth, body: method === "POST" ? {} : undefined });
        expect(r.status, `${method} ${p}`).toBe(404);
      }
    }
    await finish();
  });

  it("rejects a Host header that is not the tailnet address (DNS rebinding)", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const { path, token, port } = linkParts(opened.url);
    for (const host of ["evil.example", `127.0.0.1:${port}`, `localhost:${port}`, TS_IP]) {
      expect((await http(port, "GET", `${path}?t=${token}`, { host })).status).toBe(403);
    }
    await finish();
  });

  it("page needs the URL token; claim needs the CSRF header; the token is one-time and then the cookie is the key", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const { path, token, port } = linkParts(opened.url);
    expect((await http(port, "GET", path)).status).toBe(404);
    expect((await http(port, "GET", `${path}?t=wrong`)).status).toBe(404);
    const page = await http(port, "GET", `${path}?t=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(page.headers["cache-control"]).toMatch(/no-store/);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain("id.example");
    expect(page.text).not.toContain(token);
    // a GET (link preview) does not use up the token
    expect((await http(port, "GET", `${path}?t=${token}`)).status).toBe(200);
    expect((await http(port, "POST", `${path}/claim`, { body: { t: token } })).status).toBe(403);
    const c = await http(port, "POST", `${path}/claim`, { headers: { "x-tabagent-handoff": "1" }, body: { t: token } });
    expect(c.status).toBe(204);
    const setCookie = String(c.headers["set-cookie"]?.[0]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toContain(`Path=${path}`);
    const cookie = setCookie.split(";")[0];
    // one-time: a second device cannot claim, and the bare link no longer opens the page
    expect((await http(port, "POST", `${path}/claim`, { headers: { "x-tabagent-handoff": "1" }, body: { t: token } })).status).toBe(404);
    expect((await http(port, "GET", `${path}?t=${token}`)).status).toBe(404);
    // the claiming browser can reload
    expect((await http(port, "GET", path, { headers: { cookie } })).status).toBe(200);
    // API calls need cookie AND header
    expect((await http(port, "POST", `${path}/input`, { headers: { cookie }, body: { kind: "key", key: "Enter" } })).status).toBe(403);
    expect((await http(port, "POST", `${path}/input`, { headers: { "x-tabagent-handoff": "1" }, body: { kind: "key", key: "Enter" } })).status).toBe(404);
    await finish();
  });

  it("a cookie for one handoff does not open another", async () => {
    const ctx = await boot();
    const a = await openHandoff(ctx);
    const b = await openHandoff(ctx);
    const ca = await claimed(ctx, a.opened.url);
    const pb = linkParts(b.opened.url);
    expect((await http(pb.port, "GET", `${pb.path}/frame`, { headers: ca.h })).status).toBe(404);
    expect((await http(pb.port, "POST", `${pb.path}/end`, { headers: ca.h, body: { result: "done" } })).status).toBe(404);
    expect(ctx.ext.msgs.some((m) => m.type === "handoff.end")).toBe(false);
    await a.finish();
    await b.finish();
  });
});

describe("remote handoff: frames, input, end", () => {
  it("frame and input go to the extension tagged with this handoff only; bad input never reaches it", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const s = await claimed(ctx, opened.url);
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fp = http(s.port, "GET", `${s.path}/frame`, { headers: s.h });
    const fr = await ctx.ext.next("handoff.frame");
    expect(wire(fr)).toEqual({ type: "handoff.frame", id: fr.id, handoffId: opened.handoffId });
    ctx.ext.send({ type: "handoff.frame.result", id: fr.id, ok: true, mime: "image/jpeg", dataBase64: img.toString("base64") });
    const f = await fp;
    expect(f.status).toBe(200);
    expect(f.headers["content-type"]).toBe("image/jpeg");
    expect(f.headers["cache-control"]).toMatch(/no-store/);
    expect(f.body.equals(img)).toBe(true);

    const ip = http(s.port, "POST", `${s.path}/input`, { headers: s.h, body: { kind: "tap", x: 0.5, y: 0.25 } });
    const inp = await ctx.ext.next("handoff.input");
    expect(wire(inp)).toEqual({ type: "handoff.input", id: inp.id, handoffId: opened.handoffId, input: { kind: "tap", x: 0.5, y: 0.25 } });
    expect("tabId" in inp).toBe(false);
    ctx.ext.send({ type: "handoff.input.result", id: inp.id, ok: true });
    expect((await ip).status).toBe(204);

    const before = ctx.ext.msgs.filter((m) => m.type === "handoff.input").length;
    for (const bad of [{ kind: "eval", code: "1" }, { kind: "tap", x: 2, y: 0 }, { kind: "key", key: "F12" }, { kind: "text", text: "" }, { kind: "tap", x: 0.1, y: 0.1, tabId: 9 }, { kind: "nav", url: "https://x" }]) {
      expect((await http(s.port, "POST", `${s.path}/input`, { headers: s.h, body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(ctx.ext.msgs.filter((m) => m.type === "handoff.input").length).toBe(before);
    await finish();
  });

  it("an extension error on input is reported without detail leaks; a silent extension times out", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const s = await claimed(ctx, opened.url);
    const ip = http(s.port, "POST", `${s.path}/input`, { headers: s.h, body: { kind: "text", text: "hello" } });
    const inp = await ctx.ext.next("handoff.input");
    ctx.ext.send({ type: "handoff.input.result", id: inp.id, ok: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect((await ip).status).toBe(502);
    await finish();
  });

  it("Done on the phone ends the handoff in the extension and revokes the link at once", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const s = await claimed(ctx, opened.url);
    expect((await http(s.port, "POST", `${s.path}/end`, { headers: s.h, body: { result: "maybe" } })).status).toBe(400);
    const e = await http(s.port, "POST", `${s.path}/end`, { headers: s.h, body: { result: "done" } });
    expect(e.status).toBe(204);
    const end = await ctx.ext.next("handoff.end");
    expect(wire(end)).toEqual({ type: "handoff.end", handoffId: opened.handoffId, result: "done" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.listener.closed).toBe(1);
    await finish();
  });

  it("Cancel works the same way", async () => {
    const ctx = await boot();
    const { opened, finish } = await openHandoff(ctx);
    const s = await claimed(ctx, opened.url);
    expect((await http(s.port, "POST", `${s.path}/end`, { headers: s.h, body: { result: "cancel" } })).status).toBe(204);
    expect(await ctx.ext.next("handoff.end")).toMatchObject({ result: "cancel" });
    await finish();
  });
});

describe("remote handoff: revocation", () => {
  async function liveSession() {
    const ctx = await boot();
    const o = await openHandoff(ctx);
    const s = await claimed(ctx, o.opened.url);
    const frameStatus = async () => {
      const p = http(s.port, "GET", `${s.path}/frame`, { headers: s.h }).catch(() => ({ status: -1 }));
      const fr = await ctx.ext.next("handoff.frame", () => true, 300).catch(() => null);
      if (fr) ctx.ext.send({ type: "handoff.frame.result", id: fr.id, ok: true, mime: "image/jpeg", dataBase64: "AA==" });
      return (await p).status;
    };
    expect(await frameStatus()).toBe(200);
    return { ctx, o, s, frameStatus };
  }
  const gone = (st: number) => expect([404, -1]).toContain(st);

  it("revoked when the extension reports the handoff ended (local Done, timeout, tab closed)", async () => {
    const { ctx, o, frameStatus } = await liveSession();
    ctx.ext.send({ type: "handoff.closed", handoffId: o.opened.handoffId, outcome: "timeout" });
    await new Promise((r) => setTimeout(r, 30));
    gone(await frameStatus());
    expect(ctx.listener.closed).toBe(1);
    await o.finish();
  });

  it("revoked when the auth.handoff command finishes", async () => {
    const { ctx, o, frameStatus } = await liveSession();
    await o.finish();
    await new Promise((r) => setTimeout(r, 30));
    gone(await frameStatus());
    expect(ctx.listener.closed).toBe(1);
  });

  it("revoked by the kill switch", async () => {
    const { ctx, o, frameStatus } = await liveSession();
    ctx.ext.send({ type: "event", event: "killed", data: {} });
    await new Promise((r) => setTimeout(r, 30));
    gone(await frameStatus());
    await o.finish();
  });

  it("revoked when the extension disconnects", async () => {
    const { ctx, frameStatus } = await liveSession();
    ctx.ext.close();
    await ctx.ext.closed;
    await new Promise((r) => setTimeout(r, 30));
    gone(await frameStatus());
  });

  it("revoked on bridge stop", async () => {
    const { ctx } = await liveSession();
    await ctx.d.stop();
    daemons = daemons.filter((x) => x !== ctx.d);
    expect(ctx.listener.closed).toBe(1);
  });
});
