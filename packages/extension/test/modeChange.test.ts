import { describe, expect, it } from "vitest";
import { checkModeChange, describeModeChange, formatRemaining, MAX_YOLO_MIN, modeChangeNeedsApproval, modeChangeSnapshot, modeChangeWarnings, yoloExpired, yoloExpiry } from "../src/pure/modeChange";

const NOW = 1_700_000_000_000;
const off = { yolo: false, devAllowSensitive: false, yoloExpiresAt: null };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return { code: e.code, message: String(e.message), hint: e.hint as string | undefined };
  }
  throw new Error("expected a throw");
};

describe("mode change approval (#109)", () => {
  it.each([
    [{ yolo: true }, true],
    [{ devAllowSensitive: true }, true],
    [{ yolo: true, durationMin: 30 }, true],
    [{ yolo: false, devAllowSensitive: true }, true],
    [{ yolo: true, devAllowSensitive: false }, true],
    [{ yolo: false }, false],
    [{ devAllowSensitive: false }, false],
    [{ yolo: false, devAllowSensitive: false }, false],
    [{}, false],
  ])("%j needs approval: %s", (p, needs) => {
    expect(modeChangeNeedsApproval(p)).toBe(needs);
  });

  it("decides from the request alone, never from the current state", () => {
    // Turning YOLO on asks even when a racing write already turned it on.
    const r = checkModeChange({ ...off, yolo: true, yoloExpiresAt: NOW + 60_000 }, { yolo: true }, NOW);
    expect(r.needsApproval).toBe(true);
  });
});

describe("mode change validation (#109)", () => {
  it("needs at least one of yolo or devAllowSensitive", () => {
    const e = code(() => checkModeChange(off, { reason: "x" } as any, NOW));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("yolo or devAllowSensitive");
  });

  it.each([
    [{ yolo: false }, off],
    [{ devAllowSensitive: false }, off],
    [{ yolo: true }, { ...off, yolo: true }],
    [{ devAllowSensitive: true, yolo: true }, { yolo: true, devAllowSensitive: true, yoloExpiresAt: null }],
  ])("refuses the no-op %j with BAD_REQUEST", (p, state) => {
    const e = code(() => checkModeChange(state, p, NOW));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("Nothing to change");
    expect(e.hint).toContain("settings.get");
  });

  it.each([0, -5, 1.5, MAX_YOLO_MIN + 1, Number.NaN, "10" as any])("refuses durationMin %j", (d) => {
    expect(code(() => checkModeChange(off, { yolo: true, durationMin: d }, NOW)).code).toBe("BAD_REQUEST");
  });

  it.each([{ yolo: false, durationMin: 5 }, { devAllowSensitive: true, durationMin: 5 }])("durationMin only goes with yolo: true (%j)", (p) => {
    const e = code(() => checkModeChange({ ...off, yolo: true }, p, NOW));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("durationMin");
  });

  it("accepts the bounds", () => {
    expect(checkModeChange(off, { yolo: true, durationMin: 1 }, NOW).next.yoloExpiresAt).toBe(NOW + 60_000);
    expect(checkModeChange(off, { yolo: true, durationMin: MAX_YOLO_MIN }, NOW).next.yoloExpiresAt).toBe(NOW + MAX_YOLO_MIN * 60_000);
  });
});

