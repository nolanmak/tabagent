// #152: `tabagent setup claude|codex`. Reads the agent's MCP entry for TabAgent, rewrites it to a version that
// links to the side panel, and prints what to do next. Only ever runs `claude` / `codex` through execFile.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Flags } from "./args";
import type { Out } from "./commands";
import { CHANNEL_MIN_CLAUDE_VERSION, DEFAULT_CHANNEL_NAME } from "./agents/channels";

export const SETUP_USAGE = "Usage: tabagent setup claude [--scope user|project|local] [--profile P] [--channels] [--dry-run] [--local] | setup codex [--profile P] [--dry-run] [--local]";
const NAME = DEFAULT_CHANNEL_NAME;
const PKG = "@nolmak/tabagent";
/** The last release whose `tabagent mcp` cannot link to the side panel (#130 shipped after it). */
const LAST_UNLINKED = "0.1.0";
const SCOPES = ["user", "project", "local"] as const;
type Scope = (typeof SCOPES)[number];
const CHANNELS_CMD = `claude --dangerously-load-development-channels server:${NAME}`;
const ALIAS = `alias claude-tab='${CHANNELS_CMD}'`;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The program is not installed (ENOENT). */
  missing?: boolean;
}
export type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

/** execFile, never a shell. */
export const execRunner: Runner = (cmd, args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: e?.code === "ENOENT" });
    });
  });

export interface SetupDeps {
  /** This bridge's dist/cli.js, the target of --local. */
  cliPath: string;
  run?: Runner;
  /** True when cliPath is inside a TabAgent git checkout (default: src/cli.ts sits next to dist/). */
  isCheckout?: (cliPath: string) => boolean;
  shell?: string;
}

interface Entry {
  scope?: Scope;
  type: string;
  command: string;
  args: string[];
  env: [string, string][];
}

