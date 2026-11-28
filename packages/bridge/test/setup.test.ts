// #152: `tabagent setup claude|codex`. A stub `claude` / `codex` on PATH records its argv and prints canned
// output, so these run the real execFile adapter without touching the user's agent config.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlags } from "../src/args";
import { parseClaudeGet, parseCodexGet, setupCommand, shellQuote } from "../src/setup";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const dir = path.dirname(process.argv[1]);
const name = path.basename(process.argv[1]);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify([name, ...argv]) + "\\n");
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return null; } };
if (argv[argv.length - 1] === "--version") { process.stdout.write(read(name + ".version") ?? "2.1.332 (Claude Code)\\n"); process.exit(0); }
if (argv[0] === "mcp" && argv[1] === "get") {
  const out = read(name + ".get");
  if (out === null) { process.stderr.write("No MCP server found with name: " + argv[2] + "\\n"); process.exit(1); }
  process.stdout.write(out); process.exit(0);
}
const fail = read(name + ".fail-" + argv[1]);
if (fail !== null) { process.stderr.write(fail); process.exit(1); }
process.exit(0);
`;

let dir: string;
let prevPath: string | undefined;
const CLI = "/repo/packages/bridge/dist/cli.js";

function stub(name: string) {
  const p = join(dir, name);
  writeFileSync(p, STUB);
  chmodSync(p, 0o755);
}
const calls = (): string[][] => {
  try {
    return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const writes = () => calls().filter((c) => c[2] === "add" || c[2] === "remove");
const claudeGet = (cmd: string, args: string, scope = "User config (available in all your projects)", env = "") =>
  writeFileSync(join(dir, "claude.get"), `tabagent:\n  Scope: ${scope}\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${cmd}\n  Args: ${args}\n  Environment:\n${env}\nTo remove this server, run: claude mcp remove tabagent -s user\n`);
const run = (argv: string[], cliPath = CLI) => {
  const { f, rest } = parseFlags(argv);
  return setupCommand(rest, f, { cliPath, isCheckout: (p) => p === CLI });
};
const text = (o: { out: string[]; err: string[] }) => [...o.out, ...o.err].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabagent-setup-"));
  prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  stub("claude");
});
afterEach(() => {
  process.env.PATH = prevPath;
});

describe("tabagent setup claude", () => {
  it("reports an old global install, then rewrites it to npx @latest in user scope, keeping the profile", async () => {
    stub("tabagent");
    writeFileSync(join(dir, "tabagent.version"), "0.1.0\n");
    claudeGet(join(dir, "tabagent"), "mcp --profile core,auth");
    const o = await run(["claude"]);
    expect(o.code).toBe(0);
    const t = text(o);
    expect(t).toContain("Found the tabagent MCP server in Claude Code (user scope)");
    expect(t).toContain(`Command: ${join(dir, "tabagent")} mcp --profile core,auth`);
    expect(t).toMatch(/Version: 0\.1\.0 .*too old to link/);
    expect(calls()).toContainEqual(["tabagent", "--version"]);
    expect(writes()).toEqual([
      ["claude", "mcp", "remove", "tabagent", "-s", "user"],
      ["claude", "mcp", "add", "tabagent", "-s", "user", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp", "--profile", "core,auth"],
    ]);
    expect(t).toContain("$ claude mcp add tabagent -s user -- npx -y @nolmak/tabagent@latest mcp --profile core,auth");
    expect(t).toContain("Restart each Claude Code session");
    expect(t).toContain("claude --dangerously-load-development-channels server:tabagent");
    expect(t).toContain("alias claude-tab='claude --dangerously-load-development-channels server:tabagent'");
    expect(t).toContain("local development");
    expect(t).toContain("next browser action");
    expect(t).toContain("--remote-control");
  });

  it("adds a fresh entry when none exists", async () => {
    const o = await run(["claude"]);
    expect(o.code).toBe(0);
    expect(text(o)).toContain("No tabagent MCP server in Claude Code yet");
    expect(writes()).toEqual([["claude", "mcp", "add", "tabagent", "-s", "user", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp"]]);
  });

  it("--profile overrides the existing one; other args and env are kept", async () => {
    claudeGet("npx", "-y @nolmak/tabagent mcp --profile=core --label work", "Local config (private to you in this project)", "    TABAGENT_CHANNEL_NAME=tabagent\n    TABAGENT_TOKEN=tok_secret\n");
    const o = await run(["claude", "--profile", "core,forms"]);
    expect(o.code).toBe(0);
    const t = text(o);
    expect(t).toContain("(local scope)");
    expect(t).toMatch(/Version: unpinned/);
    expect(writes()).toEqual([
      ["claude", "mcp", "remove", "tabagent", "-s", "local"],
      ["claude", "mcp", "add", "tabagent", "-s", "user", "-e", "TABAGENT_CHANNEL_NAME=tabagent", "-e", "TABAGENT_TOKEN=tok_secret", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp", "--label", "work", "--profile", "core,forms"],
    ]);
    // secrets never printed
    expect(t).not.toContain("tok_secret");
    expect(t).toContain("TABAGENT_TOKEN=***");
  });

  it("--scope project writes there", async () => {
    await run(["claude", "--scope", "project"]);
    expect(writes()).toEqual([["claude", "mcp", "add", "tabagent", "-s", "project", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp"]]);
  });

  it("leaves a project-scoped entry alone when writing user scope, and says it still wins there", async () => {
    claudeGet("npx", "-y @nolmak/tabagent mcp", "Project config (shared via .mcp.json)");
    const o = await run(["claude"]);
    expect(writes()).toEqual([["claude", "mcp", "add", "tabagent", "-s", "user", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp"]]);
    expect(text(o)).toMatch(/\.mcp\.json.*still/);
  });

  it("does nothing when already up to date", async () => {
    claudeGet("npx", "-y @nolmak/tabagent@latest mcp --profile core,auth");
    const o = await run(["claude"]);
    expect(o.code).toBe(0);
    expect(text(o)).toContain("Already up to date");
    expect(writes()).toEqual([]);
    expect(text(o)).toContain("Restart each Claude Code session");
  });

  it("--local points at this checkout's dist/cli.js", async () => {
    claudeGet("npx", "-y @nolmak/tabagent mcp --profile core,auth");
    const o = await run(["claude", "--local"]);
    expect(o.code).toBe(0);
    expect(writes()[1]).toEqual(["claude", "mcp", "add", "tabagent", "-s", "user", "--", "node", CLI, "mcp", "--profile", "core,auth"]);
  });

  it("--local refuses outside a git checkout", async () => {
    const o = await run(["claude", "--local"], "/usr/lib/node_modules/@nolmak/tabagent/dist/cli.js");
    expect(o.code).toBe(1);
    expect(text(o)).toContain("--local needs a TabAgent git checkout");
    expect(writes()).toEqual([]);
  });

  it("reports the version of a --local style entry by running node <cli> --version", async () => {
    stub("node-stub");
    writeFileSync(join(dir, "node-stub.version"), "0.2.0\n");
    claudeGet(join(dir, "node-stub"), "/x/cli.js mcp");
    const o = await run(["claude", "--dry-run"]);
    expect(calls()).toContainEqual(["node-stub", "/x/cli.js", "--version"]);
    expect(text(o)).toContain("Version: 0.2.0");
    expect(text(o)).not.toContain("too old");
  });

  it("replaces an HTTP entry with the stdio proxy", async () => {
    writeFileSync(join(dir, "claude.get"), "tabagent:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: http://127.0.0.1:47615/mcp\n");
    const o = await run(["claude"]);
    expect(text(o)).toContain("Version: n/a (http server)");
    expect(writes()[1]).toEqual(["claude", "mcp", "add", "tabagent", "-s", "user", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp"]);
  });

  it("--dry-run prints the commands and runs nothing", async () => {
    claudeGet("npx", "-y @nolmak/tabagent mcp --profile core,auth");
    const o = await run(["claude", "--dry-run"]);
    expect(o.code).toBe(0);
    const t = text(o);
    expect(t).toContain("Dry run");
    expect(t).toContain("$ claude mcp remove tabagent -s user");
    expect(t).toContain("$ claude mcp add tabagent -s user -- npx -y @nolmak/tabagent@latest mcp --profile core,auth");
    expect(writes()).toEqual([]);
  });

  it("--channels checks the Claude Code version and prints a line for the shell rc file", async () => {
    writeFileSync(join(dir, "claude.version"), "2.1.100 (Claude Code)\n");
    const o = await run(["claude", "--channels", "--dry-run"]);
    const t = text(o);
    expect(t).toMatch(/Claude Code 2\.1\.100 .*2\.1\.332/);
    expect(t).toMatch(/>> ~\/\.(zshrc|bashrc|profile)/);
  });

  it("fails with a hint when claude is not installed", async () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "tabagent-empty-"));
    const o = await run(["claude"]);
    expect(o.code).toBe(1);
    expect(text(o)).toContain("Claude Code (`claude`) is not on your PATH");
    expect(text(o)).toContain("claude mcp add tabagent -s user -- npx -y @nolmak/tabagent@latest mcp");
  });

  it("fails clearly when claude mcp add fails", async () => {
    writeFileSync(join(dir, "claude.fail-add"), "boom\n");
    const o = await run(["claude"]);
    expect(o.code).toBe(1);
    expect(text(o)).toContain("boom");
  });

  it("rejects a bad scope and an unknown agent", async () => {
    expect((await run(["claude", "--scope", "global"])).err.join()).toContain("--scope must be user, project or local");
    const u = await run(["cursor"]);
    expect(u.code).toBe(1);
    expect(u.err.join()).toContain("Usage: tabagent setup claude");
  });
});

describe("tabagent setup codex", () => {
  beforeEach(() => stub("codex"));
  const codexGet = (command: string, args: string[], env: Record<string, string> | null = null) =>
    writeFileSync(join(dir, "codex.get"), JSON.stringify({ name: "tabagent", enabled: true, transport: { type: "stdio", command, args, env } }));

  it("rewrites an existing entry, keeping profile and env", async () => {
    codexGet("tabagent", ["mcp", "--profile", "core,auth"], { TABAGENT_CHANNEL_NAME: "tabagent" });
    const o = await run(["codex"]);
    expect(o.code).toBe(0);
    expect(calls()).toContainEqual(["codex", "mcp", "get", "tabagent", "--json"]);
    expect(writes()).toEqual([
      ["codex", "mcp", "remove", "tabagent"],
      ["codex", "mcp", "add", "tabagent", "--env", "TABAGENT_CHANNEL_NAME=tabagent", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp", "--profile", "core,auth"],
    ]);
    expect(text(o)).toContain("Restart each Codex session");
  });

  it("adds a fresh entry and ignores --scope with a note", async () => {
    const o = await run(["codex", "--scope", "project"]);
    expect(writes()).toEqual([["codex", "mcp", "add", "tabagent", "--", "npx", "-y", "@nolmak/tabagent@latest", "mcp"]]);
    expect(text(o)).toContain("Codex has no scopes");
  });

  it("fails with a hint when codex is not installed", async () => {
    mkdirSync(join(dir, "empty"));
    process.env.PATH = join(dir, "empty");
    const o = await run(["codex"]);
    expect(o.code).toBe(1);
    expect(text(o)).toContain("Codex (`codex`) is not on your PATH");
  });
});

describe("shellQuote", () => {
  it("quotes only when needed", () => {
    expect(shellQuote(["a", "b c", "it's", "x=y", "--p"])).toBe(`a 'b c' 'it'\\''s' x=y --p`);
  });
});

describe("parsers", () => {
  it("reads real `claude mcp get` output (Claude Code 2.1.332)", () => {
    const real = `tabagent:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: /home/u/.nvm/versions/node/v22.23.4/bin/tabagent
  Args: mcp --profile core,auth
  Environment:

To remove this server, run: claude mcp remove tabagent -s user
`;
    expect(parseClaudeGet(real)).toEqual({ scope: "user", type: "stdio", command: "/home/u/.nvm/versions/node/v22.23.4/bin/tabagent", args: ["mcp", "--profile", "core,auth"], env: [] });
  });
  it("reads an http entry and rejects junk", () => {
    expect(parseClaudeGet("tabagent:\n  Scope: Local config\n  Type: http\n  URL: http://127.0.0.1:47615/mcp\n")).toMatchObject({ scope: "local", type: "http", command: "http://127.0.0.1:47615/mcp" });
    expect(parseClaudeGet("nothing here")).toBeNull();
    expect(parseCodexGet("not json")).toBeNull();
  });
});
