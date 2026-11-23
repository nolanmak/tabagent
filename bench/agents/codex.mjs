// Real agent adapter: Codex CLI (`codex exec --json`) with only the TabAgent
// MCP server. Isolation matches scripts/live-agent-check.mjs: CODEX_HOME stays
// default for auth only (a temp one would need the auth file copied, and a
// token refresh there would rotate the user's real refresh token), with
// --ignore-user-config, --ignore-rules, --ephemeral, shell/browser/apps/plugin
// features disabled, the TabAgent server added with -c, and SKILL.md passed as
// developer_instructions.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromCodexJson } from "../metrics.mjs";
import { agentEnv, promptFor, runProcess, SKILL } from "./claude-code.mjs";

const OFF = ["shell_tool", "unified_exec", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "apps", "plugins", "remote_plugin", "image_generation", "multi_agent", "hooks", "tool_suggest", "skill_mcp_dependency_install"];

const toml = (s) => JSON.stringify(s); // TOML basic strings accept JSON string escapes

export function codexArgs({ prompt, dir, cli, profile, tabagentHome, model, skillText, node = process.execPath }) {
  return [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", dir, "-s", "read-only",
    ...OFF.flatMap((f) => ["--disable", f]),
    "-c", 'approval_policy="never"',
    "-c", `mcp_servers.tabagent.command=${toml(node)}`,
    "-c", `mcp_servers.tabagent.args=[${toml(cli)}, "mcp", "--profile", ${toml(profile)}]`,
    "-c", `mcp_servers.tabagent.env={TABAGENT_HOME=${toml(tabagentHome)}}`,
    "-c", "mcp_servers.tabagent.tool_timeout_sec=150",
    "-c", 'mcp_servers.tabagent.default_tools_approval_mode="approve"',
    ...(skillText ? ["-c", `developer_instructions=${toml(skillText)}`] : []),
    ...(model ? ["-m", model] : []),
    prompt,
  ];
}

/** The message of a `turn.failed` line, if the run had one. */
export function turnFailure(jsonl) {
  for (const line of jsonl.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.type === "turn.failed") return String(j.error?.message ?? "unknown error");
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/**
 * Codex has no max-turns flag, so maxSteps is enforced by the wall-clock
 * timeout only; the step limit is stated in the prompt.
 */
export function codexAgent({ model, cli, tabagentHome, bin = "codex", timeoutMs = 420_000, skill = SKILL, run = runProcess }) {
  const skillText = skill ? readFileSync(skill, "utf8") : null;
  return {
    name: "codex",
    model: model ?? "default",
    async run(task, { startUrl, profile, maxSteps }) {
      const dir = mkdtempSync(join(tmpdir(), "tabagent-bench-codex-"));
      const prompt = `${promptFor(task, startUrl)}\nUse at most ${maxSteps} tool calls.`;
      const args = codexArgs({ prompt, dir, cli, profile, tabagentHome, model, skillText });
      const out = await run(bin, args, { cwd: dir, env: agentEnv(), timeoutMs });
      writeFileSync(join(dir, "transcript.jsonl"), out);
      const failed = turnFailure(out);
      // A turn that never reached the model (usage limit, auth, network) is a run error, not a task failure.
      if (failed) throw new Error(`codex turn failed: ${failed}`);
      return { events: fromCodexJson(out), transcript: join(dir, "transcript.jsonl") };
    },
  };
}
