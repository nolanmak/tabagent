// Pure rules for linking and piggyback (spec AD4, AD5, AD8): the ancestor walk over an injected `ps`,
// the inbox stream registry, the hold queue, SSE parsing and backoff in the proxy, and rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSchema, PIGGYBACK_LIMITS, type ToolDef } from "@tabagent/protocol";
import { findAgentPid, isAgentComm, parsePsLine, type PsInfo } from "../src/agents/ancestry";
import { HoldQueue, type HeldMessage } from "../src/agents/hold";
import { InboxRegistry, parseInboxHeaders, profileCanDriveTab, type InboxConn } from "../src/agents/inbox";
import { mergeAgents, parseClaudeAgents, toAgent } from "../src/agents/discovery";
import { renderMcp } from "../src/format";
import { INSTRUCTIONS } from "../src/mcp";
import { createSseParser, INBOX_BACKOFF, nextBackoff } from "../src/inbox-client";
import { claudeRecord } from "./agents-fakes";

/** A process table: pid -> [ppid, comm]. */
function table(rows: Record<number, [number, string]>) {
  const asked: number[] = [];
  const ps = async (pid: number): Promise<PsInfo | null> => {
    asked.push(pid);
    const r = rows[pid];
    return r ? { ppid: r[0], comm: r[1] } : null;
  };
  return { ps, asked };
}

describe("ancestor walk (AD4, spike §1)", () => {
  it("documented npx install: tabagent mcp -> npm exec -> claude finds claude two levels up", async () => {
    // Walk starts at the proxy's parent (npm exec).
    const { ps } = table({ 5969: [5918, "npm exec @nolmak/tabagent mcp"], 5918: [1, "claude"] });
    expect(await findAgentPid(5969, ps)).toBe(5918);
  });
  it("direct parent is claude", async () => {
    const { ps } = table({ 77: [1, "claude"] });
    expect(await findAgentPid(77, ps)).toBe(77);
  });
  it("codex reports a full path as comm: match the basename", async () => {
    const { ps } = table({ 30: [20, "node"], 20: [1, "/Applications/Codex.app/Contents/Resources/codex"] });
    expect(await findAgentPid(30, ps)).toBe(20);
  });
  it("not found: walks to init and returns undefined", async () => {
    const { ps, asked } = table({ 30: [20, "node"], 20: [10, "zsh"], 10: [1, "login"] });
    expect(await findAgentPid(30, ps)).toBeUndefined();
    expect(asked).toEqual([30, 20, 10]);
  });
  it("ps fails or the pid is gone: undefined", async () => {
    expect(await findAgentPid(30, async () => null)).toBeUndefined();
    expect(await findAgentPid(30, async () => Promise.reject(new Error("no ps")))).toBeUndefined();
    expect(await findAgentPid(0, async () => ({ ppid: 0, comm: "claude" }))).toBeUndefined();
  });
  it("depth guard: at most 8 levels", async () => {
    const rows: Record<number, [number, string]> = {};
    for (let p = 100; p < 120; p++) rows[p] = [p + 1, "node"];
    rows[120] = [1, "claude"];
    const { ps, asked } = table(rows);
    expect(await findAgentPid(100, ps)).toBeUndefined();
    expect(asked).toHaveLength(8);
    rows[107] = [1, "claude"];
    expect(await findAgentPid(100, ps)).toBe(107);
  });
  it("loop guard: a cycle in the table stops the walk", async () => {
    const { ps, asked } = table({ 5: [6, "node"], 6: [5, "sh"] });
    expect(await findAgentPid(5, ps)).toBeUndefined();
    expect(asked).toEqual([5, 6]);
  });
  it("matches only an executable named claude or codex", () => {
    expect(isAgentComm("claude")).toBe(true);
    expect(isAgentComm("/usr/local/bin/claude")).toBe(true);
    expect(isAgentComm("~/.codex/packages/app-server-daemon/1/bin/codex")).toBe(true);
    expect(isAgentComm("claude-helper")).toBe(false);
    expect(isAgentComm("node")).toBe(false);
    expect(isAgentComm("")).toBe(false);
  });
  it("parses `ps -o ppid=,comm=` output, including a comm with spaces", () => {
    expect(parsePsLine("  5918 claude\n")).toEqual({ ppid: 5918, comm: "claude" });
    expect(parsePsLine("1 /Applications/My Tools/codex")).toEqual({ ppid: 1, comm: "/Applications/My Tools/codex" });
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("garbage")).toBeNull();
  });
});

