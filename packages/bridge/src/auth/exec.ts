// Child processes for password-manager CLIs (#33, #37). Stdin is closed so a CLI can never prompt
// (TabAgent never asks for or types a master password). Each call has a timeout after which the child
// is killed. Output is returned to the adapter only; it is never logged or put into an error.
import { spawn } from "node:child_process";
import { TabAgentError } from "@tabagent/protocol";

export interface RunOpts {
  /** Extra env for this child only (e.g. BW_SESSION, BITWARDENCLI_APPDATA_DIR). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(bin: string, args: string[], opts?: RunOpts): Promise<RunResult>;
}

/** Env every child inherits: the daemon's, minus session keys (#37: no other child inherits BW_SESSION). */
export function childBaseEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && k !== "BW_SESSION") out[k] = v;
  return out;
}

export const CLI_TIMEOUT_MS = 15_000;

export class CliMissing extends Error {}

/** The real runner. ENOENT → CliMissing; timeout → TIMEOUT (child SIGKILLed). */
export function nodeRunner(): Runner {
  return {
    run(bin, args, opts = {}) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...childBaseEnv(), ...definedOnly(opts.env) }, windowsHide: true });
        } catch {
          return reject(new CliMissing(bin));
        }
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let size = 0;
        const cap = 32 * 1024 * 1024;
        child.stdout!.on("data", (d: Buffer) => {
          size += d.length;
          if (size <= cap) out.push(d);
        });
        child.stderr!.on("data", (d: Buffer) => {
          if (err.length < 64) err.push(d);
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new TabAgentError("TIMEOUT", `${basename(bin)} did not answer within ${Math.round((opts.timeoutMs ?? CLI_TIMEOUT_MS) / 1000)}s`));
        }, opts.timeoutMs ?? CLI_TIMEOUT_MS);
        child.on("error", (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(e.code === "ENOENT" || e.code === "EACCES" ? new CliMissing(bin) : new TabAgentError("INTERNAL", `${basename(bin)} could not be started`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
        });
      });
    },
  };
}

function definedOnly(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) if (v !== undefined) o[k] = v;
  return o;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** One call at a time (#37). `drop` fails everything still queued with the given error. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private dropError: (() => Error) | null = null;

  run<T>(fn: () => Promise<T>): Promise<T> {
    const gen = this.generation;
    const next = this.tail.then(
      () => (gen !== this.generation && this.dropError ? Promise.reject(this.dropError()) : fn()),
      () => (gen !== this.generation && this.dropError ? Promise.reject(this.dropError()) : fn()),
    );
    this.tail = next.catch(() => {});
    return next;
  }

  /** Calls queued before this moment fail with `err()` instead of running. */
  drop(err: () => Error) {
    this.generation++;
    this.dropError = err;
  }
}

/** Compare dotted versions ("2024.1.0" >= "2023.12.1"). */
export function versionAtLeast(have: string, want: string): boolean {
  const a = have.trim().replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = want.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
