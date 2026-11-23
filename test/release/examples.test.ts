// #23: each example config's command starts a working MCP server.
// The published command is `npx -y @nolmak/tabagent mcp ...`; here `npx [-y] @nolmak/tabagent`
// is mapped to the locally built CLI so the test exercises this checkout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { CLI, freePort, requireBuilt, ROOT, stopBridgeOnPort, tempHome } from "./helpers";

interface ServerCmd {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function fromJson(path: string): ServerCmd {
  const j = JSON.parse(readFileSync(path, "utf8"));
  const s = j.mcpServers?.tabagent;
  if (!s) throw new Error(`${path}: no mcpServers.tabagent`);
  return { command: s.command, args: s.args ?? [], env: s.env };
}

/** Minimal reader for the one table the Codex example uses. */
export function fromCodexToml(text: string): ServerCmd {
  const start = text.indexOf("[mcp_servers.tabagent]");
  if (start < 0) throw new Error("no [mcp_servers.tabagent] table");
  const body = text.slice(start).split("\n").slice(1);
  const end = body.findIndex((l) => /^\s*\[/.test(l));
  const lines = end < 0 ? body : body.slice(0, end);
  const get = (k: string) => lines.find((l) => new RegExp(`^\\s*${k}\\s*=`).test(l))?.replace(/^[^=]*=\s*/, "");
  const command = JSON.parse(get("command") ?? '""');
  const args = JSON.parse(get("args") ?? "[]");
  return { command, args };
}

/** `npx [-y] @nolmak/tabagent <rest>` → `node <built cli> <rest>`. */
export function toLocal(cmd: ServerCmd): { command: string; args: string[] } {
  if (cmd.command === "tabagent") return { command: process.execPath, args: [CLI, ...cmd.args] };
  if (cmd.command !== "npx") throw new Error(`unexpected command ${cmd.command}`);
  const args = cmd.args.filter((a) => a !== "-y" && a !== "--yes");
  if (args[0] !== "@nolmak/tabagent") throw new Error(`expected npx @nolmak/tabagent, got ${cmd.args.join(" ")}`);
  return { command: process.execPath, args: [CLI, ...args.slice(1)] };
}

const EXAMPLES: [string, () => ServerCmd][] = [
  ["claude-code", () => fromJson(join(ROOT, "examples/claude-code/.mcp.json"))],
  ["cursor", () => fromJson(join(ROOT, "examples/cursor/mcp.json"))],
  ["codex", () => fromCodexToml(readFileSync(join(ROOT, "examples/codex/config.toml"), "utf8"))],
];

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe("agent examples", () => {
  it("toLocal maps npx forms and rejects others", () => {
    expect(toLocal({ command: "npx", args: ["-y", "@nolmak/tabagent", "mcp"] }).args.slice(1)).toEqual(["mcp"]);
    expect(toLocal({ command: "tabagent", args: ["mcp", "--profile", "dev"] }).args.slice(1)).toEqual(["mcp", "--profile", "dev"]);
    expect(() => toLocal({ command: "npx", args: ["other"] })).toThrow();
    expect(() => toLocal({ command: "python", args: [] })).toThrow();
  });

  it("codex toml reader stops at the next table", () => {
    const t = '[mcp_servers.tabagent]\ncommand = "npx"\nargs = ["@nolmak/tabagent", "mcp"]\n[other]\nargs = ["x"]\n';
    expect(fromCodexToml(t)).toEqual({ command: "npx", args: ["@nolmak/tabagent", "mcp"] });
  });

  for (const [name, load] of EXAMPLES) {
    it(`${name}: command starts an MCP server that lists tools`, async () => {
      requireBuilt(CLI);
      const cmd = load();
      expect(cmd.args).toContain("mcp");
      const local = toLocal(cmd);
      const home = tempHome(`tabagent-example-${name}-`);
      const port = await freePort();
      const transport = new StdioClientTransport({
        command: local.command,
        args: local.args,
        env: { ...(process.env as Record<string, string>), ...(cmd.env ?? {}), TABAGENT_HOME: home, TABAGENT_PORT: String(port) },
        stderr: "pipe",
      });
      const client = new Client({ name: `example-${name}`, version: "0.0.0" });
      cleanup.push(async () => {
        await client.close().catch(() => {});
        await stopBridgeOnPort(port);
      });
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBeTruthy();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("tabs");
      expect(names).toContain("page_snapshot");
      for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    });
  }
});
