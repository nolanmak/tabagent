#!/usr/bin/env node
// Live agent acceptance check for #4 and #29. Opt-in, never part of CI: it spends real
// model tokens. Run after `npm run build`:
//
//   node scripts/live-agent-check.mjs [--agents claude,codex] [--max-turns 25] [--out results.json]
//
// Environment: the e2e harness (#22) gives Chromium with the unpacked extension, a bridge on a
// temp port and temp TABAGENT_HOME, and real pairing through the side panel. A newsletter
// fixture is served on a localhost origin that is pre-granted `act`; devAllowSensitive stays
// OFF, so every sensitive gate is live. If a gate does raise a prompt, the script answers it
// "once" in the real side panel (as a user would) and records it.
//
// Each agent gets only the TabAgent MCP server (`tabagent mcp`, default profile) and the
// TabAgent skill, then is told to sign up. Pass = the fixture server recorded the POST with the
// right email AND the transcript shows TabAgent tool calls.
//
// Isolation (the user's real config is never written):
//  - Claude Code: a temp CLAUDE_CONFIG_DIR loses the keychain login, so the default config dir
//    is used for auth only: --strict-mcp-config + an explicit --mcp-config (TabAgent only),
//    --setting-sources project (cwd is an empty temp dir, so no user hooks/plugins/settings),
//    --disable-slash-commands (no installed skills), --tools "" (no built-in tools), and the
//    SKILL.md passed with --append-system-prompt-file.
//  - Codex: a temp CODEX_HOME would need the auth file copied (and a token refresh there would
//    rotate the user's real refresh token), so CODEX_HOME stays default for auth only:
//    --ignore-user-config (no user MCP servers/plugins), --ignore-rules, --ephemeral, shell,
//    browser, computer-use, apps and plugin features disabled, the TabAgent server added with
//    -c mcp_servers.tabagent=..., and SKILL.md passed as developer_instructions.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarness } from "../bench/live-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/bridge/dist/cli.js");
const SKILL = join(ROOT, "packages/bridge/skill/SKILL.md");
const EMAIL = "live-check@example.com";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const AGENTS = opt("agents", "claude,codex").split(",").filter(Boolean);
const MAX_TURNS = Number(opt("max-turns", "25"));
const TIMEOUT_MS = Number(opt("timeout", "420")) * 1000;
const OUT = opt("out", null);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Weekly Fixture newsletter</title>
<h1>Weekly Fixture newsletter</h1>
<p>One email a week. No spam.</p>
<form method="post" action="/subscribe">
  <label for="email">Email address</label> <input id="email" name="email" type="email" required>
  <button type="submit">Subscribe</button>
</form>`;
const THANKS = `<!doctype html><meta charset="utf-8"><title>Subscribed</title><h1>Thanks, you're subscribed</h1>`;

function newsletterServer() {
  const submissions = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/subscribe") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        submissions.push({ at: new Date().toISOString(), fields: Object.fromEntries(new URLSearchParams(body)) });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(THANKS);
      });
      return;
    }
    if (u.pathname === "/" || u.pathname === "/newsletter") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "localhost", () => resolve({ server, submissions, origin: `http://localhost:${server.address().port}` })));
}

const version = (bin) => {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "not installed";
  }
};

// Nested runs must not think they are inside the calling Claude Code session.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

function run(bin, args, cwd, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGTERM"), TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e), ms: Date.now() - t0 });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - t0 });
    });
  });
}

const lines = (s) =>
  s
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

async function runClaude(task, home, dir) {
  const mcp = join(dir, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { tabagent: { command: process.execPath, args: [CLI, "mcp"], env: { TABAGENT_HOME: home } } } }));
  const args = ["-p", task, "--output-format", "stream-json", "--verbose", "--max-turns", String(MAX_TURNS), "--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "mcp__tabagent", "--tools", "", "--setting-sources", "project", "--disable-slash-commands", "--no-session-persistence", "--append-system-prompt-file", SKILL];
  const r = await run("claude", args, dir, cleanEnv());
  const ev = lines(r.out);
  const calls = [];
  let model = null;
  let final = null;
  for (const e of ev) {
    if (e.type === "system" && e.subtype === "init") model = e.model;
    if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") calls.push(c.name);
    if (e.type === "result") final = e.result ?? e.subtype;
  }
  return { r, calls, model, final };
}

