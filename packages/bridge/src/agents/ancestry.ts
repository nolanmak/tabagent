// AD4 (spike §1): find the agent process that owns this `tabagent mcp`. Under the documented install the
// tree is `claude` -> `npm exec` -> `tabagent mcp`, so the parent is usually not the agent. The walk is
// pure over an injected `ps` reader; the execFile adapter is at the bottom.
import { execFile } from "node:child_process";

export interface PsInfo {
  ppid: number;
  comm: string;
}
export type PsRead = (pid: number) => Promise<PsInfo | null>;

export const AGENT_EXECUTABLES = new Set(["claude", "codex"]);
export const ANCESTOR_DEPTH = 8;

/** Codex reports a full path as `comm`, Claude a bare name: compare the basename. */
export function isAgentComm(comm: string): boolean {
  const base = comm.trim().split("/").pop() ?? "";
  return AGENT_EXECUTABLES.has(base);
}

/**
 * Nearest process at or above `startPid` (normally `process.ppid`) whose executable is `claude` or `codex`,
 * checking at most `maxDepth` processes. undefined when none is found, `ps` fails, or the tree loops.
 */
export async function findAgentPid(startPid: number, ps: PsRead, maxDepth = ANCESTOR_DEPTH): Promise<number | undefined> {
  const seen = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) return undefined;
    seen.add(pid);
    const info = await ps(pid).catch(() => null);
    if (!info) return undefined;
    if (isAgentComm(info.comm)) return pid;
    if (info.ppid <= 1) return undefined;
    pid = info.ppid;
  }
  return undefined;
}

/** One line of `ps -o ppid=,comm=`. The comm may contain spaces (a path). */
export function parsePsLine(out: string): PsInfo | null {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out.split("\n")[0] ?? "");
  return m ? { ppid: Number(m[1]), comm: m[2] } : null;
}

/** `ps -o ppid=,comm= -p <pid>`. null when ps is missing (Windows) or the pid is gone. */
export const readPs: PsRead = (pid) =>
  new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? null : parsePsLine(String(stdout))));
  });
