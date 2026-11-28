import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { AuditWriter } from "../src/audit";
import { hashToken, saveConfig } from "../src/config";
import type { Daemon } from "../src/daemon";
import { authenticate, bearerOf, createToken, parseSites, revokeToken } from "../src/tokens";
import { okEnvelope, pairedExt, rest, startDaemon, tempHome } from "./helpers";

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** Tool records only (#158 adds task.* events around them). */
const records = (p: string) => lines(p).filter((l) => !l.event);
const rec = (extra = {}) => ({ tool: "act.type", origin: "https://a.test", params: { ref: "e3", text: "[redacted]" }, outcome: "ok", resultSummary: { bytes: 10, sha256: "abc" }, ...extra });

describe("tokens (#15, D3)", () => {
  it("create stores only the SHA-256 hash; plaintext never in config.json", async () => {
    const { cfg, home } = await startDaemon().then((r) => (daemons.push(r.d), r));
    const tok = createToken(cfg, "bot", "read", ["*.github.com"]);
    saveConfig(cfg);
    const disk = readFileSync(join(home, "config.json"), "utf8");
    expect(disk).not.toContain(tok);
    expect(disk).toContain(hashToken(tok));
    expect(cfg.tokens[0]).toMatchObject({ name: "bot", cap: "read", sites: ["*.github.com"] });
  });
  it("default caps is act; --caps is a single max level", () => {
    tempHome();
    const cfg = { secret: "s", tokens: [] as any[] } as any;
    createToken(cfg, "a");
    expect(cfg.tokens[0].cap).toBe("act");
    expect(() => createToken(cfg, "b", "read,act")).toThrow(/single maximum level/);
    expect(() => createToken(cfg, "a")).toThrow(/exists/);
    expect(() => createToken(cfg, "bad name!")).toThrow();
    expect(() => createToken(cfg, "local")).toThrow(/reserved/);
  });
  it("authenticate: secret -> full/no sites; token -> its scope; unknown -> null", () => {
    const cfg = { secret: "the-secret", tokens: [] as any[] } as any;
    const tok = createToken(cfg, "r", "read", ["x.com"]);
    expect(authenticate(cfg, "the-secret")).toEqual({ name: "local", kind: "secret", cap: "full", sites: [] });
    expect(authenticate(cfg, tok)).toEqual({ name: "r", kind: "token", cap: "read", sites: ["x.com"] });
    expect(authenticate(cfg, "nope")).toBeNull();
    expect(authenticate(cfg, undefined)).toBeNull();
    expect(revokeToken(cfg, "r")).toBe(true);
    expect(revokeToken(cfg, "r")).toBe(false);
    expect(authenticate(cfg, tok)).toBeNull();
    expect(bearerOf("Bearer  abc ")).toBe("abc");
    expect(bearerOf("Basic x")).toBeUndefined();
  });
  it("--sites globs are validated", () => {
    expect(parseSites("*.github.com, Example.com")).toEqual(["*.github.com", "example.com"]);
    expect(parseSites(undefined)).toEqual([]);
    expect(() => parseSites("https://x.com")).toThrow(/Bad site glob/);
  });
  it("live reload: a token created or revoked by the CLI applies without restart", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const disk = JSON.parse(readFileSync(join(r.home, "config.json"), "utf8"));
    const tok = createToken(disk, "later", "act");
    await new Promise((res) => setTimeout(res, 20));
    saveConfig(disk);
    expect((await rest(r.base, "/v1/status", tok)).status).toBe(200);
    revokeToken(disk, "later");
    await new Promise((res) => setTimeout(res, 20));
    saveConfig(disk);
    expect((await rest(r.base, "/v1/status", tok)).status).toBe(401);
    expect((await rest(r.base, "/v1/status", "unknown")).status).toBe(401);
  });
});

