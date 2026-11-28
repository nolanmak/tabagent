// Linking and piggyback through the real daemon (spec AD4, AD5, AD7, AD8, §6): GET /v1/inbox auth,
// keying and replacement, POST /v1/inbox/ack, `linked` in agents.listed, and held -> delivered/expired.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSentSchema, AgentsListedSchema } from "@tabagent/protocol";
import { saveConfig } from "../src/config";
import type { Daemon } from "../src/daemon";
import { createSseParser } from "../src/inbox-client";
import { createToken } from "../src/tokens";
import { claudeRecord, StubClaude } from "./agents-fakes";
import { FakeExt, okEnvelope, pairedExt, rest, startDaemon } from "./helpers";

let claude: StubClaude;
let d: Daemon;
let base: string;
let ext: FakeExt;
let streams: Inbox[];

const PID = 4242;
const STARTED = 1_795_639_119_768;
const AGENT = `claude:${PID}:${STARTED}`;
const H = "[TabAgent: message from the user via the side panel]";

beforeEach(() => {
  claude = new StubClaude();
  claude.agents([claudeRecord(PID, STARTED, { cwd: claude.dir }), claudeRecord(77, 1000, { cwd: claude.dir })]);
  streams = [];
});
afterEach(async () => {
  for (const s of streams) s.close();
  ext?.close();
  await d?.stop();
  claude.cleanup();
});

async function boot(agents: Record<string, unknown> = {}) {
  ({ d, base } = await startDaemon({ agents: { claudeBin: claude.bin, codexSocket: `${claude.dir}/no-codex.sock`, cacheMs: 0, ...agents } }));
  ext = await pairedExt(d, undefined, ["agents"]);
  // Tool calls succeed unless a test says otherwise.
  ext.onCommand = (cmd) => okEnvelope({ tabs: [], echo: cmd.params?.n ?? null }, cmd.tool);
}

interface Inbox {
  status: number;
  body: any;
  events: { event: string; data: any }[];
  ended: Promise<void>;
  isEnded: () => boolean;
  close: () => void;
}

const proxyHeaders = (session = "100-aaaaaa", extra: Record<string, string> = {}) => ({
  "x-tabagent-mcp": "1",
  "x-tabagent-session": session,
  "x-tabagent-client": "claude-code",
  "x-tabagent-agent-pid": String(PID),
  "x-tabagent-channels": "0",
  "x-tabagent-profile": "core",
  ...extra,
});

