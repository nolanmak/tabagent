// Shared helpers for tests that run against built artifacts (`npm run build` first).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(ROOT, "packages/bridge/dist/cli.js");
export const EXT_DIST = join(ROOT, "packages/extension/dist");

export function requireBuilt(path: string): void {
  if (!existsSync(path)) throw new Error(`${path} is missing: run \`npm run build\` before \`npm run test:release\`.`);
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function tempHome(prefix = "tabagent-dist-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Best-effort: stop a bridge that `tabagent mcp` may have spawned detached (D6). */
export async function stopBridgeOnPort(port: number): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening, or lsof unavailable */
  }
}
