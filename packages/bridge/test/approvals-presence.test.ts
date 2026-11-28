// #108: presence proofs. The bridge never accepts an approval without one; these are the verifier's
// rules (missing, malformed, unknown, expired, replayed, bound to another prompt/answer, bad MAC), the
// macOS adapter around the Swift LocalAuthentication helper, and the guarantee that nothing in the
// environment or config can swap the production provider.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPresenceProvider, PresenceGate, UnsupportedPresence } from "../src/approvals/presence";
import { MacPresence, parseHelperOutput, PRESENCE_SWIFT } from "../src/approvals/presence-mac";
import { startDaemon } from "./helpers";
import type { Daemon } from "../src/daemon";

const mac = (key: Buffer, message: string) => createHmac("sha256", key).update(message).digest("base64");

describe("PresenceGate", () => {
  function gate() {
    let now = 1_000;
    const g = new PresenceGate({ now: () => now, ttlMs: 60_000 });
    return { g, tick: (ms: number) => (now += ms) };
  }
  it("accepts the MAC of its own challenge once", () => {
    const { g } = gate();
    const c = g.issue("answer", "p1|once");
    const proof = { challengeId: c.challengeId, mac: mac(c.key, c.message) };
    expect(g.verify(proof, "answer", "p1|once")).toEqual({ ok: true });
    expect(g.verify(proof, "answer", "p1|once")).toEqual({ ok: false, reason: "replayed" });
  });
  it("rejects a missing or malformed proof", () => {
    const { g } = gate();
    g.issue("answer", "p1|once");
    expect(g.verify(undefined, "answer", "p1|once")).toEqual({ ok: false, reason: "missing" });
    expect(g.verify(null, "answer", "p1|once")).toEqual({ ok: false, reason: "missing" });
    expect(g.verify({ challengeId: 5 }, "answer", "p1|once")).toEqual({ ok: false, reason: "malformed" });
    expect(g.verify({ challengeId: "x", mac: "" }, "answer", "p1|once")).toEqual({ ok: false, reason: "malformed" });
    expect(g.verify("ok", "answer", "p1|once")).toEqual({ ok: false, reason: "malformed" });
  });
  it("rejects an unknown challenge", () => {
    const { g } = gate();
    expect(g.verify({ challengeId: "deadbeef".repeat(4), mac: "AAAA" }, "answer", "p1|once")).toEqual({ ok: false, reason: "unknown" });
  });
  it("rejects an expired proof", () => {
    const { g, tick } = gate();
    const c = g.issue("answer", "p1|once");
    tick(60_001);
    expect(g.verify({ challengeId: c.challengeId, mac: mac(c.key, c.message) }, "answer", "p1|once")).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects a proof for another prompt, another answer or another purpose", () => {
    for (const [purpose, binding] of [
      ["answer", "p2|once"],
      ["answer", "p1|always"],
      ["phone-link", "p1|once"],
    ] as const) {
      const { g } = gate();
      const c = g.issue("answer", "p1|once");
      expect(g.verify({ challengeId: c.challengeId, mac: mac(c.key, c.message) }, purpose, binding)).toEqual({ ok: false, reason: "mismatch" });
    }
  });
  it("rejects a bad MAC, and a failed attempt uses the challenge up", () => {
    const { g } = gate();
    const c = g.issue("answer", "p1|once");
    expect(g.verify({ challengeId: c.challengeId, mac: mac(Buffer.from("guess"), c.message) }, "answer", "p1|once")).toEqual({ ok: false, reason: "bad_mac" });
    expect(g.verify({ challengeId: c.challengeId, mac: mac(c.key, c.message) }, "answer", "p1|once")).toEqual({ ok: false, reason: "replayed" });
  });
  it("uses a fresh 256-bit key and a message naming the purpose and binding per challenge", () => {
    const { g } = gate();
    const a = g.issue("answer", "p1|once");
    const b = g.issue("answer", "p1|once");
    expect(a.key.length).toBe(32);
    expect(a.key.equals(b.key)).toBe(false);
    expect(a.challengeId).not.toBe(b.challengeId);
    expect(a.message).toContain("tabagent-presence-v1");
    expect(a.message).toContain("answer");
    expect(a.message).toContain("p1|once");
  });
  it("forgets old challenges", () => {
    const { g, tick } = gate();
    for (let i = 0; i < 5; i++) g.issue("answer", `p${i}|once`);
    tick(10 * 60_000);
    g.issue("answer", "p9|once");
    expect(g.size).toBe(1);
  });
});

