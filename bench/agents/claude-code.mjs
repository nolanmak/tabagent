// Real agent adapter: Claude Code in print mode with only the TabAgent MCP
// server. Needs `claude` on PATH and model credentials (ANTHROPIC_API_KEY).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromClaudeStreamJson } from "../metrics.mjs";

export function promptFor(task, startUrl) {
  return [
    `Use only the TabAgent browser tools. Open a new tab at ${startUrl} and do this:`,
    task.goal,
    "When you are finished, reply with only the answer if one was asked for, otherwise reply 'Done.'",
  ].join("\n");
}

export function claudeCodeAgent({ model, cli, tabagentHome, bin = "claude", timeoutMs = 300_000 }) {
  return {
    name: "claude-code",
    model,
    async run(task, { startUrl, profile, maxSteps }) {
      const dir = mkdtempSync(join(tmpdir(), "tabagent-bench-"));
      const mcpConfig = join(dir, "mcp.json");
      writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { tabagent: { command: process.execPath, args: [cli, "mcp", "--profile", profile], env: { TABAGENT_HOME: tabagentHome } } } }),
      );
      const args = [
        "-p",
        promptFor(task, startUrl),
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
        ...(model ? ["--model", model] : []),
      ];
      const out = await new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"], cwd: dir });
        let buf = "";
        const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
        p.stdout.on("data", (d) => (buf += d));
        p.on("error", reject);
        p.on("close", () => {
          clearTimeout(t);
          resolve(buf);
        });
      });
      writeFileSync(join(dir, "transcript.jsonl"), out);
      return { events: fromClaudeStreamJson(out), transcript: join(dir, "transcript.jsonl") };
    },
  };
}
