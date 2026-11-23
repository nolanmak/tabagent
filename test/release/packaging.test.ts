// #23 packaging: the `npm pack` tarball installs into a clean project and
// `tabagent --version`, `tabagent serve` (answers health) and
// `tabagent skill install` (temp HOME) work from the installed copy.
// Needs registry access for the runtime dependencies.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, freePort, readJson, requireBuilt, ROOT, tempHome } from "./helpers";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let project = "";
let bin = "";
const pkg = readJson(join(ROOT, "packages/bridge/package.json"));

beforeAll(() => {
  requireBuilt(CLI);
  const packDir = tempHome("tabagent-pack-");
  execFileSync(npm, ["pack", "-w", "@nolmak/tabagent", "--pack-destination", packDir], { cwd: ROOT, stdio: "pipe" });
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");
  project = tempHome("tabagent-install-");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }));
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(packDir, tgz)], { cwd: project, stdio: "pipe" });
  bin = join(project, "node_modules", "@nolmak", "tabagent", pkg.bin.tabagent);
}, 300_000);

describe("npm package", () => {
  it("tarball ships the CLI, the skill and the built extension", () => {
    const installed = join(project, "node_modules", "@nolmak", "tabagent");
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(installed, "skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(installed, "dist", "extension", "manifest.json"))).toBe(true);
  });

  it("installed `tabagent --version` prints the package version", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out).toContain(pkg.version);
  });

  describe("serve", () => {
    let child: ReturnType<typeof spawn> | undefined;
    afterAll(() => child?.kill("SIGTERM"));

    it("installed `tabagent serve` starts and answers health", async () => {
      const port = await freePort();
      child = spawn(process.execPath, [bin, "serve"], {
        env: { ...process.env, TABAGENT_HOME: tempHome(), TABAGENT_PORT: String(port) },
        stdio: "ignore",
      });
      const deadline = Date.now() + 15_000;
      let body: any = null;
      while (Date.now() < deadline && !body) {
        for (const path of ["/v1/health", "/health"]) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}${path}`);
            if (r.ok) body = await r.json();
          } catch {
            /* not up yet */
          }
          if (body) break;
        }
        if (!body) await new Promise((r) => setTimeout(r, 200));
      }
      expect(body).toMatchObject({ ok: true, bridgeVersion: pkg.version });
    });
  });

  it("installed `tabagent skill install` writes into a temp HOME", () => {
    const home = tempHome("tabagent-skillhome-");
    execFileSync(process.execPath, [bin, "skill", "install", "--claude", "--codex"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex") },
      stdio: "pipe",
    });
    expect(existsSync(join(home, ".claude", "skills", "tabagent", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", "tabagent", "SKILL.md"))).toBe(true);
  });
});
