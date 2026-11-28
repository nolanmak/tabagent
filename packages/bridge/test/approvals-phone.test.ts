// #108: the phone approval page on the remote (tailnet) listener. Same seam as handoff-remote.test.ts:
// the listener binds 127.0.0.1 in tests but advertises a tailnet IP, so the Host check and links match
// production. The link is handed out only after a presence check (CLI) or a click in the side panel.
import { createServer, request, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { MirroredPrompt } from "@tabagent/protocol";
import { configCommand } from "../src/commands";
import type { Daemon } from "../src/daemon";
import { pairedExt, rest, startDaemon } from "./helpers";
import { fakePresence, type FakePresence } from "./presence-fakes";

const TS_IP = "100.100.100.100";
let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

function listenSeam() {
  const listener = { port: 0, closed: 0, starts: 0 };
  const listen = async (handler: RequestListener) => {
    const srv: Server = createServer(handler);
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
    };
  };
  return { listener, listen };
}

function http(port: number, method: string, path: string, o: { host?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; text: string; json: any }>((resolve, reject) => {
    const data = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: o.host ?? `${TS_IP}:${port}`, ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}), ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* html or text */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const P = (id: string, over: Partial<MirroredPrompt> = {}): MirroredPrompt => ({
  promptId: id,
  title: `jarvis wants to <b>read</b> https://${id}.example`,
  detail: "It will be able to see page content.",
  summary: `open https://${id}.example/`,
  reasons: ["<script>alert(1)</script>"],
  tool: "nav.goto",
  sessionLabel: "jarvis",
  origin: `https://${id}.example`,
  expires: Date.now() + 120_000,
  answers: ["deny", "always", "once"],
  alwaysLabel: "Always allow read",
  ...over,
});

async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
}

async function boot(o: { remote?: boolean; presence?: FakePresence; prompts?: MirroredPrompt[] } = {}) {
  const seam = listenSeam();
  const presence = o.presence ?? fakePresence("ok");
  const r = await startDaemon({ presence, handoffListen: seam.listen });
  daemons.push(r.d);
  configCommand(["handoff.remote", o.remote === false ? "off" : "on"]);
  const ext = await pairedExt(r.d, undefined, ["prompts.mirror"]);
  const answered = new Map<string, string>();
  ext.ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== "prompt.answer") return;
    const won = answered.get(m.promptId);
    if (won) return ext.send({ type: "prompt.answer.result", id: m.id, ok: false, outcome: "already_answered", by: won });
    answered.set(m.promptId, m.channel);
    ext.send({ type: "prompt.answer.result", id: m.id, ok: true, outcome: "applied" });
  });
  const prompts = o.prompts ?? [P("a")];
  ext.send({ type: "prompts.sync", enabled: true, prompts });
  await until(() => r.d.approvals.prompts.size === prompts.length);
  return { ...r, ...seam, ext, presence, answered };
}

async function link(c: Awaited<ReturnType<typeof boot>>) {
  const r = await rest(c.base, "/v1/approvals/phone", c.cfg.secret, {});
  expect(r.status).toBe(200);
  const u = new URL(r.body.url);
  return { url: r.body.url as string, path: u.pathname, token: u.searchParams.get("t")!, port: Number(u.port), expiresAt: r.body.expiresAt as number };
}

