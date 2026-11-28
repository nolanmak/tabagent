// #158 Timed tasks: the TaskLog reducer, the TaskTracker (explicit, implicit, idle split, session end,
// recovery) and the daemon wiring (task tools, durationMs, tasks.list / tasks.label, tasks.changed).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditWriter } from "../src/audit";
import type { Daemon } from "../src/daemon";
import { auditFiles, parseAuditText, TaskLog, taskLogFromFiles, TaskTracker, type AuditLine } from "../src/tasks";
import { okEnvelope, pairedExt, rest, startDaemon, tempHome } from "./helpers";

const lines = (p: string): AuditLine[] => parseAuditText(readFileSync(p, "utf8"));
const iso = (n: number) => new Date(n).toISOString();

/** A tracker over an in-memory log, with a clock we move by hand. */
function rig(opts: { idleMs?: number; explicitIdleMs?: number } = {}) {
  let t = 1_000_000;
  let n = 0;
  const log = new TaskLog();
  const written: AuditLine[] = [];
  const write = (l: AuditLine) => {
    written.push(l);
    log.apply(l);
  };
  const tracker = new TaskTracker({
    log,
    now: () => t,
    newId: () => `t${++n}`,
    idleMs: () => opts.idleMs ?? 5 * 60_000,
    explicitIdleMs: () => opts.explicitIdleMs ?? 30 * 60_000,
    event: (event, data, who) => write({ ts: iso(t), event, data, ...(who ? { caller: who.caller } : {}) }),
  });
  const who = { caller: "claude-code", session: "S1" };
  /** One tool call that ends now and took `dur` ms. */
  const call = (tool = "act.click", dur = 100, w = who, extra: Partial<AuditLine> = {}) => {
    const taskId = tracker.stamp(w, { tool, durationMs: dur });
    write({ ts: iso(t), caller: w.caller, session: w.session, tool, origin: "https://shop.test", outcome: "ok", durationMs: dur, ...(taskId ? { taskId } : {}), ...extra });
    return taskId;
  };
  return { log, tracker, written, who, call, advance: (ms: number) => (t += ms), now: () => t };
}

