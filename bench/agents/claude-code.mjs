// Real agent adapter: Claude Code in print mode with only the TabAgent MCP
// server. Needs `claude` on PATH and a login (or ANTHROPIC_API_KEY).
//
// Isolation is the same as scripts/live-agent-check.mjs: the default config dir
// is used for auth only (a temp CLAUDE_CONFIG_DIR loses the keychain login), and
// everything else is switched off: --strict-mcp-config with a TabAgent-only
// --mcp-config, --setting-sources project from an empty temp cwd (no user hooks,
// plugins or settings), --disable-slash-commands (no installed skills),
// --tools "" (no built-in tools), --no-session-persistence, and the TabAgent
// SKILL.md passed with --append-system-prompt-file.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromClaudeStreamJson } from "../metrics.mjs";

export const SKILL = join(dirname(fileURLToPath(import.meta.url)), "../../packages/bridge/skill/SKILL.md");

export function promptFor(task, startUrl) {
  return [
    `Use only the TabAgent browser tools. Open a new tab at ${startUrl} and do this:`,
    task.goal,
    "When you are finished, reply with only the answer if one was asked for, otherwise reply 'Done.'",
  ].join("\n");
}

export function mcpConfigFor({ cli, profile, tabagentHome, node = process.execPath }) {
  return { mcpServers: { tabagent: { command: node, args: [cli, "mcp", "--profile", profile], env: { TABAGENT_HOME: tabagentHome } } } };
}

export function claudeArgs({ prompt, maxSteps, mcpConfig, model, skill = SKILL }) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(maxSteps),
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__tabagent",
    "--tools",
    "",
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(skill ? ["--append-system-prompt-file", skill] : []),
    ...(model ? ["--model", model] : []),
  ];
}

/** Nested runs must not think they are inside a calling Claude Code session. */
export function agentEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete out[k];
  return out;
}

/** The model Claude Code reported in its init line, if any. */
export function modelOf(streamJson) {
  for (const line of streamJson.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.type === "system" && j.subtype === "init" && j.model) return j.model;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export function runProcess(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"], cwd, env });
    let buf = "";
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.stdout.on("data", (d) => (buf += d));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", () => {
      clearTimeout(t);
      resolve(buf);
    });
  });
}

export function claudeCodeAgent({ model, cli, tabagentHome, bin = "claude", timeoutMs = 420_000, skill = SKILL, run = runProcess }) {
  const agent = {
    name: "claude-code",
    model,
    async run(task, { startUrl, profile, maxSteps }) {
      const dir = mkdtempSync(join(tmpdir(), "tabagent-bench-"));
      const mcpConfig = join(dir, "mcp.json");
      writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor({ cli, profile, tabagentHome })));
      const args = claudeArgs({ prompt: promptFor(task, startUrl), maxSteps, mcpConfig, model, skill });
      const out = await run(bin, args, { cwd: dir, env: agentEnv(), timeoutMs });
      writeFileSync(join(dir, "transcript.jsonl"), out);
      // Record the model the CLI actually used when none was pinned.
      if (!agent.model) agent.model = modelOf(out) ?? undefined;
      return { events: fromClaudeStreamJson(out), transcript: join(dir, "transcript.jsonl") };
    },
  };
  return agent;
}