describe("audit writer (D20)", () => {
  it("appends exactly the extension's record plus caller and ts; file is 0600", () => {
    const h = tempHome();
    const p = join(h, "audit.jsonl");
    const w = new AuditWriter(p, { now: () => new Date("2026-01-01T00:00:00Z") });
    w.record(rec(), { caller: "claude-code", session: "s1" });
    expect(lines(p)).toEqual([{ ts: "2026-01-01T00:00:00.000Z", caller: "claude-code", session: "s1", ...rec() }]);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
  it("malformed records are reduced to a minimal record (no params)", () => {
    const p = join(tempHome(), "audit.jsonl");
    const w = new AuditWriter(p);
    w.record({ tool: "js.eval", params: { expression: "steal()" } }, { caller: "x" });
    w.record(null, { caller: "x" });
    const [a, b] = lines(p);
    expect(a).toMatchObject({ tool: "js.eval", outcome: "error", source: "bridge" });
    expect(a.params).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("steal");
    expect(b.tool).toBe("unknown");
  });
  it("property: a value the extension redacted never reaches the log, and result bodies never do", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const p = join(r.home, "audit.jsonl");
    const e = await pairedExt(r.d);
    let body = "";
    e.onCommand = (c) => okEnvelope({ value: body }, c.tool, { audit: rec({ tool: c.tool, params: { ref: c.params.ref, text: "[redacted]" } }) });
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 6, maxLength: 40 }).filter((s) => !/redacted|act\.type|https|ok|e3|caller|local/.test(s) && s.trim().length > 5), fc.string({ minLength: 8, maxLength: 40 }).filter((s) => s.trim().length > 7), async (secret, resultBody) => {
        body = resultBody;
        await rest(r.base, "/v1/act.type", r.cfg.secret, { ref: "e3", text: secret });
        const log = readFileSync(p, "utf8");
        const enc = (s: string) => JSON.stringify(s).slice(1, -1);
        return !log.includes(enc(secret)) && !log.includes(enc(resultBody));
      }),
      { numRuns: 40 },
    );
    const last = lines(p).at(-1);
    expect(last).toMatchObject({ caller: "local", tool: "act.type", params: { ref: "e3", text: "[redacted]" } });
    e.close();
  });
  it("calls that never reach the extension get a minimal bridge record without params", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    await rest(r.base, "/v1/act.type", r.cfg.secret, { ref: "e1", text: "hunter2-password" });
    const [l] = records(join(r.home, "audit.jsonl"));
    expect(l).toMatchObject({ tool: "act.type", outcome: "error", errorCode: "NO_EXTENSION", origin: null, caller: "local" });
    expect(JSON.stringify(l)).not.toContain("hunter2");
  });
  it("legacy results without an audit record are logged minimally (never raw params)", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    e.onCommand = () => ({ ok: true, result: { typed: "hunter2" } });
    await rest(r.base, "/v1/act.type", r.cfg.secret, { ref: "e1", text: "hunter2" });
    e.onCommand = () => ({ ok: false, error: { code: "PERMISSION_DENIED", message: "no" } });
    await rest(r.base, "/v1/act.type", r.cfg.secret, { ref: "e1", text: "hunter2" });
    const log = readFileSync(join(r.home, "audit.jsonl"), "utf8");
    expect(log).not.toContain("hunter2");
    expect(records(join(r.home, "audit.jsonl")).map((l) => l.outcome)).toEqual(["ok", "denied"]);
    e.close();
  });
  it("events are logged", () => {
    const p = join(tempHome(), "audit.jsonl");
    const w = new AuditWriter(p);
    w.event("killed", undefined, { caller: "extension" });
    w.event("decision", { answer: "once" });
    expect(lines(p).map((l) => [l.event, l.caller, l.data])).toEqual([
      ["killed", "extension", undefined],
      ["decision", undefined, { answer: "once" }],
    ]);
  });
  it("rotates at maxBytes and keeps 5 files", () => {
    const h = tempHome();
    const p = join(h, "audit.jsonl");
    const w = new AuditWriter(p, { maxBytes: 1000 });
    for (let i = 0; i < 200; i++) w.record(rec({ action: `n${i}` }), { caller: "c" });
    const files = readdirSync(h).filter((f) => f.startsWith("audit.jsonl")).sort();
    expect(files).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3", "audit.jsonl.4"]);
    for (const f of files) expect(statSync(join(h, f)).size).toBeLessThanOrEqual(1000);
    expect(lines(p).at(-1).action).toBe("n199");
    expect(existsSync(`${p}.5`)).toBe(false);
  });
  it("default limits are 10 MB x 5", () => {
    const w = new AuditWriter("/dev/null");
    expect([w.maxBytes, w.keep]).toEqual([10 * 1024 * 1024, 5]);
  });
});