describe("TaskLog reducer", () => {
  it("builds a summary from task.started, records with taskId, task.ended and task.labeled", () => {
    const log = new TaskLog();
    log.apply({ ts: iso(1000), event: "task.started", caller: "c", data: { taskId: "t1", session: "S", goal: "add cheese", explicit: true, startedAt: iso(1000) } });
    log.apply({ ts: iso(1300), tool: "nav.goto", origin: "https://a.test", outcome: "ok", durationMs: 200, taskId: "t1" });
    log.apply({ ts: iso(2000), tool: "act.click", action: undefined, origin: "https://a.test", outcome: "denied", errorCode: "PERMISSION_DENIED", durationMs: 50, taskId: "t1" });
    log.apply({ ts: iso(2100), tool: "page.snapshot", origin: "https://b.test", outcome: "error", taskId: "t1" });
    log.apply({ ts: iso(3000), event: "task.ended", data: { taskId: "t1", outcome: "success", endedAt: iso(3000), note: "done" } });
    const t = log.get("t1")!;
    expect(t).toMatchObject({ goal: "add cheese", explicit: true, session: "S", caller: "c", startedAt: 1000, endedAt: 3000, durationMs: 2000, outcome: "success", note: "done", callCount: 3, browserMs: 250, origins: ["https://a.test", "https://b.test"], lastAt: 2100 });
    // Call ts is the call's start (record ts minus its duration).
    expect(t.calls.map((c) => [c.tool, c.ts, c.outcome, c.durationMs])).toEqual([
      ["nav.goto", 1100, "ok", 200],
      ["act.click", 1950, "denied", 50],
      ["page.snapshot", 2100, "error", undefined],
    ]);
    expect(t.calls[1].errorCode).toBe("PERMISSION_DENIED");
    log.apply({ ts: iso(4000), event: "task.labeled", data: { taskId: "t1", outcome: "failed" } });
    expect(log.get("t1")).toMatchObject({ outcome: "failed", labeled: true });
  });

  it("ignores lines without a task and events for unknown tasks; keeps calls whose task.started rotated away", () => {
    const log = new TaskLog();
    expect(log.apply({ ts: iso(1), tool: "act.click", origin: null, outcome: "ok" })).toBeUndefined();
    expect(log.apply({ ts: iso(1), event: "killed" })).toBeUndefined();
    expect(log.apply({ ts: iso(1), event: "task.ended", data: { taskId: "nope" } })).toBeUndefined();
    expect(log.apply({ ts: iso(1), event: "task.labeled", data: { taskId: "nope", outcome: "success" } })).toBeUndefined();
    expect(log.apply({ ts: iso(1), event: "task.started", data: {} })).toBeUndefined();
    expect(log.apply(null as any)).toBeUndefined();
    log.apply({ ts: iso(5000), tool: "act.click", origin: null, outcome: "ok", durationMs: 100, taskId: "old", session: "S", caller: "c" });
    expect(log.get("old")).toMatchObject({ goal: null, explicit: false, startedAt: 4900, outcome: null, callCount: 1 });
    expect(log.openTasks().map((t) => t.taskId)).toEqual(["old"]);
  });

  it("an unknown outcome reads as unknown", () => {
    const log = new TaskLog();
    log.apply({ ts: iso(1), event: "task.started", data: { taskId: "t", startedAt: iso(1) } });
    log.apply({ ts: iso(2), event: "task.ended", data: { taskId: "t", outcome: "weird" } });
    expect(log.get("t")).toMatchObject({ outcome: "unknown", endedAt: 2 });
  });

  it("caps calls per task but still counts them", () => {
    const log = new TaskLog();
    log.apply({ ts: iso(0), event: "task.started", data: { taskId: "t", startedAt: iso(0) } });
    for (let i = 1; i <= 250; i++) log.apply({ ts: iso(i * 10), tool: "page.snapshot", origin: null, outcome: "ok", durationMs: 1, taskId: "t" });
    expect(log.get("t")!.calls).toHaveLength(200);
    expect(log.get("t")).toMatchObject({ callCount: 250, browserMs: 250 });
  });

  it("lists newest first and evicts the oldest ended task past max", () => {
    const log = new TaskLog(2);
    const start = (id: string, at: number) => log.apply({ ts: iso(at), event: "task.started", data: { taskId: id, startedAt: iso(at) } });
    start("a", 1);
    log.apply({ ts: iso(2), event: "task.ended", data: { taskId: "a", outcome: "success" } });
    start("b", 3);
    start("c", 4);
    expect(log.list().map((t) => t.taskId)).toEqual(["c", "b"]);
    start("d", 5); // nothing ended left: the oldest open one goes
    expect(log.list().map((t) => t.taskId)).toEqual(["d", "c"]);
    expect(log.list(1).map((t) => t.taskId)).toEqual(["d"]);
  });

  it("parseAuditText skips torn lines; taskLogFromFiles reads rotations oldest first and skips missing files", () => {
    const home = tempHome();
    const p = join(home, "audit.jsonl");
    writeFileSync(`${p}.1`, JSON.stringify({ ts: iso(1), event: "task.started", data: { taskId: "t", goal: "g", startedAt: iso(1) } }) + "\n{torn\n");
    writeFileSync(p, JSON.stringify({ ts: iso(9), tool: "act.click", origin: null, outcome: "ok", durationMs: 2, taskId: "t" }) + "\n\n42\n");
    expect(auditFiles(p, 3)).toEqual([`${p}.2`, `${p}.1`, p]);
    const log = taskLogFromFiles(auditFiles(p));
    expect(log.get("t")).toMatchObject({ goal: "g", callCount: 1, startedAt: 1 });
  });
});