describe("macOS adapter (Swift LocalAuthentication helper)", () => {
  function deps(stdout: string, o: { code?: number; timedOut?: boolean; exists?: boolean } = {}) {
    const log: string[] = [];
    let built = o.exists ?? false;
    return {
      log,
      d: {
        home: () => "/home/u/.tabagent",
        exists: () => built,
        compile: async (_src: string, out: string) => {
          log.push(`compile ${out}`);
          built = true;
        },
        run: async (bin: string, input: string, timeoutMs: number) => {
          log.push(`run ${bin} ${timeoutMs}`);
          log.push(input);
          return { code: o.code ?? 0, stdout, timedOut: !!o.timedOut };
        },
      },
    };
  }
  const req = { reason: 'approve "Allow once": jarvis wants to read https://a.example', message: "m", key: Buffer.alloc(32, 7), timeoutMs: 30_000 };

  it("compiles the helper once into the TabAgent home and passes the request on stdin", async () => {
    const { d, log } = deps(JSON.stringify({ ok: true, mac: "QUJD" }));
    const p = new MacPresence(d);
    expect(await p.prove(req)).toEqual({ ok: true, mac: "QUJD" });
    await p.prove(req);
    expect(log.filter((l) => l.startsWith("compile"))).toHaveLength(1);
    expect(log[0]).toMatch(/^compile \/home\/u\/\.tabagent\/bin\/presence-[0-9a-f]{12}$/);
    const input = JSON.parse(log[2]);
    expect(input).toEqual({ reason: req.reason, message: "m", key: req.key.toString("base64") });
  });
  it("maps helper failures", async () => {
    expect(await new MacPresence(deps(JSON.stringify({ ok: false, error: "cancelled" }), { code: 1, exists: true }).d).prove(req)).toEqual({ ok: false, error: "cancelled" });
    expect(await new MacPresence(deps("", { timedOut: true, exists: true }).d).prove(req)).toEqual({ ok: false, error: "timeout" });
    expect((await new MacPresence(deps("garbage", { code: 1, exists: true }).d).prove(req)).ok).toBe(false);
  });
  it("reports a missing Swift toolchain as unavailable", async () => {
    const d = deps("").d;
    d.compile = async () => {
      throw new Error("spawn swiftc ENOENT");
    };
    const r = await new MacPresence(d).prove(req);
    expect(r).toMatchObject({ ok: false, error: "unavailable" });
    expect((r as { detail?: string }).detail).toMatch(/xcode-select --install/);
  });
  it("parses helper output strictly", () => {
    expect(parseHelperOutput('{"ok":true,"mac":"QUJD"}\n')).toEqual({ ok: true, mac: "QUJD" });
    expect(parseHelperOutput('{"ok":true}')).toEqual({ ok: false, error: "failed", detail: "no proof in helper output" });
    expect(parseHelperOutput('{"ok":false,"error":"unavailable","detail":"No password set"}')).toEqual({ ok: false, error: "unavailable", detail: "No password set" });
    expect(parseHelperOutput('{"ok":false,"error":"weird"}')).toEqual({ ok: false, error: "failed" });
    expect(parseHelperOutput("")).toEqual({ ok: false, error: "failed", detail: "no output from helper" });
  });
  it("the helper evaluates deviceOwnerAuthentication and computes the proof only after it succeeds", () => {
    expect(PRESENCE_SWIFT).toContain("import LocalAuthentication");
    expect(PRESENCE_SWIFT).toContain(".deviceOwnerAuthentication");
    const evalAt = PRESENCE_SWIFT.indexOf("evaluatePolicy(");
    const macAt = PRESENCE_SWIFT.indexOf("HMAC<SHA256>");
    expect(evalAt).toBeGreaterThan(0);
    expect(macAt).toBeGreaterThan(evalAt);
    expect(PRESENCE_SWIFT).not.toMatch(/getenv|ProcessInfo/);
  });

  let swiftc = false;
  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore" });
    swiftc = process.platform === "darwin";
  } catch {
    swiftc = false;
  }
  // Real helper, no UI: --check only asks canEvaluatePolicy, and a bad request exits before any dialog.
  it.skipIf(!swiftc)("the real helper compiles; --check and a bad request never show a dialog", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabagent-presence-"));
    const src = join(dir, "p.swift");
    const bin = join(dir, "p");
    writeFileSync(src, PRESENCE_SWIFT);
    execFileSync("swiftc", ["-swift-version", "5", "-O", "-o", bin, src], { stdio: "pipe" });
    const check = JSON.parse(execFileSync(bin, ["--check"], { encoding: "utf8" }));
    expect(typeof check.ok).toBe("boolean");
    let bad = "";
    try {
      execFileSync(bin, [], { input: "{}", encoding: "utf8" });
    } catch (e) {
      bad = String((e as { stdout?: string }).stdout ?? "");
    }
    expect(JSON.parse(bad)).toEqual({ ok: false, error: "bad_request" });
  });
});

