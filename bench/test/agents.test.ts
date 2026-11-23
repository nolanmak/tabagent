// #24: the real agent adapters build an isolated command line (TabAgent MCP only,
// no built-in tools, no user settings/skills) and parse what the CLI prints.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { agentEnv, claudeArgs, claudeCodeAgent, mcpConfigFor, modelOf, SKILL } from "../agents/claude-code.mjs";
// @ts-expect-error untyped .mjs
import { codexAgent, codexArgs, turnFailure } from "../agents/codex.mjs";
// @ts-expect-error untyped .mjs
import { collect, fromCodexJson } from "../metrics.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const claudeStream = readFileSync(join(HERE, "fixtures/claude-stream.jsonl"), "utf8");
const codexStream = readFileSync(join(HERE, "fixtures/codex-exec.jsonl"), "utf8");
const task = { id: "t", page: "p.html", goal: "Do the thing." };
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("claude-code adapter", () => {
  it("isolates the run: TabAgent MCP only, no built-in tools, no user settings or skills", () => {
    const args = claudeArgs({ prompt: "go", maxSteps: 25, mcpConfig: "/x/mcp.json", model: "m1" });
    expect(flag(args, "--max-turns")).toBe("25");
    expect(flag(args, "--mcp-config")).toBe("/x/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(flag(args, "--allowedTools")).toBe("mcp__tabagent");
    expect(flag(args, "--tools")).toBe("");
    expect(flag(args, "--setting-sources")).toBe("project");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(flag(args, "--append-system-prompt-file")).toBe(SKILL);
    expect(existsSync(SKILL)).toBe(true);
    expect(flag(args, "--model")).toBe("m1");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("the MCP config names only the TabAgent server with the task profile and temp home", () => {
    const c = mcpConfigFor({ cli: "/cli.js", profile: "core", tabagentHome: "/h", node: "/node" });
    expect(c).toEqual({ mcpServers: { tabagent: { command: "/node", args: ["/cli.js", "mcp", "--profile", "core"], env: { TABAGENT_HOME: "/h" } } } });
  });

  it("drops the calling session's Claude Code variables but keeps auth-related env", () => {
    const env = agentEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "/home/u", ANTHROPIC_API_KEY: "k", PATH: "/bin" });
    expect(env).toEqual({ HOME: "/home/u", ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  });

  it("runs the CLI in a temp cwd, records the reported model and returns events", async () => {
    let seen: any;
    const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-test-1" });
    const agent = claudeCodeAgent({
      cli: "/cli.js",
      tabagentHome: "/h",
      run: async (bin: string, args: string[], opts: any) => {
        seen = { bin, args, opts };
        return `${init}\n${claudeStream}`;
      },
    });
    const { events } = await agent.run(task, { startUrl: "http://localhost:1/p.html", profile: "core,data", maxSteps: 7 });
    expect(seen.bin).toBe("claude");
    expect(flag(seen.args, "-p")).toContain("http://localhost:1/p.html");
    expect(flag(seen.args, "--max-turns")).toBe("7");
    const cfg = JSON.parse(readFileSync(flag(seen.args, "--mcp-config"), "utf8"));
    expect(cfg.mcpServers.tabagent.args).toEqual(["/cli.js", "mcp", "--profile", "core,data"]);
    expect(seen.opts.cwd).toMatch(/tabagent-bench-/);
    expect(seen.opts.env.CLAUDECODE).toBeUndefined();
    expect(agent.model).toBe("claude-test-1");
    expect(collect(events).final).toBe("Gadget");
  });

  it("modelOf reads the init line and ignores junk", () => {
    expect(modelOf('junk\n{"type":"system","subtype":"init","model":"x"}\n')).toBe("x");
    expect(modelOf("")).toBeNull();
  });
});

describe("codex adapter", () => {
  it("isolates the run: user config, rules, shell and plugins off; TabAgent added with the task profile", () => {
    const args = codexArgs({ prompt: "go", dir: "/d", cli: "/cli.js", profile: "core", tabagentHome: "/h", model: "gpt-x", skillText: "SKILL", node: "/node" });
    for (const f of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules"]) expect(args).toContain(f);
    expect(flag(args, "-s")).toBe("read-only");
    expect(args.filter((a: string, i: number) => args[i - 1] === "--disable")).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "plugins", "apps"]));
    expect(args).toContain('mcp_servers.tabagent.args=["/cli.js", "mcp", "--profile", "core"]');
    expect(args).toContain('mcp_servers.tabagent.env={TABAGENT_HOME="/h"}');
    expect(args).toContain('developer_instructions="SKILL"');
    expect(flag(args, "-m")).toBe("gpt-x");
    expect(args[args.length - 1]).toBe("go");
  });

  it("parses a recorded codex exec transcript", () => {
    const m = collect(fromCodexJson(codexStream));
    expect(m.calls).toBe(2); // tabs + page_snapshot
    expect(m.modelTokens).toBe(71544 + 162); // cached input is a subset of input
    expect(m.charTokens).toBeGreaterThan(50);
    expect(m.final).toBe("Gadget");
  });

  it("a failed MCP call still counts, with its error text as tool output", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "i", type: "mcp_tool_call", server: "tabagent", tool: "act_click", result: null, error: { message: "abcdefgh" }, status: "failed" } });
    expect(collect(fromCodexJson(line))).toMatchObject({ calls: 1, charTokens: 2, modelTokens: null, final: null });
  });

  it("a failed turn (usage limit, auth) is a run error, not a task failure", async () => {
    const failed = ['{"type":"thread.started"}', '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}'].join("\n");
    expect(turnFailure(failed)).toBe("You have hit your usage limit.");
    expect(turnFailure(codexStream)).toBeNull();
    const agent = codexAgent({ cli: "/cli.js", tabagentHome: "/h", run: async () => failed });
    await expect(agent.run(task, { startUrl: "http://x/", profile: "core", maxSteps: 25 })).rejects.toThrow(/codex turn failed: You have hit your usage limit/);
  });

  it("names the agent and model in rows", async () => {
    const agent = codexAgent({ model: "gpt-x", cli: "/cli.js", tabagentHome: "/h", run: async () => codexStream });
    expect(agent.name).toBe("codex");
    expect(agent.model).toBe("gpt-x");
    const { events } = await agent.run(task, { startUrl: "http://localhost:1/p.html", profile: "core", maxSteps: 25 });
    expect(collect(events).calls).toBe(2);
  });
});
