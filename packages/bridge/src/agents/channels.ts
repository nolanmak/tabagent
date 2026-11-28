// P3 channel route, detection (spec AD9, spike §2). Claude Code does not advertise channel support in
// `initialize`, so the only signal is the agent process's argv: `--channels` or
// `--dangerously-load-development-channels` followed by an entry naming this server. Pure over an
// injected `ps -o args=` reader; the execFile adapter is at the bottom.
import { execFile } from "node:child_process";

/** The two Claude Code flags that load channels. */
export const CHANNEL_FLAGS = ["--channels", "--dangerously-load-development-channels"] as const;
/** The MCP config key users give TabAgent in the documented install. */
export const DEFAULT_CHANNEL_NAME = "tabagent";
/** First Claude Code release the P0 spike saw act on channel pushes (spike §2). */
export const CHANNEL_MIN_CLAUDE_VERSION = "2.1.332";

/** Shell-like split of one `ps -o args=` line. Quotes group; ps itself drops them, wrappers may not. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const parts = (v: string) => v.split(/[\s,]+/).filter(Boolean);
/** A token that is only channel entries (`server:x`, `plugin:y@m`, comma or space separated). */
const isEntryList = (t: string) => parts(t).length > 0 && parts(t).every((p) => /^(server|plugin):/.test(p));

/** Every entry given to a channel flag, in order. The space-separated list stops at the first non-entry. */
export function channelEntries(args: string | readonly string[]): string[] {
  const argv = typeof args === "string" ? splitArgs(args) : args;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    const flag = CHANNEL_FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
    if (!flag) continue;
    if (a !== flag) out.push(...parts(a.slice(flag.length + 1)));
    else while (i + 1 < argv.length && isEntryList(argv[i + 1])) out.push(...parts(argv[++i]));
  }
  return out;
}

/** AD9: the argv loads this server as a channel: `server:<name>` or `plugin:<name>@<marketplace>`. */
export function loadsChannel(args: string | readonly string[], name: string = DEFAULT_CHANNEL_NAME): boolean {
  return channelEntries(args).some((e) => e === `server:${name}` || (e.startsWith(`plugin:${name}@`) && e.length > `plugin:${name}@`.length));
}

/** The server name to look for: `TABAGENT_CHANNEL_NAME` when the user gave TabAgent another MCP config key. */
export function channelName(env: Record<string, string | undefined>): string {
  const v = env.TABAGENT_CHANNEL_NAME?.trim();
  return v && /^[\w.-]{1,64}$/.test(v) ? v : DEFAULT_CHANNEL_NAME;
}

/** `ps -o args= -p <pid>`: the full command line, or null. */
export type ArgsRead = (pid: number) => Promise<string | null>;

/** AD9 `x-tabagent-channels`: "1" only when the agent process's argv loads this server as a channel. */
export async function channelsFlag(agentPid: number | undefined, read: ArgsRead, name: string = DEFAULT_CHANNEL_NAME): Promise<"0" | "1"> {
  if (!agentPid) return "0";
  const args = await read(agentPid).catch(() => null);
  return args && loadsChannel(args, name) ? "1" : "0";
}

export function parseArgsLine(out: string): string | null {
  const l = (out.split("\n")[0] ?? "").trim();
  return l || null;
}

/** AD9 / §12: methods of Claude's channel permission relay. TabAgent never declares or answers it. */
export function isChannelPermissionMethod(method: string): boolean {
  return /^(notifications\/)?claude\/channel\/permission/.test(method);
}

/** `ps -ww -o args= -p <pid>` (-ww: never truncated to a terminal width). null when ps fails or the pid is gone. */
export const readArgs: ArgsRead = (pid) =>
  new Promise((resolve) => {
    execFile("ps", ["-ww", "-o", "args=", "-p", String(pid)], { timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? null : parseArgsLine(String(stdout))));
  });
