import { describe, expect, it } from "vitest";
import { BEFORE_UNLOAD, checkPreferenceChanges, getTool, ON_SESSION_END, PREFERENCE_KEYS, TabAgentError, TOOLS, validateParams } from "@tabagent/protocol";

const reject = (changes: unknown) => {
  try {
    checkPreferenceChanges(changes);
  } catch (e) {
    expect(e).toBeInstanceOf(TabAgentError);
    return e as TabAgentError;
  }
  throw new Error(`expected ${JSON.stringify(changes)} to be rejected`);
};

describe("settings.change preference allowlist (#106)", () => {
  it("lists exactly the non-escalating preference keys, in one place", () => {
    expect([...PREFERENCE_KEYS].sort()).toEqual(["beforeUnload", "forceLite", "liteSites", "onSessionEnd", "showOverlay"]);
  });

  it("accepts every allowed key with a value the side panel could set", () => {
    expect(checkPreferenceChanges({ showOverlay: false, beforeUnload: "dismiss", onSessionEnd: "keep", forceLite: true, liteSites: ["*.example.com", "app.test:8080"] })).toEqual({
      showOverlay: false,
      beforeUnload: "dismiss",
      onSessionEnd: "keep",
      forceLite: true,
      liteSites: ["*.example.com", "app.test:8080"],
    });
    for (const v of BEFORE_UNLOAD) expect(checkPreferenceChanges({ beforeUnload: v })).toEqual({ beforeUnload: v });
    for (const v of ON_SESSION_END) expect(checkPreferenceChanges({ onSessionEnd: v })).toEqual({ onSessionEnd: v });
    expect(checkPreferenceChanges({ liteSites: [] })).toEqual({ liteSites: [] });
  });

  it.each([
    ["yolo", true, "policy.mode_change"],
    ["devAllowSensitive", true, "policy.mode_change"],
    ["denylist", [], "policy.denylist_change"],
    ["sites", {}, "policy.site_change"],
    ["paused", false, "Resume is panel-only"],
    ["secret", "x", "pair"],
    ["port", 1, "port"],
  ])("refuses escalating or protected key %s with a hint", (key, value, hint) => {
    const e = reject({ [key]: value });
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(e.message).toContain(key);
    expect(e.hint).toContain(hint);
  });

  it("an escalating key is refused even next to allowed ones (nothing is applied piecemeal)", () => {
    expect(reject({ showOverlay: false, yolo: true }).code).toBe("PERMISSION_DENIED");
  });

  it("unknown keys are BAD_REQUEST with the allowed list as the hint", () => {
    const e = reject({ theme: "dark" });
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.hint).toContain("showOverlay");
    expect(e.hint).toContain("liteSites");
    expect(reject({ __proto__x: 1, constructor: 1 }).code).toBe("BAD_REQUEST");
  });

  it.each([
    [{}],
    [null],
    [[]],
    ["showOverlay"],
    [{ showOverlay: "yes" }],
    [{ beforeUnload: "always" }],
    [{ onSessionEnd: "delete" }],
    [{ forceLite: 1 }],
    [{ liteSites: "a.com" }],
    [{ liteSites: ["https://a.com/path"] }],
    [{ liteSites: [""] }],
  ])("refuses an empty or invalid request %j", (changes) => {
    expect(reject(changes).code).toBe("BAD_REQUEST");
  });
});

describe("settings tools in the registry (#105, #106)", () => {
  it("settings.change lets unknown keys through schema validation so the handler can answer with a hint", () => {
    const t = getTool("settings.change")!;
    expect(validateParams(t, { changes: { yolo: true } })).toEqual({ changes: { yolo: true } });
    expect(() => validateParams(t, { changes: { showOverlay: "nope" } })).toThrow(/Invalid params/);
  });
  it("settings.get and session.kill_all take no params", () => {
    expect(validateParams(getTool("settings.get")!, {})).toEqual({});
    expect(validateParams(getTool("session.kill_all")!, {})).toEqual({});
  });
  it("no registry tool can resume after a kill: resume stays panel-only", () => {
    for (const t of TOOLS) expect(t.name).not.toMatch(/resume|unpause|unkill/i);
    expect(getTool("session.kill_all")!.level).toBe("none");
  });
});