describe("TaskTracker", () => {
  it("calls with no task.start open an implicit task; calls after the idle gap start a new one", () => {
    const r = rig({ idleMs: 60_000 });
    const a = r.call("nav.goto", 200);
    r.advance(10_000);
    expect(r.call("act.click", 100)).toBe(a);
    r.advance(60_000 + 100 + 1); // 60s + 1ms idle between the end of the last call and the start of this one
    const b = r.call("act.click", 100);
    expect(b).not.toBe(a);
    expect(r.log.get(a!)).toMatchObject({ explicit: false, goal: null, outcome: "unknown", callCount: 2, endedAt: r.log.get(a!)!.lastAt });
    expect(r.log.get(b!)).toMatchObject({ outcome: null, callCount: 1 });
    // A started task begins when its first call began.
    expect(r.log.get(a!)!.startedAt).toBe(1_000_000 - 200);
  });

  it("exactly the idle gap keeps the task", () => {
    const r = rig({ idleMs: 60_000 });
    const a = r.call("act.click", 0);
    r.advance(60_000);
    expect(r.call("act.click", 0)).toBe(a);
  });

  it("no session, no task; task.* records are never stamped", () => {
    const r = rig();
    expect(r.tracker.stamp({ caller: "x" }, { tool: "act.click" })).toBeUndefined();
    expect(r.tracker.stamp(r.who, { tool: "task.end" })).toBeUndefined();
    expect(r.tracker.stamp(r.who, { tool: 5 as any })).toBeUndefined();
    expect(r.written).toEqual([]);
  });

  it("task.start closes an open implicit task as unknown and stamps later calls with the explicit task", () => {
    const r = rig();
    const imp = r.call();
    r.advance(1000);
    const { taskId } = r.tracker.start(r.who, "Add mozzarella to my order");
    expect(r.log.get(imp!)).toMatchObject({ outcome: "unknown" });
    r.advance(500);
    expect(r.call("act.click", 300)).toBe(taskId);
    r.advance(1000);
    expect(r.tracker.end(r.who, { outcome: "success", note: "added 1" })).toEqual({ taskId, durationMs: 1500, callCount: 1 });
    expect(r.log.get(taskId)).toMatchObject({ explicit: true, goal: "Add mozzarella to my order", outcome: "success", note: "added 1", browserMs: 300 });
    expect(r.tracker.openTask("S1")).toBeUndefined();
  });

  it("task.start over an open explicit task abandons it; an empty task.start closes nothing", () => {
    const r = rig();
    const a = r.tracker.start(r.who, "first").taskId;
    r.advance(10);
    expect(() => r.tracker.start(r.who, "   ")).toThrow(/goal/);
    const b = r.tracker.start(r.who, "second").taskId;
    expect(r.log.get(a)).toMatchObject({ outcome: "abandoned" });
    expect(r.tracker.openTask("S1")?.taskId).toBe(b);
    expect(() => r.tracker.start({ caller: "x" }, "g")).toThrow(/session/);
  });

  it("task.end with no open task, or a different taskId, is NOT_FOUND", () => {
    const r = rig();
    expect(() => r.tracker.end(r.who, { outcome: "success" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    r.tracker.start(r.who, "g");
    expect(() => r.tracker.end(r.who, { outcome: "success", taskId: "t999" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => r.tracker.end({ caller: "x" }, { outcome: "success" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("goals and notes are redacted before they are written", () => {
    const r = rig();
    const { taskId } = r.tracker.start(r.who, "log in with password: hunter2 and pay with 4111 1111 1111 1111");
    r.tracker.end(r.who, { outcome: "failed", note: "ssn 123-45-6789 rejected" });
    const all = JSON.stringify(r.written);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("4111");
    expect(all).not.toContain("123-45-6789");
    expect(r.log.get(taskId)!.goal).toBe("log in with password: •••• and pay with ••••");
  });

  it("sessionEnded closes the open task at its last call (implicit unknown, explicit abandoned)", () => {
    const r = rig();
    const a = r.call();
    const last = r.now();
    r.advance(5000);
    r.tracker.sessionEnded("S1");
    expect(r.log.get(a!)).toMatchObject({ outcome: "unknown", endedAt: last });
    r.tracker.start(r.who, "g");
    r.advance(100);
    r.tracker.sessionEnded("S1");
    expect(r.log.list()[0]).toMatchObject({ outcome: "abandoned", callCount: 0, endedAt: r.now() });
    r.tracker.sessionEnded("nobody"); // no-op
  });

  it("sweep closes idle tasks; explicit tasks get the longer explicit idle", () => {
    const r = rig({ idleMs: 1000, explicitIdleMs: 10_000 });
    const imp = r.call("act.click", 0, { caller: "a", session: "A" });
    const job = r.tracker.start({ caller: "b", session: "B" }, "long job").taskId;
    r.advance(2000);
    r.tracker.sweep();
    expect(r.log.get(imp!)!.outcome).toBe("unknown");
    expect(r.tracker.openTask("B")).toBeDefined();
    r.advance(10_000);
    r.tracker.sweep();
    expect(r.tracker.openTask("B")).toBeUndefined();
    expect(r.log.get(job)).toMatchObject({ goal: "long job", outcome: "abandoned" });
  });

  it("label sets the outcome of an ended task only", () => {
    const r = rig();
    const a = r.call();
    expect(r.tracker.label(a!, "success")).toBe("BAD_REQUEST");
    r.tracker.sessionEnded("S1");
    expect(r.tracker.label(a!, "success")).toBe("ok");
    expect(r.log.get(a!)).toMatchObject({ outcome: "success", labeled: true });
    expect(r.tracker.label("nope", "failed")).toBe("NOT_FOUND");
  });

  it("recover ends tasks a previous run left open", () => {
    const r = rig();
    r.log.apply({ ts: iso(5), event: "task.started", data: { taskId: "old", session: "X", startedAt: iso(5) } });
    r.log.apply({ ts: iso(50), tool: "act.click", origin: null, outcome: "ok", durationMs: 5, taskId: "old" });
    r.log.apply({ ts: iso(60), event: "task.started", data: { taskId: "oldx", session: "Y", explicit: true, startedAt: iso(60) } });
    r.tracker.recover();
    expect(r.log.get("old")).toMatchObject({ outcome: "unknown", endedAt: 50 });
    expect(r.log.get("oldx")).toMatchObject({ outcome: "abandoned", endedAt: 60 });
  });
});

// ---------------------------------------------------------------------------
// Daemon wiring
// ---------------------------------------------------------------------------
let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});
const hdr = (s: string) => ({ "x-tabagent-session": s });

describe("daemon: timed tasks", () => {
  it("task.start / task.end over REST; calls between carry taskId and durationMs; task.ended has duration and count", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d, undefined, ["files.resolve", "tasks"]);
    e.onCommand = (c) => okEnvelope({}, c.tool, { audit: { tool: c.tool, origin: "https://shop.test", params: {}, outcome: "ok", resultSummary: { bytes: 1, sha256: "x" }, durationMs: 42 } });
    const s = await rest(r.base, "/v1/task.start", r.cfg.secret, { goal: "add mozzarella" }, hdr("A"));
    expect(s.status).toBe(200);
    const taskId = s.body.result.taskId;
    expect(taskId).toMatch(/^t-[0-9a-f]{12}$/);
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("A"));
    await rest(r.base, "/v1/act.click", r.cfg.secret, { ref: "e1" }, hdr("A"));
    const end = await rest(r.base, "/v1/task.end", r.cfg.secret, { outcome: "success" }, hdr("A"));
    expect(end.body.result).toMatchObject({ taskId, callCount: 2 });
    expect(end.body.result.durationMs).toBeGreaterThanOrEqual(0);
    const log = lines(join(r.home, "audit.jsonl"));
    const recs = log.filter((l) => l.tool);
    expect(recs.map((l) => [l.tool, l.taskId, l.durationMs])).toEqual([
      ["page.snapshot", taskId, 42],
      ["act.click", taskId, 42],
    ]);
    expect(log.find((l) => l.event === "task.ended")!.data).toMatchObject({ taskId, outcome: "success", callCount: 2, browserMs: 84 });
    // task tools never become tool records of their own
    expect(log.some((l) => l.tool?.startsWith("task."))).toBe(false);
    // a second end has nothing to end
    const again = await rest(r.base, "/v1/task.end", r.cfg.secret, { outcome: "failed" }, hdr("A"));
    expect(again.body.error.code).toBe("NOT_FOUND");
    expect(lines(join(r.home, "audit.jsonl")).filter((l) => l.event === "task.started")).toHaveLength(1);
    e.close();
  });

  it("an old extension's record without durationMs gets the bridge's own timing; bridge-side errors are timed too", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    await rest(r.base, "/v1/act.type", r.cfg.secret, { ref: "e1", text: "x" }, hdr("B"));
    const e = await pairedExt(r.d);
    e.onCommand = (c) => okEnvelope({}, c.tool);
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("B"));
    e.onCommand = () => ({ ok: true, result: {} }); // legacy: no audit record
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("B"));
    const recs = lines(join(r.home, "audit.jsonl")).filter((l) => l.tool);
    expect(recs).toHaveLength(3);
    for (const l of recs) expect(typeof l.durationMs).toBe("number");
    // all three share the implicit task of session B
    expect(new Set(recs.map((l) => l.taskId)).size).toBe(1);
    expect(recs[0].taskId).toBeTruthy();
    e.close();
  });

  it("session.end ends the session's open task; the panel's session.ended event does too", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    e.onCommand = (c) => okEnvelope({}, c.tool);
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("C"));
    await rest(r.base, "/v1/session.end", r.cfg.secret, {}, hdr("C"));
    const ended = lines(join(r.home, "audit.jsonl")).filter((l) => l.event === "task.ended");
    expect(ended).toHaveLength(1);
    // session.end is itself the task's last call
    expect(ended[0].data).toMatchObject({ outcome: "unknown", callCount: 2 });
    // panel path
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("D"));
    const open = r.d.tasks.log.openTasks();
    expect(open).toHaveLength(1);
    e.send({ type: "event", event: "session.ended", data: { sessionId: open[0].session } });
    await expect.poll(() => r.d.tasks.log.openTasks().length).toBe(0);
    e.close();
  });

  it("tasks.list returns summaries; tasks.label labels an ended task; tasks.changed is pushed to a tasks-capable extension", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d, undefined, ["files.resolve", "tasks"]);
    e.onCommand = (c) => okEnvelope({}, c.tool);
    await rest(r.base, "/v1/task.start", r.cfg.secret, { goal: "check order" }, hdr("E"));
    await e.next("tasks.changed");
    await rest(r.base, "/v1/page.markdown", r.cfg.secret, {}, hdr("E"));
    await rest(r.base, "/v1/task.end", r.cfg.secret, { outcome: "failed" }, hdr("E"));
    e.send({ type: "tasks.list", id: "L1" });
    const listed = await e.next("tasks.listed", (m) => m.id === "L1");
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({ goal: "check order", outcome: "failed", callCount: 1, explicit: true, calls: [] });
    // calls only for the task the panel opened
    e.send({ type: "tasks.list", id: "L1b", calls: listed.tasks[0].taskId });
    expect((await e.next("tasks.listed", (m) => m.id === "L1b")).tasks[0].calls.map((c: any) => c.tool)).toEqual(["page.markdown"]);
    e.send({ type: "tasks.label", id: "L2", taskId: listed.tasks[0].taskId, outcome: "success" });
    expect(await e.next("tasks.labeled", (m) => m.id === "L2")).toMatchObject({ ok: true });
    e.send({ type: "tasks.label", id: "L3", taskId: "t-nope", outcome: "success" });
    expect(await e.next("tasks.labeled", (m) => m.id === "L3")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    e.send({ type: "tasks.list", id: "L4", limit: 1 });
    expect((await e.next("tasks.listed", (m) => m.id === "L4")).tasks[0]).toMatchObject({ outcome: "success", labeled: true });
    e.close();
  });

  it("an extension without the tasks feature gets no tasks.changed", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    e.onCommand = (c) => okEnvelope({}, c.tool);
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("F"));
    expect(e.msgs.some((m) => m.type === "tasks.changed")).toBe(false);
    e.close();
  });

  it("the welcome advertises tasks", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    expect(e.msgs.find((m) => m.type === "welcome").features).toContain("tasks");
    e.close();
  });

  it("on restart, tasks left open in the log are ended and listed", async () => {
    const home = tempHome();
    const p = join(home, "audit.jsonl");
    writeFileSync(p, [JSON.stringify({ ts: iso(1000), event: "task.started", caller: "c", data: { taskId: "t-old", session: "Z", goal: "left open", explicit: true, startedAt: iso(1000) } }), JSON.stringify({ ts: iso(2000), caller: "c", session: "Z", tool: "act.click", origin: null, outcome: "ok", durationMs: 10, taskId: "t-old" })].join("\n") + "\n");
    const r = await startDaemon({}, home);
    daemons.push(r.d);
    expect(r.d.tasks.log.get("t-old")).toMatchObject({ outcome: "abandoned", endedAt: 2000, callCount: 1 });
    expect(lines(p).at(-1)).toMatchObject({ event: "task.ended", data: { taskId: "t-old" } });
  });

  it("taskIdleMs option splits implicit tasks", async () => {
    let now = 1_000_000;
    const r = await startDaemon({ now: () => now, taskIdleMs: 1000 });
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    e.onCommand = (c) => okEnvelope({}, c.tool, { audit: { tool: c.tool, origin: null, params: {}, outcome: "ok", resultSummary: { bytes: 1, sha256: "x" }, durationMs: 0 } });
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("G"));
    now += 5000;
    await rest(r.base, "/v1/page.snapshot", r.cfg.secret, {}, hdr("G"));
    const recs = lines(join(r.home, "audit.jsonl")).filter((l) => l.tool);
    expect(new Set(recs.map((l) => l.taskId)).size).toBe(2);
    e.close();
  });
});