async function openInbox(token: string | null, headers: Record<string, string> = proxyHeaders()): Promise<Inbox> {
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/inbox`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, signal: ac.signal });
  const events: Inbox["events"] = [];
  let ended = false;
  if (res.headers.get("content-type")?.startsWith("application/json")) {
    const body = await res.json();
    return { status: res.status, body, events, ended: Promise.resolve(), isEnded: () => true, close: () => {} };
  }
  const feed = createSseParser((e) => events.push({ event: e.event, data: JSON.parse(e.data) }));
  const done = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
      }
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  const s = { status: res.status, body: null, events, ended: done, isEnded: () => ended, close: () => ac.abort() };
  streams.push(s);
  return s;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
}

async function list() {
  ext.send({ type: "agents.list", id: `l${Math.random()}` });
  const m = await ext.next("agents.listed");
  expect(AgentsListedSchema.safeParse(m).success).toBe(true);
  return m.agents as any[];
}

let seq = 0;
async function send(fields: Record<string, unknown> = {}) {
  const requestId = (fields.requestId as string) ?? `p${++seq}`;
  ext.send({ type: "agent.send", requestId, agentId: AGENT, prompt: "Please look", includeTab: false, ...fields });
  const sent = await ext.next("agent.sent", (m) => m.requestId === requestId, 8000);
  expect(AgentSentSchema.safeParse(sent).success).toBe(true);
  const { __seen: _s, ...wire } = sent;
  return wire;
}

const tool = (session = "100-aaaaaa", body: Record<string, unknown> = { action: "list" }) => rest(base, "/v1/tabs", d.cfg.secret, body, { "x-tabagent-mcp": "1", "x-tabagent-session": session });
const status = (requestId: string, ms = 3000) => ext.next("agent.status", (m) => m.requestId === requestId, ms);

describe("GET /v1/inbox (AD4, AD5)", () => {
  it("needs the bearer: no or bad token -> 401", async () => {
    await boot();
    expect((await openInbox(null)).status).toBe(401);
    expect((await openInbox("nope")).status).toBe(401);
  });
  it("opens an SSE stream, eagerly creates the persistent bridge session and says ready", async () => {
    await boot();
    expect((await rest(base, "/v1/status", d.cfg.secret)).body.restSessions).toBe(0);
    const s = await openInbox(d.cfg.secret);
    expect(s.status).toBe(200);
    await until(() => s.events.length > 0);
    expect(s.events[0]).toEqual({ event: "ready", data: { sessionId: "mcp:local:100-aaaaaa" } });
    expect((await rest(base, "/v1/status", d.cfg.secret)).body.restSessions).toBe(1);
    // The session is the one the proxy's tool calls use: its label is the client name.
    d.gcRestSessions(Date.now() + 10 * 3_600_000);
    expect((await rest(base, "/v1/status", d.cfg.secret)).body.restSessions).toBe(1);
  });
  it("one stream per key: a new stream replaces and closes the old one; the link stays", async () => {
    await boot();
    const a = await openInbox(d.cfg.secret);
    const b = await openInbox(d.cfg.secret);
    await a.ended;
    expect(b.isEnded()).toBe(false);
    expect((await list()).find((x) => x.id === AGENT)).toMatchObject({ linked: true });
  });
  it("keyed by the full restKey: a token principal opens its own stream and both stay open", async () => {
    await boot();
    const tok = createToken(d.cfg, "ci", "act");
    saveConfig(d.cfg);
    const a = await openInbox(d.cfg.secret);
    const b = await openInbox(tok, proxyHeaders("100-aaaaaa", { "x-tabagent-agent-pid": "77" }));
    expect(b.status).toBe(200);
    await until(() => b.events.length > 0);
    expect(b.events[0].data.sessionId).toBe("mcp:ci:100-aaaaaa");
    expect(a.isEnded()).toBe(false);
    const agents = await list();
    expect(agents.filter((x) => x.linked).map((x) => x.pid).sort((a, b) => a - b)).toEqual([77, PID]);
  });
  it("stream close -> the agent is unlinked at once", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret);
    expect((await list()).find((x) => x.id === AGENT)).toMatchObject({ linked: true, canDriveTab: true, delivery: "piggyback" });
    s.close();
    await until(() => d.agents.inbox.size === 0);
    expect((await list()).find((x) => x.id === AGENT)).toMatchObject({ linked: false, canDriveTab: false, delivery: "none" });
  });
  it("no agent pid header -> registered but links nothing (e.g. Cursor); unlinked streams are not listed", async () => {
    await boot();
    const h = proxyHeaders();
    delete (h as Record<string, string>)["x-tabagent-agent-pid"];
    await openInbox(d.cfg.secret, h);
    await until(() => d.agents.inbox.size === 1);
    const agents = await list();
    expect(agents.every((a) => !a.linked)).toBe(true);
    expect(agents).toHaveLength(2);
  });
  it("other methods on /v1/inbox are 404", async () => {
    await boot();
    expect((await rest(base, "/v1/inbox", d.cfg.secret, {})).status).toBe(404);
  });
});

describe("POST /v1/inbox/ack (AD5)", () => {
  it("pushes carry {msgId}; the same key acks once; other keys and unknown ids are 404", async () => {
    await boot();
    const tok = createToken(d.cfg, "ci", "act");
    saveConfig(d.cfg);
    const s = await openInbox(d.cfg.secret);
    const msgId = d.agents.inbox.push("local:100-aaaaaa", { content: "hello" });
    expect(msgId).toBeTruthy();
    await until(() => s.events.some((e) => e.event === "message"));
    expect(s.events.find((e) => e.event === "message")!.data).toEqual({ msgId, content: "hello" });
    const ack = (token: string, body: unknown, session = "100-aaaaaa") => rest(base, "/v1/inbox/ack", token, body, { "x-tabagent-session": session });
    expect((await ack(tok, { msgId })).status).toBe(404);
    expect((await ack(d.cfg.secret, { msgId }, "other")).status).toBe(404);
    expect((await ack(d.cfg.secret, { msgId })).body).toEqual({ ok: true });
    expect((await ack(d.cfg.secret, { msgId })).status).toBe(404);
    expect((await ack(d.cfg.secret, { nope: 1 })).status).toBe(400);
  });
  it("never buffers: a push to a key with no live stream is refused", async () => {
    await boot();
    expect(d.agents.inbox.push("local:nobody", { content: "x" })).toBeNull();
  });
});

describe("piggyback route (AD6, AD7, AD8)", () => {
  it("held, then attached to the next successful tool result as userMessages; delivered after the response", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    const sent = await send({ requestId: "pb1", prompt: "Check the build" });
    expect(sent).toEqual({ type: "agent.sent", requestId: "pb1", route: "piggyback", state: "held" });
    const r = await tool();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.userMessages).toEqual([`${H}\nCheck the build`]);
    expect(await status("pb1")).toMatchObject({ type: "agent.status", requestId: "pb1", state: "delivered" });
    // Delivered once only.
    expect((await tool()).body.userMessages).toBeUndefined();
  });
  it("FIFO, up to 3 held; the 4th fails with QUEUE_FULL", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    for (const n of [1, 2, 3]) expect((await send({ requestId: `f${n}`, prompt: `m${n}` })).state).toBe("held");
    expect(await send({ requestId: "f4", prompt: "m4" })).toMatchObject({ route: "piggyback", state: "failed", code: "QUEUE_FULL" });
    expect((await tool()).body.userMessages).toEqual([`${H}\nm1`, `${H}\nm2`, `${H}\nm3`]);
  });
  it("error results never carry messages; the next successful one does", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "e1" });
    ext.onCommand = () => ({ ok: false, error: { code: "NOT_FOUND", message: "no tab" }, audit: { tool: "tabs", origin: null, params: {}, outcome: "error" } });
    const bad = await tool();
    expect(bad.body.ok).toBe(false);
    expect(bad.body.userMessages).toBeUndefined();
    ext.onCommand = (cmd) => okEnvelope({ tabs: [] }, cmd.tool);
    expect((await tool()).body.userMessages).toEqual([`${H}\nPlease look`]);
    expect(await status("e1")).toMatchObject({ state: "delivered" });
  });
  it("only the linked session's own calls carry the messages", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "o1" });
    expect((await tool("someone-else")).body.userMessages).toBeUndefined();
    expect((await tool()).body.userMessages).toHaveLength(1);
  });
  it("a held message expires after the TTL (agent.status expired)", async () => {
    await boot({ holdTtlMs: 150 });
    await openInbox(d.cfg.secret);
    expect((await send({ requestId: "t1" })).state).toBe("held");
    expect(await status("t1", 2000)).toMatchObject({ state: "expired" });
    expect((await tool()).body.userMessages).toBeUndefined();
  });
  it("session end -> held messages expire", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "s1" });
    await rest(base, "/v1/session/end", d.cfg.secret, {}, { "x-tabagent-mcp": "1", "x-tabagent-session": "100-aaaaaa" });
    expect(await status("s1")).toMatchObject({ state: "expired" });
  });
  it("stream gone -> held messages expire and the agent is no longer linked", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret);
    await send({ requestId: "g1" });
    s.close();
    expect(await status("g1")).toMatchObject({ state: "expired" });
    // #137: once unlinked, a plain send never spawns; only an explicit forceSpawn does.
    claude.set("bg.out", "backgrounded · 0badc0de\n");
    expect(await send({ requestId: "g2" })).toMatchObject({ route: "none", state: "failed", code: "NO_ROUTE" });
    expect(claude.read("bg.text")).toBeNull();
    expect(await send({ requestId: "g3", forceSpawn: true })).toMatchObject({ route: "spawn", state: "started" });
  });
  it("a replaced stream keeps the held messages (same key)", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "k1" });
    await openInbox(d.cfg.secret);
    expect((await tool()).body.userMessages).toHaveLength(1);
  });
  it("forceSpawn: 'Start new session instead' spawns and drops what was held (expired)", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "h1" });
    claude.set("bg.out", "backgrounded · 0badc0de\n");
    expect(await send({ requestId: "h2", forceSpawn: true, prompt: "Fresh start" })).toMatchObject({ route: "spawn", state: "started" });
    expect(await status("h1")).toMatchObject({ state: "expired" });
    expect(claude.read("bg.text")).toBe(`${H}\nFresh start`);
    expect((await tool()).body.userMessages).toBeUndefined();
  });
  it("audits held and delivered with the same requestId", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "a1" });
    await tool();
    await status("a1");
    const { readFileSync } = await import("node:fs");
    const ev = readFileSync(d.audit.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === "agent.send" && r.data?.requestId === "a1")
      .map((r) => [r.data.route, r.data.state]);
    expect(ev).toEqual([
      ["piggyback", "held"],
      ["piggyback", "delivered"],
    ]);
  });
});

describe("tab grant on Send (AD11, AD12, AD15, §6 step 4)", () => {
  const page = { includeTab: true, tabId: 5, title: "Docs", url: "https://docs.test/a?token=zzz" };
  const WITH_TAB = "Browser tab 5 is now in your TabAgent tab group (use tabId 5).";
  const NO_TAB = "The user was looking at this page (you do not have browser access to it):";
  /** Answer the next agent.grant with this reply (or stay silent); resolves to the grant message. */
  const answerGrant = async (reply: Record<string, unknown> | null) => {
    const g = await ext.next("agent.grant", () => true, 3000);
    if (reply) ext.send({ type: "agent.granted", requestId: g.requestId, ...reply });
    return g;
  };
  const sendAsync = async (fields: Record<string, unknown>) => {
    ext.send({ type: "agent.send", agentId: AGENT, prompt: "Please look", ...fields });
    const sent = await ext.next("agent.sent", (m) => m.requestId === fields.requestId, 8000);
    expect(AgentSentSchema.safeParse(sent).success).toBe(true);
    const { __seen: _s, ...wire } = sent;
    return wire;
  };
  const audits = async (requestId: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(d.audit.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === "agent.send" && r.data?.requestId === requestId)
      .map((r) => r.data);
  };

  it("canDriveTab target with a tab: agent.grant {requestId, meta, tabId} goes out before agent.sent; ok -> the with-tab template", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    const sent = sendAsync({ requestId: "g-ok", ...page });
    const g = await answerGrant({ ok: true, added: true });
    expect(g).toMatchObject({ type: "agent.grant", requestId: "g-ok", tabId: 5, meta: { id: "mcp:local:100-aaaaaa", cap: "full", sites: [] } });
    // §6: nothing is composed or delivered before the grant answer.
    expect(ext.msgs.some((m) => m.type === "agent.sent" && m.requestId === "g-ok")).toBe(false);
    expect(await sent).toEqual({ type: "agent.sent", requestId: "g-ok", route: "piggyback", state: "held" });
    const [m] = (await tool()).body.userMessages;
    expect(m).toContain(WITH_TAB);
    expect(m).not.toContain(NO_TAB);
    const [ev] = await audits("g-ok");
    expect(ev.grant).toEqual({ sessionId: "mcp:local:100-aaaaaa", tabId: 5, ok: true });
    expect(ev.tabOrigin).toBe("https://docs.test");
  });

  it.each(["TAB_BUSY", "PERMISSION_DENIED", "NOT_FOUND"])("refused with %s -> the no-tab template and 'tab not shared: <code>'", async (code) => {
    await boot();
    await openInbox(d.cfg.secret);
    const sent = sendAsync({ requestId: `g-${code}`, ...page });
    await answerGrant({ ok: false, code });
    expect(await sent).toEqual({ type: "agent.sent", requestId: `g-${code}`, route: "piggyback", state: "held", detail: `tab not shared: ${code}` });
    const [m] = (await tool()).body.userMessages;
    expect(m).toContain(NO_TAB);
    expect(m).not.toContain("is now in your TabAgent tab group");
    const [ev] = await audits(`g-${code}`);
    expect(ev.grant).toEqual({ sessionId: "mcp:local:100-aaaaaa", tabId: 5, ok: false, code });
  });

  it("no agent.granted within the timeout -> TIMEOUT and the no-tab template; a late ok that attached the tab releases it", async () => {
    await boot({ grantTimeoutMs: 100 });
    await openInbox(d.cfg.secret);
    const sent = sendAsync({ requestId: "g-slow", ...page });
    const g = await answerGrant(null);
    expect(await sent).toMatchObject({ state: "held", detail: "tab not shared: TIMEOUT" });
    expect((await tool()).body.userMessages[0]).toContain(NO_TAB);
    ext.send({ type: "agent.granted", requestId: g.requestId, ok: true, added: true });
    expect(await ext.next("agent.release", () => true, 2000)).toMatchObject({ type: "agent.release", sessionId: "mcp:local:100-aaaaaa", tabId: 5 });
  });

  it("no grant without includeTab, without a tabId, or for an unlinked (spawn) target", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    await send({ requestId: "ng1", includeTab: false });
    await send({ requestId: "ng2", includeTab: true, title: "Docs", url: "https://docs.test/a" });
    claude.set("bg.out", "backgrounded · 0badc0de\n");
    expect(await send({ requestId: "ng3", ...page, agentId: "claude:77:1000", forceSpawn: true })).toMatchObject({ route: "spawn", state: "started" });
    expect(claude.read("bg.text")).toContain(NO_TAB);
    expect(ext.msgs.some((m) => m.type === "agent.grant")).toBe(false);
    expect((await audits("ng1"))[0].grant).toBeUndefined();
  });

  it("a token-scoped linked session: the grant carries the token's cap and sites so the worker can refuse", async () => {
    await boot();
    const tok = createToken(d.cfg, "ci", "read", ["docs.test"]);
    saveConfig(d.cfg);
    await openInbox(tok, proxyHeaders("100-aaaaaa", { "x-tabagent-agent-pid": "77" }));
    const sent = sendAsync({ requestId: "g-tok", ...page, agentId: "claude:77:1000" });
    const g = await answerGrant({ ok: false, code: "PERMISSION_DENIED" });
    expect(g.meta).toMatchObject({ id: "mcp:ci:100-aaaaaa", label: "ci", cap: "read", sites: ["docs.test"] });
    expect(await sent).toMatchObject({ detail: "tab not shared: PERMISSION_DENIED" });
  });

  it("an expired message that attached the tab releases it; one that found the tab already in the session does not", async () => {
    await boot({ holdTtlMs: 300 });
    await openInbox(d.cfg.secret);
    const a = sendAsync({ requestId: "r-new", ...page });
    await answerGrant({ ok: true, added: true });
    await a;
    const b = sendAsync({ requestId: "r-old", ...page, tabId: 6 });
    await answerGrant({ ok: true, added: false });
    await b;
    expect(await status("r-new", 2000)).toMatchObject({ state: "expired" });
    expect(await status("r-old", 2000)).toMatchObject({ state: "expired" });
    expect(await ext.next("agent.release", () => true, 2000)).toMatchObject({ sessionId: "mcp:local:100-aaaaaa", tabId: 5 });
    await new Promise((r) => setTimeout(r, 100));
    expect(ext.msgs.filter((m) => m.type === "agent.release")).toHaveLength(1);
  });

  it("stream gone: the held message expires and its tab is released", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret);
    const a = sendAsync({ requestId: "r-gone", ...page });
    await answerGrant({ ok: true, added: true });
    await a;
    s.close();
    expect(await status("r-gone")).toMatchObject({ state: "expired" });
    expect(await ext.next("agent.release", () => true, 2000)).toMatchObject({ tabId: 5 });
  });

  it("a delivered message never releases its tab", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    const a = sendAsync({ requestId: "r-dl", ...page });
    await answerGrant({ ok: true, added: true });
    await a;
    await tool();
    expect(await status("r-dl")).toMatchObject({ state: "delivered" });
    expect(ext.msgs.some((m) => m.type === "agent.release")).toBe(false);
  });

  it("a full hold queue fails with QUEUE_FULL before any grant is asked for", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    for (const n of [1, 2, 3]) await send({ requestId: `qf${n}` });
    expect(await send({ requestId: "qf4", ...page })).toMatchObject({ state: "failed", code: "QUEUE_FULL" });
    expect(ext.msgs.some((m) => m.type === "agent.grant")).toBe(false);
  });

  it("a malformed agent.granted or one for an unknown requestId is ignored", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    ext.send({ type: "agent.granted", requestId: "nobody", ok: true, added: true });
    ext.send({ type: "agent.granted", requestId: 5 });
    await send({ requestId: "after" });
    expect(ext.msgs.some((m) => m.type === "agent.release")).toBe(false);
  });
});

describe("channel route (AD6, AD7, AD9: P3)", () => {
  const chan = (session = "100-aaaaaa") => proxyHeaders(session, { "x-tabagent-channels": "1" });
  const ack = (msgId: string, session = "100-aaaaaa") => rest(base, "/v1/inbox/ack", d.cfg.secret, { msgId }, { "x-tabagent-session": session });
  const pushes = (s: Inbox) => s.events.filter((e) => e.event === "message").map((e) => e.data);

  it("a linked Claude agent whose proxy reported channels=1 is listed with delivery channel", async () => {
    await boot();
    await openInbox(d.cfg.secret, chan());
    expect((await list()).find((x) => x.id === AGENT)).toMatchObject({ linked: true, delivery: "channel" });
  });
  it("pushes {msgId, kind: channel, content} on the stream; sent only after the proxy acks (never delivered)", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret, chan());
    ext.send({ type: "agent.send", requestId: "c1", agentId: AGENT, prompt: "Reply with CHANNEL-OK", includeTab: false });
    await until(() => pushes(s).length === 1);
    const [p] = pushes(s);
    expect(p).toEqual({ msgId: expect.any(String), kind: "channel", content: `${H}\nReply with CHANNEL-OK` });
    // Not yet acked: no reply.
    await new Promise((r) => setTimeout(r, 50));
    expect(ext.msgs.some((m) => m.type === "agent.sent" && m.requestId === "c1")).toBe(false);
    expect((await ack(p.msgId)).body).toEqual({ ok: true });
    const sent = await ext.next("agent.sent", (m) => m.requestId === "c1");
    const { __seen: _s, ...wire } = sent;
    expect(wire).toEqual({ type: "agent.sent", requestId: "c1", route: "channel", state: "sent" });
    // Nothing is held for piggyback, so the next tool result carries no copy.
    expect((await tool()).body.userMessages).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(ext.msgs.some((m) => m.type === "agent.status" && m.requestId === "c1")).toBe(false);
  });
  it("tab grant on the channel route: the pushed content uses the with-tab template once the grant is ok", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret, chan());
    ext.send({ type: "agent.send", requestId: "cg1", agentId: AGENT, prompt: "Look", includeTab: true, tabId: 5, title: "Docs", url: "https://docs.test/a" });
    const g = await ext.next("agent.grant", () => true);
    expect(pushes(s)).toHaveLength(0);
    ext.send({ type: "agent.granted", requestId: g.requestId, ok: true, added: true });
    await until(() => pushes(s).length === 1);
    expect(pushes(s)[0].content).toContain("Browser tab 5 is now in your TabAgent tab group (use tabId 5).");
    await ack(pushes(s)[0].msgId);
    expect(await ext.next("agent.sent", (m) => m.requestId === "cg1")).toMatchObject({ route: "channel", state: "sent" });
    expect(ext.msgs.some((m) => m.type === "agent.release")).toBe(false);
  });
  it("tab grant on the channel route: a refusal notes it; an unacked push releases a tab the grant added", async () => {
    await boot({ channelAckTimeoutMs: 150 });
    await openInbox(d.cfg.secret, chan());
    ext.send({ type: "agent.send", requestId: "cg2", agentId: AGENT, prompt: "Look", includeTab: true, tabId: 5, title: "Docs", url: "https://docs.test/a" });
    const g = await ext.next("agent.grant", () => true);
    ext.send({ type: "agent.granted", requestId: g.requestId, ok: true, added: true });
    expect(await ext.next("agent.sent", (m) => m.requestId === "cg2")).toMatchObject({ route: "channel", state: "failed", code: "CHANNEL_TIMEOUT" });
    expect(await ext.next("agent.release", () => true)).toMatchObject({ tabId: 5 });
  });
  it("no ack within the timeout -> failed CHANNEL_TIMEOUT", async () => {
    await boot({ channelAckTimeoutMs: 150 });
    const s = await openInbox(d.cfg.secret, chan());
    const sent = await send({ requestId: "c2" });
    expect(sent).toMatchObject({ route: "channel", state: "failed", code: "CHANNEL_TIMEOUT" });
    expect(sent.detail).toMatch(/did not confirm/);
    // A late ack is refused.
    expect((await ack(pushes(s)[0].msgId)).status).toBe(404);
  });
  it("the stream closes before the ack -> failed AGENT_GONE", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret, chan());
    ext.send({ type: "agent.send", requestId: "c3", agentId: AGENT, prompt: "x", includeTab: false });
    await until(() => pushes(s).length === 1);
    s.close();
    const sent = await ext.next("agent.sent", (m) => m.requestId === "c3");
    expect(sent).toMatchObject({ route: "channel", state: "failed", code: "AGENT_GONE", detail: "The agent's TabAgent connection closed" });
  });
  it("channels=0 falls back to piggyback (held)", async () => {
    await boot();
    await openInbox(d.cfg.secret);
    expect(await send({ requestId: "c4" })).toMatchObject({ route: "piggyback", state: "held" });
  });
  it("audits the channel send with route channel and state sent", async () => {
    await boot();
    const s = await openInbox(d.cfg.secret, chan());
    ext.send({ type: "agent.send", requestId: "c5", agentId: AGENT, prompt: "x", includeTab: false });
    await until(() => pushes(s).length === 1);
    await ack(pushes(s)[0].msgId);
    await ext.next("agent.sent", (m) => m.requestId === "c5");
    const { readFileSync } = await import("node:fs");
    await until(() => readFileSync(d.audit.path, "utf8").includes('"c5"'));
    const ev = readFileSync(d.audit.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === "agent.send" && r.data?.requestId === "c5")
      .map((r) => [r.data.route, r.data.state]);
    expect(ev).toEqual([["channel", "sent"]]);
  });
});

describe("POST /v1/inbox/event (AD9: ignored channel permission requests are audited)", () => {
  const event = (body: unknown, token = d.cfg.secret) => rest(base, "/v1/inbox/event", token, body, { "x-tabagent-mcp": "1", "x-tabagent-session": "100-aaaaaa" });
  it("audits channel.permission_ignored with the method and the session; nothing else is accepted", async () => {
    await boot();
    expect((await event({ event: "channel.permission_ignored", method: "notifications/claude/channel/permission_request" })).body).toEqual({ ok: true });
    expect((await event({ event: "something.else", method: "x" })).status).toBe(400);
    expect((await event({ event: "channel.permission_ignored", method: "x".repeat(201) })).status).toBe(400);
    expect((await event({ event: "channel.permission_ignored", method: "x" }, "nope")).status).toBe(401);
    const { readFileSync } = await import("node:fs");
    const ev = readFileSync(d.audit.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === "agent.channel_permission_ignored");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toEqual({ method: "notifications/claude/channel/permission_request", session: "mcp:local:100-aaaaaa" });
  });
});