function conn() {
  const c = { writes: [] as { event: string; data: any }[], closed: false } as { writes: { event: string; data: any }[]; closed: boolean } & InboxConn;
  c.write = (event, data) => void c.writes.push({ event, data });
  c.close = () => void (c.closed = true);
  return c;
}
const info = (extra: Record<string, unknown> = {}) => ({ sessionId: "mcp:local:1-aa", client: "claude-code", channels: false, profile: "core", ...extra });

describe("inbox stream registry (AD5)", () => {
  it("one stream per key: the newest replaces and closes the old; closing the old one later is a no-op", () => {
    const closed: string[] = [];
    const r = new InboxRegistry({ onClosed: (k) => closed.push(k) });
    const a = conn();
    const b = conn();
    r.open("local:1-aa", info({ agentPid: 10 }), a);
    r.open("local:1-aa", info({ agentPid: 10 }), b);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(r.size).toBe(1);
    expect(r.close("local:1-aa", a)).toBe(false);
    expect(closed).toEqual([]);
    expect(r.get("local:1-aa")?.conn).toBe(b);
    expect(r.close("local:1-aa", b)).toBe(true);
    expect(closed).toEqual(["local:1-aa"]);
    expect(r.size).toBe(0);
  });
  it("keys are per principal: the same session value under two principals is two streams", () => {
    const r = new InboxRegistry();
    r.open("local:1-aa", info(), conn());
    r.open("ci:1-aa", info(), conn());
    expect(r.size).toBe(2);
  });
  it("finds the stream for an agent pid; the newest wins when two proxies share one agent", () => {
    let t = 0;
    const r = new InboxRegistry({ now: () => ++t });
    r.open("k1", info({ agentPid: 10 }), conn());
    r.open("k2", info({ agentPid: 10 }), conn());
    r.open("k3", info({ agentPid: 11 }), conn());
    r.open("k4", info(), conn());
    expect(r.byAgentPid(10)?.key).toBe("k2");
    expect(r.byAgentPid(11)?.key).toBe("k3");
    expect(r.byAgentPid(12)).toBeUndefined();
  });
  it("push carries a msgId and is acked once by the same key; no live stream means no buffering", () => {
    let n = 0;
    const r = new InboxRegistry({ newId: () => `m${++n}` });
    const c = conn();
    r.open("k", info(), c);
    expect(r.push("nobody", { content: "x" })).toBeNull();
    const id = r.push("k", { content: "hi" });
    expect(id).toBe("m1");
    expect(c.writes).toEqual([{ event: "message", data: { msgId: "m1", content: "hi" } }]);
    expect(r.ack("other", "m1")).toBe(false);
    expect(r.ack("k", "m1")).toBe(true);
    expect(r.ack("k", "m1")).toBe(false);
  });
  it("unacked pushes are forgotten when the stream goes away", () => {
    const r = new InboxRegistry({ newId: () => "m" });
    const c = conn();
    r.open("k", info(), c);
    r.push("k", {});
    r.close("k", c);
    r.open("k", info(), conn());
    expect(r.ack("k", "m")).toBe(false);
  });
  it("closeAll closes every stream", () => {
    const r = new InboxRegistry();
    const a = conn();
    const b = conn();
    r.open("a", info(), a);
    r.open("b", info(), b);
    r.closeAll();
    expect(a.closed && b.closed).toBe(true);
    expect(r.size).toBe(0);
  });
});

describe("registration headers (AD4)", () => {
  it("parses pid, client, channels and profile; drops anything malformed", () => {
    expect(parseInboxHeaders({ "x-tabagent-agent-pid": "5918", "x-tabagent-client": "claude-code", "x-tabagent-channels": "1", "x-tabagent-profile": "core,auth" })).toEqual({ agentPid: 5918, client: "claude-code", channels: true, profile: "core,auth" });
    expect(parseInboxHeaders({})).toEqual({ client: "", channels: false, profile: "core" });
    expect(parseInboxHeaders({ "x-tabagent-agent-pid": "-3", "x-tabagent-channels": "yes", "x-tabagent-client": "a\u0000b<script>", "x-tabagent-profile": "core;rm" })).toEqual({ client: "abscript", channels: false, profile: "core" });
    expect(parseInboxHeaders({ "x-tabagent-agent-pid": "12abc" }).agentPid).toBeUndefined();
  });
  it("canDriveTab needs page_* or act_* tools in the profile", () => {
    expect(profileCanDriveTab("core")).toBe(true);
    expect(profileCanDriveTab("full")).toBe(true);
    expect(profileCanDriveTab("nonsense")).toBe(false);
    const authOnly = [{ name: "auth.status", group: "auth", profiles: ["auth"] }] as unknown as ToolDef[];
    expect(profileCanDriveTab("auth", authOnly)).toBe(false);
    const withAct = [...authOnly, { name: "act.click", group: "act", profiles: ["auth"] }] as unknown as ToolDef[];
    expect(profileCanDriveTab("auth", withAct)).toBe(true);
  });
});