describe("AuditWriter hooks", () => {
  it("stamp adds fields to records and minimal records; onWrite sees every line; a throwing listener is contained", () => {
    const p = join(tempHome(), "audit.jsonl");
    const w = new AuditWriter(p);
    const seen: string[] = [];
    w.stamp = (_who, rec) => (rec.tool === "skip" ? undefined : { taskId: "T" });
    w.onWrite = (o) => {
      seen.push(String(o.tool ?? o.event));
      throw new Error("boom");
    };
    w.record({ tool: "act.click", origin: null, params: {}, outcome: "ok", resultSummary: { bytes: 0, sha256: "" }, durationMs: 5 }, { caller: "c", session: "S" });
    w.minimal("skip", "error", { caller: "c", session: "S" }, "TIMEOUT", undefined, 12.6);
    w.minimal("nav.goto", "error", { caller: "c" }, "TIMEOUT", undefined, -1);
    w.event("killed", undefined);
    expect(lines(p).map((l) => [l.tool ?? l.event, l.taskId, l.durationMs])).toEqual([
      ["act.click", "T", 5],
      ["skip", undefined, 13],
      ["nav.goto", "T", undefined],
      ["killed", undefined, undefined],
    ]);
    expect(seen).toEqual(["act.click", "skip", "nav.goto", "killed"]);
  });
});

