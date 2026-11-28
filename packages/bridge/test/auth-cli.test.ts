// `tabagent config auth.*`, `tabagent doctor`, `tabagent bitwarden …` (#36, #37).
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BitwardenProvider } from "../src/auth/bitwarden";
import { authConfigCommand, bitwardenCommand, doctorCommand, resolveBin, SMS_EXPLAIN } from "../src/auth/cli";
import { lockMs, readAuthConfig } from "../src/auth/config";
import { OnePasswordProvider } from "../src/auth/onepassword";
import { SmsSource } from "../src/auth/sms";
import { bwScenario, fakeCliDir, opScenario, type FakeCliDir } from "./auth-fakes";

let dir: string;
let cfgPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabagent-authcli-"));
  cfgPath = join(dir, "config.json");
});

describe("config auth.sms", () => {
  it("on explains what it grants and keeps other keys; off turns it off", () => {
    writeFileSync(cfgPath, JSON.stringify({ port: 1234, secret: "s", extensionIds: ["x"] }));
    const on = authConfigCommand(["auth.sms", "on"], cfgPath);
    expect(on.code).toBe(0);
    expect(on.out.join("\n")).toContain("read-only");
    expect(on.out.join("\n")).toContain("Full Disk Access");
    const j = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(j).toMatchObject({ port: 1234, secret: "s", extensionIds: ["x"], auth: { sms: true } });
    expect(readAuthConfig(cfgPath).sms).toBe(true);
    expect(authConfigCommand(["auth.sms", "off"], cfgPath).code).toBe(0);
    expect(readAuthConfig(cfgPath).sms).toBe(false);
  });
  it("bad value → usage plus the explanation, nothing written", () => {
    const r = authConfigCommand(["auth.sms", "maybe"], cfgPath);
    expect(r.code).toBe(1);
    expect(r.out).toEqual(SMS_EXPLAIN);
    expect(readAuthConfig(cfgPath).sms).toBe(false);
  });
  it("rememberUnlock is off by default and toggles on|off", () => {
    expect(readAuthConfig(cfgPath).bitwarden.rememberUnlock).toBeUndefined();
    expect(authConfigCommand(["auth.bitwarden.rememberUnlock", "on"], cfgPath).code).toBe(0);
    expect(readAuthConfig(cfgPath).bitwarden.rememberUnlock).toBe(true);
    expect(authConfigCommand(["auth.bitwarden.rememberUnlock", "maybe"], cfgPath).code).not.toBe(0);
  });
  it("bitwarden locks accept never/0 to turn a timer off", () => {
    expect(authConfigCommand(["auth.bitwarden.idleLockMinutes", "never"], cfgPath).code).toBe(0);
    authConfigCommand(["auth.bitwarden.maxUnlockHours", "0"], cfgPath);
    expect(readAuthConfig(cfgPath).bitwarden).toEqual({ idleLockMinutes: 0, maxUnlockHours: 0 });
    expect(lockMs(0, 60_000)).toBe(Infinity);
    expect(lockMs(30, 60_000)).toBe(1_800_000);
    authConfigCommand(["auth.bitwarden.idleLockMinutes", "2"], cfgPath);
    expect(readAuthConfig(cfgPath).bitwarden.idleLockMinutes).toBe(5);
    expect(authConfigCommand(["auth.bitwarden.idleLockMinutes", "soon"], cfgPath).code).not.toBe(0);
  });
  it("defaults: sms off, 1password only, bitwarden locks clamp to their ranges", () => {
    expect(readAuthConfig(cfgPath)).toEqual({ providers: ["1password"], sms: false, bitwarden: { idleLockMinutes: 30, maxUnlockHours: 8 } });
    authConfigCommand(["auth.bitwarden.idleLockMinutes", "1"], cfgPath);
    authConfigCommand(["auth.bitwarden.maxUnlockHours", "99"], cfgPath);
    expect(readAuthConfig(cfgPath).bitwarden).toEqual({ idleLockMinutes: 5, maxUnlockHours: 24 });
  });
});

describe("doctor", () => {
  const op = (f: FakeCliDir, signedIn = true) => {
    f.scenario("op", opScenario({ items: [], signedIn }));
    return new OnePasswordProvider({ bin: f.bin("op") });
  };
  it("macOS, db unreadable: FAIL with the exact System Settings path", async () => {
    const f = fakeCliDir();
    const r = await doctorCommand({
      platform: "darwin",
      sms: new SmsSource({ enabled: () => true, platform: "darwin", dbPath: join(dir, "missing.db") }),
      onepassword: op(f),
      bitwarden: new BitwardenProvider({ dataDir: dir, enabled: () => false }),
      config: { providers: ["1password"], sms: false, bitwarden: { idleLockMinutes: 30, maxUnlockHours: 8 } },
      bridge: async () => ({ port: 47615, up: false }),
    });
    const text = r.out.join("\n");
    expect(text).toContain("System Settings > Privacy & Security > Full Disk Access");
    expect(text).toContain("SMS code source off");
    expect(text).toContain("1Password CLI: installed, signed in");
    expect(text).toContain("Bitwarden CLI: disabled");
    expect(text).toContain("Bridge not running");
  });
  it("macOS, db readable: ok with the Text Message Forwarding hint", async () => {
    const db = join(dir, "chat.db");
    writeFileSync(db, "");
    const f = fakeCliDir();
    const r = await doctorCommand({ platform: "darwin", sms: new SmsSource({ enabled: () => true, platform: "darwin", dbPath: db }), onepassword: op(f, false), bitwarden: new BitwardenProvider({ dataDir: dir, enabled: () => false }) });
    expect(r.out.join("\n")).toContain("[ok  ] Messages database readable");
    expect(r.out.join("\n")).toContain("Text Message Forwarding");
    expect(r.out.join("\n")).toContain("1Password CLI: logged-out");
  });
  it("Linux: SMS UNSUPPORTED, database never touched", async () => {
    const f = fakeCliDir();
    const r = await doctorCommand({ platform: "linux", onepassword: op(f), bitwarden: new BitwardenProvider({ dataDir: dir, enabled: () => false }) });
    expect(r.out.join("\n")).toContain("SMS codes: UNSUPPORTED (macOS only)");
    expect(r.out.join("\n")).not.toContain("Messages database");
  });
});