async function runCodex(task, home, dir) {
  const skill = readFileSync(SKILL, "utf8");
  const toml = (s) => JSON.stringify(s); // TOML basic strings accept JSON string escapes
  const off = ["shell_tool", "unified_exec", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "apps", "plugins", "remote_plugin", "image_generation", "multi_agent", "hooks", "tool_suggest", "skill_mcp_dependency_install"];
  const args = [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", dir, "-s", "read-only",
    ...off.flatMap((f) => ["--disable", f]),
    "-c", 'approval_policy="never"',
    "-c", `mcp_servers.tabagent.command=${toml(process.execPath)}`,
    "-c", `mcp_servers.tabagent.args=[${toml(CLI)}, "mcp"]`,
    "-c", `mcp_servers.tabagent.env={TABAGENT_HOME=${toml(home)}}`,
    "-c", "mcp_servers.tabagent.tool_timeout_sec=150",
    "-c", 'mcp_servers.tabagent.default_tools_approval_mode="approve"',
    "-c", `developer_instructions=${toml(skill)}`,
    task,
  ];
  const r = await run("codex", args, dir, cleanEnv());
  const ev = lines(r.out);
  const calls = [];
  let final = null;
  for (const e of ev) {
    const it = e.item;
    if (e.type === "item.completed" && it?.type === "mcp_tool_call") calls.push(`${it.server}.${it.tool}${it.status && it.status !== "completed" ? ` (${it.status})` : ""}`);
    if (e.type === "item.completed" && it?.type === "agent_message") final = it.text;
  }
  return { r, calls, model: null, final };
}

function auditCount(home) {
  const p = join(home, "audit.jsonl");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
}

const Harness = await loadHarness();
const h = new Harness();
await h.start();
const fx = await newsletterServer();
const url = `${fx.origin}/newsletter`;
await h.setPolicies({ [fx.origin]: "act" }, { paused: false, devAllowSensitive: false });

// A user watching the side panel: approve any prompt once, and record it.
const prompts = [];
let watching = true;
const watcher = (async () => {
  while (watching) {
    try {
      for (const p of await h.pendingPrompts()) {
        if (prompts.some((x) => x.promptId === p.promptId)) continue;
        prompts.push(p);
        const panel = await h.openPanel();
        await panel.locator(`li[data-prompt-id="${p.promptId}"] button[data-a="once"]`).click({ timeout: 10000 });
        await panel.close();
      }
    } catch {
      /* the context may be closing */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
})();

const task = `Using the TabAgent tools, open ${url} and sign up for the newsletter with email ${EMAIL}, then report done.`;
const results = [];
try {
  for (const agent of AGENTS) {
    const before = fx.submissions.length;
    const auditBefore = auditCount(h.home) ?? 0;
    const promptsBefore = prompts.length;
    const dir = mkdtempSync(join(tmpdir(), `tabagent-live-${agent}-`));
    const bin = agent === "claude" ? "claude" : "codex";
    const res = agent === "claude" ? await runClaude(task, h.home, dir) : await runCodex(task, h.home, dir);
    writeFileSync(join(dir, "transcript.jsonl"), res.r.out);
    writeFileSync(join(dir, "stderr.txt"), res.r.err);
    const subs = fx.submissions.slice(before);
    const recorded = subs.some((s) => s.fields.email === EMAIL);
    const tabagentCalls = res.calls.filter((c) => c.startsWith("mcp__tabagent__") || c.startsWith("tabagent."));
    results.push({
      agent,
      version: version(bin),
      model: res.model,
      pass: recorded && tabagentCalls.length > 0,
      submissionRecorded: recorded,
      submissions: subs,
      tabagentToolCalls: tabagentCalls.length,
      otherToolCalls: res.calls.length - tabagentCalls.length,
      calls: res.calls,
      auditRecords: (auditCount(h.home) ?? 0) - auditBefore,
      promptsAnswered: prompts.slice(promptsBefore).map((p) => p.title ?? p.summary ?? p.promptId),
      wallSeconds: Math.round(res.r.ms / 1000),
      exitCode: res.r.code,
      final: res.final,
      stderrTail: res.r.err.slice(-600),
      transcript: join(dir, "transcript.jsonl"),
    });
  }
} finally {
  watching = false;
  await watcher;
  await h.stop();
  fx.server.close();
}

console.log(JSON.stringify(results, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log("\n| agent | CLI version | result | TabAgent tool calls | wall time |\n|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.agent} | ${r.version} | ${r.pass ? "pass" : "FAIL"} | ${r.tabagentToolCalls} | ${r.wallSeconds}s |`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