/** POSIX-quote for display. */
export function shellQuote(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

const SECRET = /TOKEN|SECRET|KEY|PASSWORD/i;
/** Display copy of an argv with secret-looking env values masked. */
const shown = (argv: string[]) => shellQuote(argv.map((a) => a.replace(/^([A-Z_][A-Z0-9_]*)=.*$/i, (m, k: string) => (SECRET.test(k) ? `${k}=***` : m))));

/** Parse `claude mcp get <name>` text output. */
export function parseClaudeGet(text: string): Entry | null {
  const field = (k: string) => text.match(new RegExp(`^\\s*${k}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  const command = field("Command");
  const type = field("Type") ?? "stdio";
  if (command === undefined && type === "stdio") return null;
  const scopeText = field("Scope") ?? "";
  const scope = SCOPES.find((s) => scopeText.toLowerCase().startsWith(s));
  const env: [string, string][] = [];
  const envBlock = text.match(/^\s*Environment:[ \t]*\n((?:[ \t]{3,}\S.*\n?)*)/m)?.[1] ?? "";
  for (const l of envBlock.split("\n")) {
    const m = l.trim().match(/^([A-Za-z_][\w]*)=(.*)$/);
    if (m) env.push([m[1], m[2]]);
  }
  return { scope, type, command: command ?? field("URL") ?? "", args: (field("Args") ?? "").split(/\s+/).filter(Boolean), env };
}

/** Parse `codex mcp get <name> --json`. */
export function parseCodexGet(text: string): Entry | null {
  try {
    const j = JSON.parse(text);
    const t = j.transport ?? {};
    return { type: t.type ?? "stdio", command: t.command ?? t.url ?? "", args: Array.isArray(t.args) ? t.args.map(String) : [], env: Object.entries((t.env ?? {}) as Record<string, string>).map(([k, v]) => [k, String(v)]) };
  } catch {
    return null;
  }
}

/** The args after `mcp`, with --profile replaced when the user gave one. */
function serverArgs(existing: Entry | null, profile: string | undefined): string[] {
  const args = existing?.type === "stdio" ? existing.args : [];
  const i = args.indexOf("mcp");
  let extra = i >= 0 ? args.slice(i + 1) : [];
  if (profile === undefined) return extra;
  const out: string[] = [];
  for (let j = 0; j < extra.length; j++) {
    if (extra[j] === "--profile") j++;
    else if (!extra[j].startsWith("--profile=")) out.push(extra[j]);
  }
  extra = [...out, "--profile", profile];
  return extra;
}

const semver = (s: string) => s.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number);
function versionLte(a: string, b: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
}

/** Which TabAgent version an entry runs, when it can be told without starting the server. */
async function entryVersion(e: Entry, run: Runner): Promise<string | undefined> {
  if (e.type !== "stdio") return `n/a (${e.type} server)`;
  if (basename(e.command) === "npx" || basename(e.command) === "npx.cmd") {
    const spec = e.args.find((a) => a === PKG || a.startsWith(`${PKG}@`));
    if (!spec) return undefined;
    const tag = spec.slice(PKG.length + 1);
    return tag ? `${tag} (npx)` : "unpinned (npx may keep running an older cached copy)";
  }
  const i = e.args.indexOf("mcp");
  const r = await run(e.command, [...(i >= 0 ? e.args.slice(0, i) : []), "--version"], 10_000);
  const v = r.code === 0 ? r.stdout.trim().split("\n")[0] : "";
  return semver(v) ? v : undefined;
}

const versionNote = (v: string) => (semver(v) && versionLte(v, LAST_UNLINKED) ? `${v}  (too old to link to the side panel; needs a release after ${LAST_UNLINKED})` : v);
const sameEntry = (a: Entry, b: Entry) => a.type === "stdio" && a.command === b.command && a.args.join("\0") === b.args.join("\0") && a.env.map((e) => e.join("=")).join("\0") === b.env.map((e) => e.join("=")).join("\0");

function rcFile(shell: string | undefined): string {
  const s = basename(shell ?? "");
  return s === "zsh" ? "~/.zshrc" : s === "bash" ? "~/.bashrc" : "~/.profile";
}

export async function setupCommand(pos: string[], f: Flags, d: SetupDeps): Promise<Out> {
  const agent = pos[0];
  const out: string[] = [];
  const err: string[] = [];
  const fail = (msg: string): Out => ({ out, err: [...err, msg], code: 1 });
  if (agent !== "claude" && agent !== "codex") return fail(SETUP_USAGE);
  const run = d.run ?? execRunner;
  const isClaude = agent === "claude";
  const bin = agent;
  const label = isClaude ? "Claude Code" : "Codex";
  if (f.scope !== undefined && !SCOPES.includes(f.scope as Scope)) return fail("--scope must be user, project or local");
  const scope: Scope = (f.scope as Scope | undefined) ?? "user";
  if (!isClaude && f.scope !== undefined) out.push("Codex has no scopes; --scope is ignored (Codex keeps MCP servers in ~/.codex/config.toml).");
  const profile = typeof f.profile === "string" ? f.profile : undefined;
  const dry = !!f["dry-run"];

  let target: { command: string; prefix: string[] };
  if (f.local) {
    const isCheckout = d.isCheckout ?? ((p: string) => !p.split(/[\\/]/).includes("node_modules") && existsSync(join(dirname(p), "../src/cli.ts")));
    if (!isCheckout(d.cliPath)) return fail(`--local needs a TabAgent git checkout (built with \`npm run build\`); this tabagent runs from ${d.cliPath}.`);
    target = { command: "node", prefix: [d.cliPath, "mcp"] };
  } else target = { command: "npx", prefix: ["-y", `${PKG}@latest`, "mcp"] };

  // 1. What is there now.
  const getArgs = isClaude ? ["mcp", "get", NAME] : ["mcp", "get", NAME, "--json"];
  const got = await run(bin, getArgs);
  const want = (existing: Entry | null): Entry => ({ type: "stdio", command: target.command, args: [...target.prefix, ...serverArgs(existing, profile)], env: existing?.env ?? [] });
  const addArgs = (e: Entry) =>
    isClaude
      ? ["mcp", "add", NAME, "-s", scope, ...e.env.flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", e.command, ...e.args]
      : ["mcp", "add", NAME, ...e.env.flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", e.command, ...e.args];
  if (got.missing) {
    const manual = `${bin} ${shown(addArgs(want(null)))}`;
    return fail(
      isClaude
        ? `Claude Code (\`claude\`) is not on your PATH. Install it (https://docs.claude.com/en/docs/claude-code), or add TabAgent by hand:\n  ${manual}`
        : `Codex (\`codex\`) is not on your PATH. Install it (https://github.com/openai/codex), or add TabAgent by hand:\n  ${manual}`,
    );
  }
  const existing = got.code === 0 ? (isClaude ? parseClaudeGet(got.stdout) : parseCodexGet(got.stdout)) : null;
  if (existing) {
    out.push(`Found the ${NAME} MCP server in ${label}${existing.scope ? ` (${existing.scope} scope)` : ""}:`);
    out.push(`  Command: ${shown([existing.command, ...existing.args])}`);
    for (const [k, v] of existing.env) out.push(`  Env: ${shown([`${k}=${v}`])}`);
    const v = await entryVersion(existing, run);
    out.push(`  Version: ${v ? versionNote(v) : "unknown"}`);
  } else out.push(`No ${NAME} MCP server in ${label} yet.`);

  // 2. What it should be.
  const next = want(existing);
  const steps: string[][] = [];
  if (existing && isClaude && existing.scope === scope && sameEntry(existing, next)) out.push("", "Already up to date.");
  else if (existing && !isClaude && sameEntry(existing, next)) out.push("", "Already up to date.");
  else {
    if (existing) {
      if (!isClaude) steps.push(["mcp", "remove", NAME]);
      else if (existing.scope === "project" && scope !== "project")
        out.push("", `Note: the project-scoped entry in .mcp.json is left alone and still wins in that project; remove it there (\`claude mcp remove ${NAME} -s project\`) if it should use the new one.`);
      else steps.push(["mcp", "remove", NAME, ...(existing.scope ? ["-s", existing.scope] : [])]);
    }
    steps.push(addArgs(next));
    out.push("", dry ? "Dry run; these commands would run (nothing changed):" : `Updating it${isClaude ? ` (${scope} scope)` : ""}:`);
    for (const s of steps) {
      out.push(`  $ ${bin} ${shown(s)}`);
      if (dry) continue;
      const r = await run(bin, s);
      if (r.code !== 0) return fail(`\`${bin} ${s.slice(0, 2).join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
    if (!dry) out.push("Done.");
  }

  // 3. What to do next.
  out.push("", "Next steps:");
  if (!isClaude) {
    out.push(`  1. Restart each Codex session so it starts the new ${NAME} server.`, "  2. Codex threads hosted by the Codex app-server get side panel messages queued; they need no linking.");
    return { out, err, code: 0 };
  }
  out.push(
    "  1. Restart each Claude Code session (quit, then `claude --resume` keeps the conversation) so it starts the",
    "     new server. Within a few seconds its row in the TabAgent side panel shows \"linked\" and Send works.",
    "  2. Messages reach a linked session on its next browser action. For instant delivery, start Claude Code",
    "     with TabAgent loaded as a channel (experimental):",
    `       ${CHANNELS_CMD}`,
    "     Claude Code asks once to allow loading a \"local development\" channel; accept it. A shell alias helps:",
    `       ${ALIAS}`,
    "  3. Sessions started with `claude --remote-control` can also be opened from the panel via Remote Control.",
  );
  if (f.channels) {
    const v = await run("claude", ["--version"], 10_000);
    const cv = v.stdout.trim().split(/\s+/)[0] ?? "";
    if (semver(cv) && !versionLte(CHANNEL_MIN_CLAUDE_VERSION, cv)) out.push("", `Warning: Claude Code ${cv} is older than ${CHANNEL_MIN_CLAUDE_VERSION}, the first release that acts on channel pushes. Update it (\`claude update\`).`);
    out.push("", "To keep the alias, add it to your shell startup file:", `  echo ${shellQuote([ALIAS])} >> ${rcFile(d.shell ?? process.env.SHELL)}`);
  }
  return { out, err, code: 0 };
}