describe("bitwarden commands", () => {
  let f: FakeCliDir;
  let KEY: string;
  let bw: string;
  beforeEach(() => {
    f = fakeCliDir();
    bw = f.bin("bw");
    KEY = "K" + randomBytes(24).toString("base64url");
    f.scenario("bw", bwScenario({ key: KEY, items: [] }));
  });
  const enable = () => bitwardenCommand(["enable"], {}, { configPath: cfgPath, dataDir: join(dir, "bw"), path: f.dir });

  it("enable resolves bw once, checks the version, adds the provider and states the risk", async () => {
    const r = await enable();
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("any process running as your macOS user");
    expect(readAuthConfig(cfgPath)).toMatchObject({ providers: ["1password", "bitwarden"], bitwarden: { bin: bw } });
    expect(resolveBin("bw", f.dir)).toBe(bw);
    expect(resolveBin("bw", join(dir, "empty"))).toBeNull();
  });
  it("enable refuses an old bw and a missing one", async () => {
    f.scenario("bw", bwScenario({ key: KEY, items: [], version: "1.0.0" }));
    expect((await enable()).code).toBe(1);
    expect((await bitwardenCommand(["enable"], {}, { configPath: cfgPath, path: join(dir, "nothing") })).err[0]).toContain("not found");
  });
  it("unlock and login refuse when the provider is not enabled", async () => {
    for (const sub of ["unlock", "login"]) {
      const r = await bitwardenCommand([sub], {}, { configPath: cfgPath, isTTY: true });
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain("not enabled");
    }
  });
  it("unlock and login refuse a non-TTY stdin (an agent's shell)", async () => {
    await enable();
    let ran = false;
    for (const sub of ["unlock", "login"]) {
      const r = await bitwardenCommand([sub], {}, { configPath: cfgPath, isTTY: false, interactive: async () => ((ran = true), { code: 0, stdout: KEY }) });
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain("not a TTY");
    }
    expect(ran).toBe(false);
  });
  it("unlock hands the key to the daemon over the admin route and never prints it", async () => {
    await enable();
    const posted: unknown[] = [];
    const r = await bitwardenCommand(["unlock"], {}, {
      configPath: cfgPath,
      dataDir: join(dir, "bw"),
      isTTY: true,
      interactive: async (_b, args) => (expect(args).toEqual(["unlock", "--raw"]), { code: 0, stdout: KEY + "\n" }),
      ensureDaemon: async () => true,
      admin: async (method, body) => (posted.push({ method, body }), { status: 204 }),
    });
    expect(r.code).toBe(0);
    expect(posted).toEqual([{ method: "POST", body: { key: KEY } }]);
    expect(JSON.stringify(r)).not.toContain(KEY);
    const st = f.calls().find((c) => c.argv[0] === "status")!;
    expect(st.BW_SESSION).toBe(KEY); // checked with bw status in the TabAgent data dir
    expect(st.BITWARDENCLI_APPDATA_DIR).toBe(join(dir, "bw"));
  });
  it("daemon unreachable and can't be started → bw lock, non-zero, key absent from stdout and stderr", async () => {
    await enable();
    const r = await bitwardenCommand(["unlock"], {}, { configPath: cfgPath, isTTY: true, interactive: async () => ({ code: 0, stdout: KEY }), ensureDaemon: async () => false, admin: async () => ({ status: 204 }) });
    expect(r.code).toBe(1);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(f.calls().at(-1)!.argv[0]).toBe("lock");
  });
  it("a bad key is rejected by the bw status check, then locked", async () => {
    await enable();
    let posted = false;
    const r = await bitwardenCommand(["unlock"], {}, { configPath: cfgPath, isTTY: true, interactive: async () => ({ code: 0, stdout: "not-the-key-" + "x".repeat(20) }), ensureDaemon: async () => true, admin: async () => ((posted = true), { status: 204 }) });
    expect(r.code).toBe(1);
    expect(posted).toBe(false);
    expect(f.calls().at(-1)!.argv[0]).toBe("lock");
  });
  it("lock and disable call DELETE and bw lock; status shows server and account to the user only", async () => {
    await enable();
    const calls: string[] = [];
    const admin = async (m: string) => (calls.push(m), m === "GET" ? { status: 200, body: { ok: true, status: { state: "locked" } } } : { status: 204 });
    expect((await bitwardenCommand(["lock"], {}, { configPath: cfgPath, admin })).code).toBe(0);
    const st = await bitwardenCommand(["status"], {}, { configPath: cfgPath, admin });
    expect(st.out.join("\n")).toContain("server: https://vault.example.invalid");
    expect((await bitwardenCommand(["disable"], {}, { configPath: cfgPath, admin })).code).toBe(0);
    expect(calls).toEqual(["DELETE", "GET", "DELETE"]);
    expect(readAuthConfig(cfgPath).providers).toEqual(["1password"]);
    expect((await bitwardenCommand(["unlock"], {}, { configPath: cfgPath, isTTY: true })).code).toBe(1);
  });
});
