// Spawn route (§6, spike §5): `claude --bg <text>` in the agent's cwd. The outcome rules are pure; the
// execFile call is the thin adapter at the bottom.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { AgentSendCode } from "@tabagent/protocol";

export const SPAWN_TIMEOUT_MS = 30_000;
const DETAIL_MAX = 500;

export interface ExecResult {
  error: { code?: string | number | null; killed?: boolean; signal?: string | null; message?: string } | null;
  stdout: string;
  stderr: string;
}

export type SpawnOutcome = { state: "started"; detail: string; shortId?: string } | { state: "failed"; code: AgentSendCode; detail: string };

const cap = (s: string) => (s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 1) + "…" : s);
const firstLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

export function spawnOutcome(r: ExecResult, timeoutMs = SPAWN_TIMEOUT_MS): SpawnOutcome {
  const out = `${r.stdout}\n${r.stderr}`;
  const untrusted = out.split("\n").find((l) => l.includes("Workspace not trusted"));
  if (untrusted) return { state: "failed", code: "WORKSPACE_UNTRUSTED", detail: cap(untrusted.trim()) };
  if (!r.error) {
    const id = /backgrounded · ([0-9a-f]{8})/.exec(r.stdout)?.[1];
    return id ? { state: "started", shortId: id, detail: `Started background session ${id}. Attach with: claude attach ${id}` } : { state: "started", detail: "Started a background session." };
  }
  if (r.error.code === "ENOENT") return { state: "failed", code: "SPAWN_FAILED", detail: "claude was not found on PATH" };
  if (r.error.killed || r.error.signal) return { state: "failed", code: "SPAWN_FAILED", detail: `claude --bg did not finish within ${timeoutMs / 1000} s` };
  const msg = firstLine(r.stderr) || firstLine(r.stdout);
  return { state: "failed", code: "SPAWN_FAILED", detail: cap(msg || `claude --bg exited with code ${r.error.code ?? "?"}`) };
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Run `claude --bg <text>` with cwd. The text starts with `[`, so it is never parsed as a flag. */
export function runSpawn(claudeBin: string, text: string, cwd: string, timeoutMs = SPAWN_TIMEOUT_MS): Promise<SpawnOutcome> {
  if (!cwd || !isDirectory(cwd)) return Promise.resolve({ state: "failed", code: "NO_CWD", detail: cwd ? `The agent's folder no longer exists: ${cwd}` : "The agent has no working folder" });
  return new Promise((resolve) => {
    execFile(claudeBin, ["--bg", text], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve(spawnOutcome({ error: error as ExecResult["error"], stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }, timeoutMs));
    });
  });
}