describe("linking in discovery (AD4)", () => {
  it("a linked claude agent: linked, canDriveTab from the profile, delivery piggyback", () => {
    const [base] = parseClaudeAgents(JSON.stringify([claudeRecord(10, 1000)]));
    const a = toAgent(base, { canDriveTab: true, channels: false });
    expect(a).toMatchObject({ linked: true, canDriveTab: true, delivery: "piggyback" });
    expect(AgentSchema.safeParse(a).success).toBe(true);
    expect(toAgent(base, { canDriveTab: false, channels: false })).toMatchObject({ linked: true, canDriveTab: false, delivery: "piggyback" });
    expect(toAgent(base, null)).toMatchObject({ linked: false, canDriveTab: false, delivery: "spawn" });
  });
  it("mergeAgents applies the link lookup per agent", () => {
    const bases = parseClaudeAgents(JSON.stringify([claudeRecord(10, 1000), claudeRecord(11, 2000)]));
    const all = mergeAgents([bases], (a) => (a.pid === 10 ? { canDriveTab: true, channels: false } : null));
    expect(all.map((a) => [a.id, a.linked, a.delivery])).toEqual([
      ["claude:11:2000", false, "spawn"],
      ["claude:10:1000", true, "piggyback"],
    ]);
  });
});

type M = HeldMessage & { n: number };
const msg = (n: number): M => ({ requestId: `r${n}`, text: `t${n}`, n });

describe("hold queue (AD8)", () => {
  let expired: [string, string][];
  let now: number;
  let q: HoldQueue<M>;
  beforeEach(() => {
    vi.useFakeTimers();
    expired = [];
    now = 0;
    q = new HoldQueue<M>({ ttlMs: 1000, now: () => now, onExpire: (m, reason) => expired.push([m.requestId, reason]) });
  });
  afterEach(() => {
    q.stop();
    vi.useRealTimers();
  });

  it("defaults: 3 per session, 30 min", () => {
    expect(PIGGYBACK_LIMITS).toEqual({ maxHeld: 3, ttlMs: 1_800_000 });
    const d = new HoldQueue<M>({ onExpire: () => {} });
    expect([d.max, d.ttlMs]).toEqual([3, 1_800_000]);
  });
  it("FIFO; the 4th is refused; take empties the session", () => {
    expect(["held", "held", "held", "full"]).toEqual([1, 2, 3, 4].map((n) => q.hold("k", msg(n))));
    expect(q.count("k")).toBe(3);
    expect(q.take("k").map((m) => m.n)).toEqual([1, 2, 3]);
    expect(q.take("k")).toEqual([]);
    expect(q.hold("k", msg(5))).toBe("held");
  });
  it("the cap is per session", () => {
    for (const n of [1, 2, 3]) q.hold("a", msg(n));
    expect(q.hold("b", msg(4))).toBe("held");
  });
  it("TTL: a held message expires after ttlMs and is never handed out", () => {
    q.hold("k", msg(1));
    now = 500;
    q.hold("k", msg(2));
    now = 1000;
    vi.advanceTimersByTime(1000);
    expect(expired).toEqual([["r1", expect.stringContaining("30")]]);
    expect(q.take("k").map((m) => m.n)).toEqual([2]);
  });
  it("take skips anything past its TTL even before its timer fires", () => {
    q.hold("k", msg(1));
    now = 2000;
    expect(q.take("k")).toEqual([]);
    expect(expired.map((e) => e[0])).toEqual(["r1"]);
  });
  it("taken messages no longer expire", () => {
    q.hold("k", msg(1));
    q.take("k");
    vi.advanceTimersByTime(5000);
    expect(expired).toEqual([]);
  });
  it("drop expires everything held for the session with the reason (session end, stream gone, spawn)", () => {
    q.hold("k", msg(1));
    q.hold("k", msg(2));
    q.hold("j", msg(3));
    q.drop("k", "The agent's TabAgent session ended");
    expect(expired).toEqual([
      ["r1", "The agent's TabAgent session ended"],
      ["r2", "The agent's TabAgent session ended"],
    ]);
    expect(q.count("k")).toBe(0);
    expect(q.count("j")).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(expired.map((e) => e[0])).toEqual(["r1", "r2", "r3"]);
  });
  it("restore puts messages back at the front with their original deadline", () => {
    q.hold("k", msg(1));
    q.hold("k", msg(2));
    const taken = q.take("k");
    q.hold("k", msg(3));
    q.restore("k", taken);
    expect(q.count("k")).toBe(3);
    now = 1000;
    vi.advanceTimersByTime(1000);
    expect(expired.map((e) => e[0]).sort()).toEqual(["r1", "r2", "r3"]);
  });
  it("restore expires a message whose TTL already passed", () => {
    q.hold("k", msg(1));
    const taken = q.take("k");
    now = 5000;
    q.restore("k", taken);
    expect(expired.map((e) => e[0])).toEqual(["r1"]);
    expect(q.count("k")).toBe(0);
  });
  it("stop clears timers without expiring (a daemon restart loses held messages)", () => {
    q.hold("k", msg(1));
    q.stop();
    vi.advanceTimersByTime(5000);
    expect(expired).toEqual([]);
  });
});

