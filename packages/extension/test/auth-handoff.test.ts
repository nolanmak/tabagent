// #35 handoff state machine with a fake driver/UI and a fake clock.
import { describe, expect, it } from "vitest";
import { runHandoff, type HandoffDeps, type HandoffRequest } from "../src/background/auth/pure/handoff";

const REQ: HandoffRequest = { tabId: 7, sessionId: "s1", sessionLabel: "claude-code", origin: "https://github.com", reason: "Use your passkey" };

function fake() {
  const log: string[] = [];
  const events: { name: string; data: any }[] = [];
  const attached = new Set([7, 8]);
  const busy = new Set<number>();
  let uiResolve: ((r: "done" | "cancel") => void) | null = null;
  let timer: (() => void) | null = null;
  let kill: (() => void) | null = null;
  let closed: (() => void) | null = null;
  // a fake router guard: agent commands on a handed-off tab get TAB_BUSY (sessions.ts does this for real)
  const agentCommand = (tabId: number) => (busy.has(tabId) ? "TAB_BUSY" : (attached.add(tabId), "ok"));
  const snapshots: number[] = [];
  const deps: HandoffDeps = {
    async detach(id) {
      attached.delete(id);
      log.push(`detach ${id}`);
    },
    start(info) {
      busy.add(info.tabId);
      log.push("ui start");
      return new Promise((r) => (uiResolve = (x) => (busy.delete(info.tabId), r(x))));
    },
    end(id, r) {
      busy.delete(id);
      log.push(`ui end ${r}`);
    },
    busy: (id) => busy.has(id),
    notify: () => log.push("notify"),
    clearNotice: () => log.push("clear"),
    onTabClosed: (_id, cb) => ((closed = cb), () => (closed = null)),
    onKilled: (cb) => ((kill = cb), () => (kill = null)),
    event: (name, data) => events.push({ name, data }),
    setTimeout: (fn) => ((timer = fn), 1),
    clearTimeout: () => (timer = null),
  };
  return { deps, log, events, attached, busy, agentCommand, snapshots, ui: (r: "done" | "cancel") => uiResolve!(r), fireTimer: () => timer!(), kill: () => kill!(), close: () => closed!() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("auth.handoff state machine", () => {
  it("start → debugger detached, tab busy for agent commands, other tabs unaffected; Done → completed:true", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    expect(t.attached.has(7)).toBe(false);
    expect(t.attached.has(8)).toBe(true);
    expect(t.agentCommand(7)).toBe("TAB_BUSY");
    expect(t.agentCommand(8)).toBe("ok");
    expect(t.log).toEqual(["detach 7", "ui start", "notify"]);
    t.ui("done");
    await expect(p).resolves.toEqual({ completed: true });
    // the next command re-attaches lazily
    expect(t.agentCommand(7)).toBe("ok");
    expect(t.attached.has(7)).toBe(true);
  });

  it("Cancel → completed:false", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    t.ui("cancel");
    await expect(p).resolves.toEqual({ completed: false });
  });

  it("5-minute timeout → PROMPT_TIMEOUT and the panel entry is removed", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    t.fireTimer();
    await expect(p).rejects.toMatchObject({ code: "PROMPT_TIMEOUT" });
    expect(t.log).toContain("ui end cancel");
    expect(t.busy.has(7)).toBe(false);
  });

  it("kill switch → KILLED", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    t.kill();
    await expect(p).rejects.toMatchObject({ code: "KILLED" });
  });

  it("tab closed → NOT_FOUND", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    t.close();
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a second handoff on the same tab while one is open → TAB_BUSY", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    await expect(runHandoff(t.deps, REQ)).rejects.toMatchObject({ code: "TAB_BUSY" });
    t.ui("done");
    await p;
  });

  it("audit: exactly one start and one end event, no page content or reason text", async () => {
    const t = fake();
    const p = runHandoff(t.deps, REQ);
    await tick();
    t.ui("done");
    await p;
    expect(t.events.map((e) => e.name)).toEqual(["auth.handoff.start", "auth.handoff.end"]);
    expect(t.events[1].data.outcome).toBe("done");
    expect(JSON.stringify(t.events)).not.toContain("passkey");
  });

  it("nothing is observed between start and end (no snapshot, no feed)", async () => {
    const t = fake();
    const deps = t.deps as any;
    const spy: string[] = [];
    for (const k of Object.keys(deps)) {
      const fn = deps[k];
      if (typeof fn === "function") deps[k] = (...a: any[]) => (spy.push(k), fn(...a));
    }
    const p = runHandoff(deps, REQ);
    await tick();
    const during = spy.slice();
    t.ui("done");
    await p;
    // the only calls are lifecycle ones: nothing reads the page
    for (const k of spy) expect(["busy", "event", "detach", "start", "setTimeout", "onKilled", "onTabClosed", "notify", "clearTimeout", "clearNotice"]).toContain(k);
    expect(during).not.toContain("snapshot");
  });
});