async function claimed(c: Awaited<ReturnType<typeof boot>>) {
  const l = await link(c);
  const cl = await http(l.port, "POST", `${l.path}/claim`, { headers: { "x-tabagent-handoff": "1" }, body: { t: l.token } });
  expect(cl.status).toBe(204);
  const cookie = String(cl.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  return { ...l, cookie, setCookie: String(cl.headers["set-cookie"]?.[0]), h: { cookie, "x-tabagent-handoff": "1" } };
}

describe("phone link", () => {
  it("needs handoff.remote on", async () => {
    const c = await boot({ remote: false });
    const r = await rest(c.base, "/v1/approvals/phone", c.cfg.secret, {});
    expect(r.status).toBe(400);
    expect(r.body.error.hint).toMatch(/handoff\.remote on/);
    expect(c.presence.calls).toHaveLength(0);
    expect(c.listener.starts).toBe(0);
  });
  it("needs presence: cancelled -> 403 and the listener never opens", async () => {
    const c = await boot({ presence: fakePresence("cancel") });
    const r = await rest(c.base, "/v1/approvals/phone", c.cfg.secret, {});
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
    expect(c.listener.starts).toBe(0);
    expect(c.presence.calls[0].reason).toMatch(/phone/i);
  });
  it("with presence: a one-time tailnet link, valid for the requested time (capped)", async () => {
    const c = await boot();
    const l = await link(c);
    expect(l.url).toMatch(new RegExp(`^http://${TS_IP.replace(/\./g, "\\.")}:\\d+/approve/[0-9a-f]{32}\\?t=[\\w-]{43}$`));
    expect(l.expiresAt - Date.now()).toBeGreaterThan(55 * 60_000);
    const long = await rest(c.base, "/v1/approvals/phone", c.cfg.secret, { ttlMin: 999 });
    expect(long.body.expiresAt - Date.now()).toBeLessThanOrEqual(120 * 60_000);
    expect(c.listener.starts).toBe(1);
  });
  it("the side panel can ask for a link over the extension socket (no presence prompt: the click is the proof)", async () => {
    const c = await boot();
    c.ext.send({ type: "approvals.link", id: "L1" });
    const res = await c.ext.next("approvals.link.result", (m) => m.id === "L1");
    expect(res.ok).toBe(true);
    expect(res.url).toMatch(/\/approve\/[0-9a-f]{32}\?t=/);
    expect(c.presence.calls).toHaveLength(0);
  });
  it("a side-panel link request fails cleanly with remote off", async () => {
    const c = await boot({ remote: false });
    c.ext.send({ type: "approvals.link", id: "L2" });
    const res = await c.ext.next("approvals.link.result", (m) => m.id === "L2");
    expect(res).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
  });
});

describe("phone page", () => {
  it("serves the page with a strict CSP and never inlines prompt text into the HTML", async () => {
    const c = await boot();
    const l = await link(c);
    const page = await http(l.port, "GET", `${l.path}?t=${l.token}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).not.toContain("jarvis wants to");
  });
  it("lists pending prompts with the panel's exact text, only with the claimed cookie and header", async () => {
    const c = await boot();
    const s = await claimed(c);
    expect(s.setCookie).toMatch(new RegExp(`tabagent_approve=[\\w-]+; Path=${s.path}; HttpOnly; SameSite=Strict`));
    const list = await http(s.port, "GET", `${s.path}/prompts`, { headers: s.h });
    expect(list.status).toBe(200);
    expect(list.json.prompts).toEqual([P("a", { expires: list.json.prompts[0].expires })]);
    expect((await http(s.port, "GET", `${s.path}/prompts`, { headers: { "x-tabagent-handoff": "1" } })).status).toBe(404);
    expect((await http(s.port, "GET", `${s.path}/prompts`, { headers: { cookie: s.cookie } })).status).toBe(403);
    expect((await http(s.port, "GET", `${s.path}/prompts`, { headers: s.h, host: `evil.example:${s.port}` })).status).toBe(403);
  });
  it("an unknown or wrong-token link shows the ended page", async () => {
    const c = await boot();
    const l = await link(c);
    const bad = await http(l.port, "GET", `${l.path}?t=wrong`);
    expect(bad.status).toBe(404);
    expect(bad.text).toMatch(/not valid/);
    expect((await http(l.port, "GET", `/approve/${"0".repeat(32)}?t=${l.token}`)).status).toBe(404);
  });
  it("the link token claims once", async () => {
    const c = await boot();
    const s = await claimed(c);
    const again = await http(s.port, "POST", `${s.path}/claim`, { headers: { "x-tabagent-handoff": "1" }, body: { t: s.token } });
    expect(again.status).toBe(404);
  });
  it("answers through the extension with channel 'phone'; the second answer is 'already answered'", async () => {
    const c = await boot();
    const s = await claimed(c);
    const a = await http(s.port, "POST", `${s.path}/answer`, { headers: s.h, body: { promptId: "a", answer: "once" } });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ ok: true, outcome: "applied" });
    const sent = c.ext.msgs.filter((m) => m.type === "prompt.answer");
    expect(sent.map((m) => [m.promptId, m.answer, m.channel])).toEqual([["a", "once", "phone"]]);
    const b = await http(s.port, "POST", `${s.path}/answer`, { headers: s.h, body: { promptId: "a", answer: "deny" } });
    expect(b.status).toBe(409);
    expect(b.json).toMatchObject({ ok: false, outcome: "already_answered", by: "phone" });
    expect(c.presence.calls).toHaveLength(1); // the link's own check; answers need the cookie, not another prompt
  });
  it("refuses answers without the cookie, with a bad body, or not offered", async () => {
    const c = await boot({ prompts: [P("a", { answers: ["deny", "once"], alwaysLabel: undefined })] });
    const s = await claimed(c);
    expect((await http(s.port, "POST", `${s.path}/answer`, { headers: { "x-tabagent-handoff": "1" }, body: { promptId: "a", answer: "once" } })).status).toBe(404);
    expect((await http(s.port, "POST", `${s.path}/answer`, { headers: s.h, body: { promptId: "a", answer: "yes" } })).status).toBe(400);
    expect((await http(s.port, "POST", `${s.path}/answer`, { headers: s.h, body: { promptId: "a", answer: "always" } })).status).toBe(400);
    expect(c.ext.msgs.filter((m) => m.type === "prompt.answer")).toEqual([]);
  });
  it("a handoff cookie or route cannot reach approvals and vice versa", async () => {
    const c = await boot();
    const s = await claimed(c);
    const id = s.path.split("/")[2];
    expect((await http(s.port, "GET", `/handoff/${id}/frame`, { headers: s.h })).status).toBe(404);
    expect((await http(s.port, "GET", `/v1/approvals`, { headers: s.h })).status).toBe(404);
  });
});

describe("phone link lifecycle", () => {
  it("End on the phone revokes the link and closes the listener", async () => {
    const c = await boot();
    const s = await claimed(c);
    expect((await http(s.port, "POST", `${s.path}/end`, { headers: s.h, body: {} })).status).toBe(204);
    await until(() => c.listener.closed === 1);
    expect(c.d.approvals.links.size).toBe(0);
  });
  it("the kill switch revokes it", async () => {
    const c = await boot();
    await claimed(c);
    c.ext.send({ type: "event", event: "killed", data: { source: "user" } });
    await until(() => c.d.approvals.links.size === 0 && c.listener.closed === 1);
  });
  it("turning outside approvals off in the panel revokes it", async () => {
    const c = await boot();
    await claimed(c);
    c.ext.send({ type: "prompts.sync", enabled: false, prompts: [] });
    await until(() => c.d.approvals.links.size === 0 && c.listener.closed === 1);
  });
  it("outlives an extension reconnect but answers fail while no extension is connected", async () => {
    const c = await boot();
    const s = await claimed(c);
    c.ext.close();
    await until(() => !c.d.extensionConnected);
    expect(c.d.approvals.links.size).toBe(1);
    const list = await http(s.port, "GET", `${s.path}/prompts`, { headers: s.h });
    expect(list.json.prompts).toEqual([]);
    const a = await http(s.port, "POST", `${s.path}/answer`, { headers: s.h, body: { promptId: "a", answer: "once" } });
    expect(a.status).toBe(404);
  });
  it("bridge stop revokes everything", async () => {
    const c = await boot();
    await claimed(c);
    await c.d.stop();
    daemons = daemons.filter((d) => d !== c.d);
    expect(c.d.approvals.links.size).toBe(0);
    expect(c.listener.closed).toBe(1);
  });
});