describe("the production provider cannot be swapped", () => {
  const ENV = ["TABAGENT_PRESENCE", "TABAGENT_APPROVE_NO_PRESENCE", "TABAGENT_TEST", "TABAGENT_SKIP_PRESENCE", "NODE_ENV", "CI"];
  const saved: Record<string, string | undefined> = {};
  let daemons: Daemon[] = [];
  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of daemons) await d.stop();
    daemons = [];
  });
  function poison() {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.TABAGENT_PRESENCE = "fake";
    process.env.TABAGENT_APPROVE_NO_PRESENCE = "1";
    process.env.TABAGENT_SKIP_PRESENCE = "1";
    process.env.TABAGENT_TEST = "1";
    process.env.NODE_ENV = "test";
    process.env.CI = "true";
  }
  it("is chosen by platform only, whatever the environment says", () => {
    poison();
    expect(defaultPresenceProvider("darwin")).toBeInstanceOf(MacPresence);
    expect(defaultPresenceProvider("linux")).toBeInstanceOf(UnsupportedPresence);
    expect(defaultPresenceProvider("win32")).toBeInstanceOf(UnsupportedPresence);
  });
  it("unsupported platforms never prove presence", async () => {
    expect(await new UnsupportedPresence().prove({ reason: "r", message: "m", key: Buffer.alloc(32), timeoutMs: 1 })).toMatchObject({ ok: false, error: "unavailable" });
  });
  it("a daemon started without an injected provider uses the platform provider even with a poisoned env and config", async () => {
    poison();
    const r = await startDaemon();
    daemons.push(r.d);
    writeFileSync(join(r.home, "config.json"), JSON.stringify({ ...r.cfg, presence: "fake", approvals: { presence: "none", skipPresence: true }, handoff: { approvals: true, presence: false } }));
    expect(r.d.approvals.presenceKind).toBe(process.platform === "darwin" ? "macos-localauthentication" : "unsupported");
    const r2 = await startDaemon({}, r.home);
    daemons.push(r2.d);
    expect(r2.d.approvals.presenceKind).toBe(process.platform === "darwin" ? "macos-localauthentication" : "unsupported");
  });
});
