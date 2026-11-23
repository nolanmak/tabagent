import { describe, expect, it } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import { autoWait, judge, notActionable, type Observation } from "../src/background/autowait";

const box = { x: 10, y: 10, w: 100, h: 20 };
const ok: Observation = { attached: true, visible: true, enabled: true, editable: true, box, box2: box, inView: true, point: { x: 60, y: 20 }, hit: { ok: true } };

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

async function run(seq: Partial<Observation>[], opts: { timeout?: number; needEditable?: boolean } = {}) {
  const clock = fakeClock();
  const calls: boolean[] = [];
  let i = 0;
  const p = autoWait(
    "e7",
    {
      ...clock,
      observe: async (scroll) => {
        calls.push(scroll);
        const o = { ...ok, ...seq[Math.min(i, seq.length - 1)] };
        i++;
        return o;
      },
    },
    { timeout: opts.timeout ?? 1000, needEditable: opts.needEditable },
  );
  return { p, calls };
}

async function reason(seq: Partial<Observation>[]) {
  const { p } = await run(seq);
  try {
    await p;
  } catch (e) {
    return { code: (e as TabAgentError).code, message: (e as TabAgentError).message, pageText: (e as TabAgentError & { pageText?: boolean }).pageText };
  }
  return { code: "ok" };
}

describe("judge: condition order", () => {
  it("attached -> visible -> stable -> enabled -> in view -> hit", () => {
    expect(judge({ ...ok, attached: false })).toMatchObject({ ok: false, reason: "detached" });
    expect(judge({ ...ok, visible: false })).toMatchObject({ reason: "hidden" });
    expect(judge({ ...ok, box: { ...box, w: 0 } })).toMatchObject({ reason: "hidden" });
    expect(judge({ ...ok, box2: { ...box, y: 50 } })).toMatchObject({ reason: "moving" });
    expect(judge({ ...ok, enabled: false })).toMatchObject({ reason: "disabled" });
    expect(judge({ ...ok, editable: false }, true)).toMatchObject({ fatal: "not-editable" });
    expect(judge({ ...ok, inView: false })).toMatchObject({ reason: "covered", scroll: true });
    expect(judge({ ...ok, hit: { ok: false, by: '<div#modal> "Cookies"' } })).toMatchObject({ reason: "covered", by: '<div#modal> "Cookies"' });
    expect(judge(ok)).toEqual({ ok: true, point: { x: 60, y: 20 } });
    expect(judge({ ...ok, point: undefined })).toEqual({ ok: true, point: { x: 60, y: 20 } });
  });
});

describe("autoWait (#7)", () => {
  it.each([
    ["hidden", { visible: false }],
    ["moving", { box2: { ...box, x: 40 } }],
    ["disabled", { enabled: false }],
    ["covered", { hit: { ok: false, by: "<div#overlay.cookie-banner>" } }],
  ] as const)("times out with reason %s", async (r, obs) => {
    const res = await reason([obs]);
    expect(res.code).toBe("NOT_ACTIONABLE");
    expect(res.message).toContain(`reason: ${r}`);
  });

  it("detached during the wait -> NOT_ACTIONABLE detached; detached at the start -> REF_STALE", async () => {
    expect((await reason([{ enabled: false }, { attached: false }])).message).toContain("reason: detached");
    expect((await reason([{ attached: false }])).code).toBe("REF_STALE");
  });

  it("covered names the covering element and is page text (wrapped)", async () => {
    const r = await reason([{ hit: { ok: false, by: '<div#overlay.cookie-banner> "We use cookies"' } }]);
    expect(r.message).toContain('covered by <div#overlay.cookie-banner> "We use cookies"');
    expect(r.pageText).toBe(true);
  });

  it("passes when the condition clears before the timeout", async () => {
    const { p } = await run([{ enabled: false }, { enabled: false }, {}]);
    await expect(p).resolves.toEqual({ x: 60, y: 20 });
  });

  it("scrolls into view, then re-hit-tests", async () => {
    const { p, calls } = await run([{ inView: false }, {}]);
    await expect(p).resolves.toEqual({ x: 60, y: 20 });
    expect(calls).toEqual([false, true]);
  });

  it("not a text field fails at once", async () => {
    const { p, calls } = await run([{ editable: false }], { needEditable: true });
    await expect(p).rejects.toMatchObject({ code: "NOT_ACTIONABLE" });
    expect(calls).toHaveLength(1);
  });

  it("check() aborts the wait (debugger detached / dialog)", async () => {
    const clock = fakeClock();
    let n = 0;
    const p = autoWait("e1", {
      ...clock,
      observe: async () => ({ ...ok, enabled: false }),
      check: () => {
        if (++n > 2) throw new TabAgentError("DEBUGGER_DETACHED", "gone");
      },
    });
    await expect(p).rejects.toMatchObject({ code: "DEBUGGER_DETACHED" });
  });

  it("notActionable without a covering description is not page text", () => {
    const e = notActionable("e1", "covered") as TabAgentError & { pageText?: boolean };
    expect(e.pageText).toBe(false);
    expect(e.hint).toBeTruthy();
  });
});