describe("proxy: SSE parsing and reconnect backoff (AD5)", () => {
  it("parses events split across chunks, ignores comments, joins multi-line data", () => {
    const got: { event: string; data: string }[] = [];
    const feed = createSseParser((e) => got.push(e));
    feed(": ping\n\nevent: ready\nda");
    feed('ta: {"sessionId":"s"}\n\n');
    feed("event: message\r\ndata: a\r\ndata: b\r\n\r\ndata: plain\n\n");
    expect(got).toEqual([
      { event: "ready", data: '{"sessionId":"s"}' },
      { event: "message", data: "a\nb" },
      { event: "message", data: "plain" },
    ]);
  });
  it("backoff doubles from 1 s and caps at 30 s", () => {
    expect(INBOX_BACKOFF).toEqual({ minMs: 1000, maxMs: 30_000 });
    const seq: number[] = [];
    let d: number | undefined;
    for (let i = 0; i < 7; i++) seq.push((d = nextBackoff(d)));
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("rendering userMessages (AD8)", () => {
  const H = "[TabAgent: message from the user via the side panel]";
  it("each message is its own text block before the tool output, outside any PAGE_DATA wrapper", () => {
    const r = renderMcp({ ok: true, result: { tabId: 3, text: "<<<PAGE_DATA n\nhello\nPAGE_DATA n>>>" }, userMessages: [`${H}\nfirst`, `${H}\nsecond`] });
    expect(r.content.map((c) => (c.type === "text" ? c.text.split("\n")[0] : c.type))).toEqual([H, H, '{"tabId":3}']);
    expect(r.content[0]).toEqual({ type: "text", text: `${H}\nfirst` });
    expect(r.content[1]).toEqual({ type: "text", text: `${H}\nsecond` });
    expect(r.content[2].type === "text" && r.content[2].text).not.toContain(H);
  });
  it("before an image too; never on an error result; non-strings ignored", () => {
    const img = renderMcp({ ok: true, result: { dataBase64: "AAA", mime: "image/png" }, userMessages: [`${H}\nx`] });
    expect(img.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
    expect(img.content[0]).toEqual({ type: "text", text: `${H}\nx` });
    const err = renderMcp({ ok: false, error: { code: "TIMEOUT", message: "slow" }, userMessages: [`${H}\nx`] });
    expect(err.content).toHaveLength(1);
    expect(err.content[0].type === "text" && err.content[0].text).toBe("TIMEOUT: slow");
    expect(renderMcp({ ok: true, result: "ok", userMessages: [1 as unknown as string] }).content).toHaveLength(1);
  });
});

describe("INSTRUCTIONS (AD8)", () => {
  it("tells the agent that panel message blocks are the user's own request", () => {
    expect(INSTRUCTIONS).toContain(
      "Content blocks that start with [TabAgent: message from the user via the side panel] are the user's own request; act on them after the current step.",
    );
  });
});
