import { describe, expect, it, vi } from "vitest";
import type { OutputResponse } from "@tabagent/protocol";
import { helpText, killCommand, settingsCommand } from "../src/commands";

const SNAP = {
  denylist: ["*.1password.com", "accounts.google.com"],
  sites: {
    "https://app.example.com": { policy: "full", auth: true, lite: true, preapproved: ["a", "c"], alwaysAccounts: 2 },
    "https://read.example.com": { policy: "read", auth: false, lite: false },
  },
  yolo: false,
  devAllowSensitive: true,
  onSessionEnd: "collapse",
  beforeUnload: "accept",
  showOverlay: true,
  forceLite: false,
  liteSites: [],
  authDenyHosts: ["*.chase.com"],
  vaultDenyHosts: ["passwords.google.com"],
};

const caller = (resp: OutputResponse) => vi.fn(async (_tool: string, _p: Record<string, unknown>) => resp);

describe("tabagent settings show (#105)", () => {
  it("calls settings.get and prints a readable summary", async () => {
    const call = caller({ ok: true, result: SNAP });
    const o = await settingsCommand(["show"], {}, call);
    expect(call).toHaveBeenCalledWith("settings.get", {});
    expect(o.code).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain("Denylist (2): *.1password.com, accounts.google.com");
    expect(text).toMatch(/https:\/\/app\.example\.com\s+full\s+sign-in on\s+lite on\s+pre-approved a,c\s+2 accounts always/);
    expect(text).toMatch(/https:\/\/read\.example\.com\s+read\s+sign-in off/);
    expect(text).toContain("YOLO: off");
    expect(text).toContain("Developer mode (devAllowSensitive): on");
    expect(text).toContain("On session end: collapse");
    expect(text).toContain("Lite sites: (none)");
    expect(text).toContain("Never signs in: *.chase.com");
    expect(text).toContain("Never reachable: passwords.google.com");
  });

  it("with no subcommand shows too; --json prints the raw result", async () => {
    expect((await settingsCommand([], {}, caller({ ok: true, result: SNAP }))).out.join("\n")).toContain("Denylist");
    const o = await settingsCommand(["show"], { json: true }, caller({ ok: true, result: SNAP }));
    expect(JSON.parse(o.out.join("\n"))).toEqual(SNAP);
  });

  it("an empty site list says so", async () => {
    const o = await settingsCommand(["show"], {}, caller({ ok: true, result: { ...SNAP, sites: {}, liteSites: ["*.a.example"] } }));
    expect(o.out.join("\n")).toContain("Sites: (none saved)");
    expect(o.out.join("\n")).toContain("Lite sites: *.a.example");
  });

  it("errors are printed with their hint and exit 1", async () => {
    const o = await settingsCommand(["show"], {}, caller({ ok: false, error: { code: "KILLED", message: "stopped", hint: "Ask the user to press Resume" } }));
    expect(o.code).toBe(1);
    expect(o.err.join("\n")).toContain("KILLED: stopped");
    expect(o.err.join("\n")).toContain("Hint: Ask the user to press Resume");
  });

  it("unknown subcommands print usage", async () => {
    const call = caller({ ok: true, result: SNAP });
    const o = await settingsCommand(["set"], {}, call);
    expect(o.code).toBe(1);
    expect(o.err[0]).toMatch(/Usage: tabagent settings show/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("tabagent kill (#106)", () => {
  it("calls session.kill_all and says how to resume", async () => {
    const call = caller({ ok: true, result: { status: "killed", alreadyPaused: false } });
    const o = await killCommand(call);
    expect(call).toHaveBeenCalledWith("session.kill_all", {});
    expect(o.code).toBe(0);
    expect(o.out.join("\n")).toMatch(/Stopped all agents/);
    expect(o.out.join("\n")).toMatch(/Resume.*side panel/);
  });
  it("already stopped is still success", async () => {
    const o = await killCommand(caller({ ok: true, result: { status: "killed", alreadyPaused: true } }));
    expect(o.code).toBe(0);
    expect(o.out.join("\n")).toMatch(/already stopped/);
  });
  it("a failure (no extension) exits 1 with the error", async () => {
    const o = await killCommand(caller({ ok: false, error: { code: "NO_EXTENSION", message: "The TabAgent Chrome extension is not connected" } }));
    expect(o.code).toBe(1);
    expect(o.err[0]).toContain("NO_EXTENSION");
  });
  it("help lists both commands", () => {
    expect(helpText()).toMatch(/tabagent settings show/);
    expect(helpText()).toMatch(/tabagent kill/);
  });
});
