// Integration tests against the built CLI (packages/bridge/dist/cli.js; run `npm run build` first).
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toMcpName, toolsForProfiles } from "@tabagent/protocol";

const ROOT = join(__dirname, "../../..");
const CLI = join(ROOT, "packages/bridge/dist/cli.js");
const run = promisify(execFile);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const health = async (port: number) => {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()) as any;
  } catch {
    return null;
  }
};

describe.skipIf(!existsSync(CLI))("built CLI", { timeout: 30_000 }, () => {
  let home: string;
  let port: number;
  let env: Record<string, string>;
  const kill: ChildProcess[] = [];
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabagent-cli-"));
    port = await freePort();
    env = { ...(process.env as Record<string, string>), TABAGENT_HOME: home, TABAGENT_PORT: String(port) };
  });
  afterAll(async () => {
    for (const c of kill) c.kill();
    // stop the detached daemon spawned by `tabagent mcp`
    try {
      const pid = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).toString().trim();
      if (pid) for (const p of pid.split("\n")) process.kill(Number(p));
    } catch {
      /* none */
    }
  });

  it("--version prints the version", async () => {
    const { stdout } = await run(process.execPath, [CLI, "--version"], { env });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`tabagent mcp` with no daemon spawns a detached one, and stdout carries only MCP frames", async () => {
    expect(await health(port)).toBeNull();
    const child = spawn(process.execPath, [CLI, "mcp", "--profile", "dev"], { env, stdio: ["pipe", "pipe", "pipe"] });
    kill.push(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-test", version: "1" } } });
    const until = async (pred: () => boolean, ms = 15000) => {
      const t = Date.now() + ms;
      while (!pred() && Date.now() < t) await new Promise((r) => setTimeout(r, 50));
    };
    await until(() => out.includes('"id":1'));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await until(() => out.includes('"id":2'));
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "page_snapshot", arguments: {} } });
    await until(() => out.includes('"id":3'));
    const frames = out.trim().split("\n");
    for (const f of frames) expect(JSON.parse(f).jsonrpc).toBe("2.0");
    const list = frames.map((f) => JSON.parse(f)).find((f) => f.id === 2);
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(toolsForProfiles("dev").map((t) => toMcpName(t.name)).sort());
    const call = frames.map((f) => JSON.parse(f)).find((f) => f.id === 3);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/^NO_EXTENSION/);
    expect(err).toMatch(/pairing code: [A-Z0-9]{3}-[A-Z0-9]{3}/);
    expect(await health(port)).toMatchObject({ ok: true });
    // killing the mcp process leaves the daemon alive
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(await health(port)).toMatchObject({ ok: true });
  }, 30_000);

  it("a second MCP client keeps working after the first one is killed; status shows the pairing code", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
    const c = new Client({ name: "second", version: "1" });
    await c.connect(t);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(13);
    const r: any = await c.callTool({ name: "tabs", arguments: { action: "list" } });
    expect(r.content[0].text).toMatch(/NO_EXTENSION/);
    await c.close();
    const { stdout } = await run(process.execPath, [CLI, "status"], { env }).catch((e) => e);
    expect(stdout).toMatch(/Pairing code: [A-Z0-9]{3}-[A-Z0-9]{3}/);
    const pair = await run(process.execPath, [CLI, "pair"], { env });
    expect(pair.stdout).toMatch(/Pairing code: [A-Z0-9]{3}-[A-Z0-9]{3}/);
  }, 30_000);

  it("tool commands: CLI --json reaches the bridge; errors exit non-zero with the code", async () => {
    const r = await run(process.execPath, [CLI, "nav.goto", "--json", '{"url":"http://x.test"}'], { env }).catch((e) => e);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^NO_EXTENSION/);
    const bad = await run(process.execPath, [CLI, "nav.goto", "--nope", "1"], { env }).catch((e) => e);
    expect(bad.stderr).toMatch(/BAD_REQUEST: Unknown flag/);
    const unknown = await run(process.execPath, [CLI, "nope.tool"], { env }).catch((e) => e);
    expect(unknown.stderr).toMatch(/Unknown command or tool/);
  });

  it("token create (--caps), list, revoke work against the live daemon", async () => {
    const { stdout: tok } = await run(process.execPath, [CLI, "token", "create", "--name", "ci", "--caps", "read", "--sites", "*.example.com"], { env });
    const token = tok.trim();
    expect(token).toMatch(/^tab_/);
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain(token);
    const st = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(st.status).toBe(200);
    const { stdout: list } = await run(process.execPath, [CLI, "token", "list"], { env });
    expect(list).toMatch(/ci\s+caps=read\s+sites=\*\.example\.com/);
    await run(process.execPath, [CLI, "token", "revoke", "ci"], { env });
    const st2 = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(st2.status).toBe(401);
    const bad = await run(process.execPath, [CLI, "token", "create", "--name", "x", "--caps", "read,act"], { env }).catch((e) => e);
    expect(bad.code).toBe(1);
  });

  it("skill install/uninstall into a temp HOME; audit tail; tools list", async () => {
    const h = mkdtempSync(join(tmpdir(), "tabagent-skillhome-"));
    const e2 = { ...env, HOME: h, CODEX_HOME: join(h, ".codex") };
    const i = await run(process.execPath, [CLI, "skill", "install"], { env: e2 });
    expect(i.stdout).toMatch(/Installed \(claude\)/);
    expect(existsSync(join(h, ".claude/skills/tabagent/SKILL.md"))).toBe(true);
    expect(existsSync(join(h, ".codex/skills/tabagent/SKILL.md"))).toBe(true);
    writeFileSync(join(h, ".claude/skills/tabagent/SKILL.md"), "edited");
    const refused = await run(process.execPath, [CLI, "skill", "install", "--claude"], { env: e2 }).catch((e) => e);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/--force/);
    await run(process.execPath, [CLI, "skill", "install", "--claude", "--force"], { env: e2 });
    const u = await run(process.execPath, [CLI, "skill", "uninstall"], { env: e2 });
    expect(u.stdout).toMatch(/Removed \(codex\)/);
    const { stdout: tail } = await run(process.execPath, [CLI, "audit", "tail", "-n", "3"], { env });
    expect(tail).toMatch(/NO_EXTENSION/);
    const { stdout: tools } = await run(process.execPath, [CLI, "tools", "--profile", "core"], { env });
    expect(tools).toMatch(/13 tools/);
  });
});

describe.skipIf(!existsSync(CLI))("tool budget script (#30)", { timeout: 30_000 }, () => {
  const SCRIPT = join(ROOT, "scripts/tool-budget.mjs");
  it("passes on the real tools/list", async () => {
    const { stdout } = await run(process.execPath, [SCRIPT]);
    expect(stdout).toMatch(/ok\s+core\s+13 tools/);
    expect(stdout).toMatch(/ok\s+full/);
    expect(stdout).toMatch(/skill \d+ \/ 1500/);
  });
  it("an over-budget fixture exits non-zero and names the three largest tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabagent-budget-"));
    mkdirSync(dir, { recursive: true });
    const big = (name: string, n: number) => ({ name, description: "x".repeat(n), inputSchema: { type: "object" } });
    const fixture = join(dir, "core.json");
    writeFileSync(fixture, JSON.stringify([big("small", 10), big("huge", 4000), big("large", 3000), big("medium", 1500), big("tiny", 5)]));
    const r = await run(process.execPath, [SCRIPT, "--fixture", `core=${fixture}`]).catch((e) => e);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL core/);
    expect(r.stdout).toMatch(/largest: huge \(\d+\), large \(\d+\), medium \(\d+\)/);
  });
});
