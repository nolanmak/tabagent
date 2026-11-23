// #23 packaging test (bridge part) + #29 "tarball contains the skill". Needs a build and npm (uses the
// local npm cache; set TABAGENT_SKIP_PACK=1 to skip on machines without registry access).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const PKG = join(__dirname, "..");
const built = existsSync(join(PKG, "dist/cli.js"));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe.skipIf(!built || process.env.TABAGENT_SKIP_PACK === "1")("npm package", () => {
  it("npm pack installs into a clean project: --version, serve answers /v1/health, skill install", async () => {
    const out = mkdtempSync(join(tmpdir(), "tabagent-pack-"));
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", out], { cwd: PKG });
    const info = JSON.parse(stdout)[0];
    const files: string[] = info.files.map((f: any) => f.path);
    expect(files).toContain("skill/SKILL.md");
    expect(files).toContain("dist/cli.js");
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);

    const proj = mkdtempSync(join(tmpdir(), "tabagent-proj-"));
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", private: true }));
    await run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", join(out, readdirSync(out)[0])], { cwd: proj, timeout: 180_000 });
    const home = mkdtempSync(join(tmpdir(), "tabagent-pkghome-"));
    const env = { ...process.env, TABAGENT_HOME: join(home, ".tabagent"), HOME: home, CODEX_HOME: join(home, ".codex") };
    const v = await run("npx", ["--no-install", "tabagent", "--version"], { cwd: proj, env });
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const port = await freePort();
    const serve = spawn("npx", ["--no-install", "tabagent", "serve", "--port", String(port)], { cwd: proj, env, stdio: "ignore", detached: true });
    try {
      let h: any = null;
      for (let i = 0; i < 100 && !h; i++) {
        await new Promise((r) => setTimeout(r, 100));
        h = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json(), () => null);
      }
      expect(h).toMatchObject({ ok: true, protocolVersion: expect.any(Number) });
    } finally {
      try {
        process.kill(-serve.pid!);
      } catch {
        serve.kill();
      }
    }

    const s = await run("npx", ["--no-install", "tabagent", "skill", "install"], { cwd: proj, env });
    expect(s.stdout).toMatch(/Installed \(claude\)/);
    expect(existsSync(join(home, ".claude/skills/tabagent/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex/skills/tabagent/SKILL.md"))).toBe(true);
  }, 240_000);
});