describe("mode change application (#109)", () => {
  it("turning YOLO on without a duration has no expiry (like the panel)", () => {
    const r = checkModeChange(off, { yolo: true }, NOW);
    expect(r.next).toEqual({ yolo: true, devAllowSensitive: false, yoloExpiresAt: null });
    expect(r.applied).toEqual([{ field: "yolo", from: false, to: true }]);
  });

  it("turning YOLO on for a duration stores an expiry timestamp", () => {
    const r = checkModeChange(off, { yolo: true, durationMin: 30 }, NOW);
    expect(r.next).toEqual({ yolo: true, devAllowSensitive: false, yoloExpiresAt: NOW + 30 * 60_000 });
    expect(r.applied).toEqual([
      { field: "yolo", from: false, to: true },
      { field: "yoloExpiresAt", from: null, to: NOW + 30 * 60_000 },
    ]);
  });

  it("re-requesting YOLO with a duration while it is on resets the expiry; without one removes it", () => {
    const on = { ...off, yolo: true, yoloExpiresAt: NOW + 5_000 };
    expect(checkModeChange(on, { yolo: true, durationMin: 60 }, NOW).applied).toEqual([{ field: "yoloExpiresAt", from: NOW + 5_000, to: NOW + 3_600_000 }]);
    expect(checkModeChange(on, { yolo: true }, NOW).applied).toEqual([{ field: "yoloExpiresAt", from: NOW + 5_000, to: null }]);
  });

  it("turning YOLO off clears its expiry; turning dev mode off leaves YOLO alone", () => {
    const on = { yolo: true, devAllowSensitive: true, yoloExpiresAt: NOW + 5_000 };
    expect(checkModeChange(on, { yolo: false }, NOW)).toMatchObject({ needsApproval: false, next: { yolo: false, devAllowSensitive: true, yoloExpiresAt: null } });
    expect(checkModeChange(on, { devAllowSensitive: false }, NOW)).toMatchObject({ needsApproval: false, next: { yolo: true, devAllowSensitive: false, yoloExpiresAt: NOW + 5_000 } });
  });

  it("lists only the fields that change", () => {
    const r = checkModeChange({ ...off, devAllowSensitive: true }, { yolo: true, devAllowSensitive: true }, NOW);
    expect(r.applied).toEqual([{ field: "yolo", from: false, to: true }]);
  });

  it("yoloExpiry is minutes from now", () => {
    expect(yoloExpiry(NOW, 15)).toBe(NOW + 900_000);
  });
});

describe("YOLO expiry (#109)", () => {
  it.each([
    [{ yolo: true, yoloExpiresAt: NOW }, NOW, true],
    [{ yolo: true, yoloExpiresAt: NOW - 1 }, NOW, true],
    [{ yolo: true, yoloExpiresAt: NOW + 1 }, NOW, false],
    [{ yolo: true, yoloExpiresAt: null }, NOW, false],
    [{ yolo: false, yoloExpiresAt: NOW - 1 }, NOW, false],
  ])("%j at now is expired: %s", (s, now, expired) => {
    expect(yoloExpired(s, now)).toBe(expired);
  });

  it.each([
    [0, "0 s"],
    [-5, "0 s"],
    [45_000, "45 s"],
    [59_400, "60 s"],
    [60_000, "1 min"],
    [12 * 60_000 + 10_000, "13 min"],
    [3 * 3_600_000 + 5 * 60_000, "3 h 5 min"],
    [24 * 3_600_000, "24 h"],
  ])("formatRemaining(%d) = %s", (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});

describe("mode change prompt text (#109)", () => {
  it("names each change, the duration and the reason", () => {
    const s = describeModeChange({ yolo: true, devAllowSensitive: false, durationMin: 30, reason: "bulk-download statements from 40 sites" });
    expect(s).toContain("turn YOLO mode on for 30 minutes");
    expect(s).toContain("turn developer mode (skip sensitive-action confirmations) off");
    expect(s).toContain("reason: bulk-download statements from 40 sites");
  });

  it("says when YOLO has no time limit", () => {
    expect(describeModeChange({ yolo: true, reason: "r" })).toContain("turn YOLO mode on with no time limit");
  });

  it("warns what YOLO and developer mode allow, only for what is being turned on", () => {
    const yolo = modeChangeWarnings({ yolo: true }).join(" ");
    expect(yolo).toMatch(/every site without asking/);
    expect(yolo).toMatch(/sign in/);
    expect(yolo).toMatch(/denylist/);
    expect(modeChangeWarnings({ yolo: true, durationMin: 20 }).join(" ")).toContain("20 minutes");
    expect(modeChangeWarnings({ yolo: true }).join(" ")).toMatch(/until you turn it off/);
    const dev = modeChangeWarnings({ devAllowSensitive: true }).join(" ");
    expect(dev).toMatch(/JavaScript/);
    expect(dev).toMatch(/cookies/);
    expect(dev).not.toMatch(/every site without asking/);
    expect(modeChangeWarnings({ yolo: false, devAllowSensitive: false })).toEqual([]);
  });

  it("the snapshot covers YOLO, its expiry and developer mode", () => {
    const a = modeChangeSnapshot(off);
    expect(modeChangeSnapshot({ ...off })).toBe(a);
    expect(modeChangeSnapshot({ ...off, yolo: true })).not.toBe(a);
    expect(modeChangeSnapshot({ ...off, devAllowSensitive: true })).not.toBe(a);
    expect(modeChangeSnapshot({ ...off, yolo: true, yoloExpiresAt: 5 })).not.toBe(modeChangeSnapshot({ ...off, yolo: true }));
  });
});