describe("tabagent tasks (CLI)", () => {
  const NOW = Date.parse("2026-11-28T12:00:00Z");
  function seed() {
    const home = tempHome();
    const p = join(home, "audit.jsonl");
    const L = (o: object) => JSON.stringify(o);
    writeFileSync(
      `${p}.1`,
      [L({ ts: "2026-11-01T00:00:00.000Z", event: "task.started", caller: "old", data: { taskId: "t-old", goal: "ancient", startedAt: "2026-11-01T00:00:00.000Z" } })].join("\n") + "\n",
    );
    writeFileSync(
      p,
      [
        L({ ts: "2026-11-28T06:18:12.000Z", event: "task.started", caller: "claude-code", data: { taskId: "t-a", session: "S", goal: "add mozzarella", explicit: true, startedAt: "2026-11-28T06:18:12.000Z" } }),
        L({ ts: "2026-11-28T06:18:14.000Z", caller: "claude-code", session: "S", tool: "page.snapshot", origin: "https://shop.test", outcome: "ok", durationMs: 2000, taskId: "t-a" }),
        L({ ts: "2026-11-28T06:18:30.000Z", caller: "claude-code", session: "S", tool: "tabs", action: "list", origin: null, outcome: "error", errorCode: "TIMEOUT", durationMs: 500, taskId: "t-a" }),
        L({ ts: "2026-11-28T06:19:19.000Z", event: "task.ended", caller: "claude-code", data: { taskId: "t-a", outcome: "success", endedAt: "2026-11-28T06:19:19.000Z", note: "added 1" } }),
        L({ ts: "2026-11-28T11:59:00.000Z", event: "task.started", caller: "codex", data: { taskId: "t-b", session: "X", goal: null, startedAt: "2026-11-28T11:59:00.000Z" } }),
      ].join("\n") + "\n",
    );
    return p;
  }
  it("lists recent tasks newest first, with duration, calls, outcome; --since filters; -n caps", async () => {
    const { tasksCommand } = await import("../src/commands");
    const p = seed();
    const r = tasksCommand([], {}, NOW, p);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(2);
    expect(r.out[0]).toMatch(/^2026-11-28 11:59:00\s+1m 0s\s+0 calls\s+running\s+codex\s+\(untitled\)\s+t-b$/);
    expect(r.out[1]).toMatch(/^2026-11-28 06:18:12\s+1m 7s\s+2 calls\s+success\s+claude-code\s+add mozzarella\s+t-a$/);
    expect(tasksCommand(["list"], { since: "30d" }, NOW, p).out).toHaveLength(3);
    expect(tasksCommand([], { since: "30d", n: "1" }, NOW, p).out).toHaveLength(1);
    expect(tasksCommand([], { since: "1m" }, NOW + 5000, p).out).toEqual(["No tasks in the last 1m."]);
    expect(tasksCommand([], { since: "soon" }, NOW, p)).toMatchObject({ code: 1, err: [expect.stringMatching(/Bad --since/)] });
    expect(tasksCommand(["bogus"], {}, NOW, p).code).toBe(1);
  });
  it("--json prints one task object per line with its calls", async () => {
    const { tasksCommand } = await import("../src/commands");
    const p = seed();
    const out = tasksCommand([], { json: true }, NOW, p).out.map((l) => JSON.parse(l));
    expect(out.map((t) => t.taskId)).toEqual(["t-b", "t-a"]);
    expect(out[1]).toMatchObject({ goal: "add mozzarella", durationMs: 67_000, callCount: 2, browserMs: 2500, outcome: "success" });
    expect(out[1].calls).toHaveLength(2);
  });
  it("show prints one task's timeline with waits; unknown ids fail", async () => {
    const { tasksCommand } = await import("../src/commands");
    const p = seed();
    const r = tasksCommand(["show", "t-a"], {}, NOW, p);
    expect(r.out[0]).toBe("add mozzarella  [t-a]");
    expect(r.out[1]).toMatch(/success\s+total 1m 7s\s+in browser 2.5s\s+2 calls/);
    expect(r.out[2]).toBe("note: added 1");
    expect(r.out[3]).toMatch(/\+0ms\s+page\.snapshot\s+ok\s+2s\s+https:\/\/shop\.test/);
    expect(r.out[4]).toMatch(/\+17.5s\s+tabs\(list\)\s+error\s+500ms\s+\(waited 15.5s\)\s+-\s+TIMEOUT/);
    expect(JSON.parse(tasksCommand(["show", "t-b"], { json: true }, NOW, p).out[0]).taskId).toBe("t-b");
    expect(tasksCommand(["show", "t-b"], {}, NOW, p).out[1]).toMatch(/running\s+total 1m 0s/);
    expect(tasksCommand(["show", "nope"], {}, NOW, p).code).toBe(1);
    expect(tasksCommand(["show"], {}, NOW, p).err[0]).toMatch(/Usage/);
  });
  it("parseSince and config set task-idle", async () => {
    const { configCommand, parseSince } = await import("../src/commands");
    const { loadConfig, taskIdleMs } = await import("../src/config");
    expect([parseSince("30m"), parseSince("2h"), parseSince("7d"), parseSince("7w")]).toEqual([1_800_000, 7_200_000, 604_800_000, undefined]);
    tempHome();
    expect(configCommand(["set", "task-idle", "10"]).code).toBe(0);
    expect(loadConfig().taskIdleMin).toBe(10);
    expect(taskIdleMs(loadConfig())).toBe(600_000);
    expect(configCommand(["set", "task-idle", "0"]).code).toBe(1);
    expect(taskIdleMs({ taskIdleMin: undefined })).toBe(300_000);
    expect(taskIdleMs({ taskIdleMin: -3 })).toBe(300_000);
  });
});
