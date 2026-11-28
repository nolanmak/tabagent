// tabagent CLI: serve | mcp | pair | status | tools | token | audit | settings | kill | approve | skill | config | setup | <tool>
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getTool, INBOX_EVENT_PATH, TIMEOUTS, toolsForProfiles, type OutputResponse } from "@tabagent/protocol";
import { parseFlags, toolParamsFromArgs, type Flags } from "./args";
import { api, ensureDaemon, health, restCall } from "./client";
import { auditPath, configPath, loadConfig } from "./config";
import { Daemon } from "./daemon";
import { buildMcpServer, channelPushHandler } from "./mcp";
import { findAgentPid, readPs } from "./agents/ancestry";
import { channelName, channelsFlag, readArgs } from "./agents/channels";
import { InboxClient } from "./inbox-client";
import { approveCommand, auditTail, configCommand, formatAuditLine, helpText, killCommand, settingsCommand, skillCommand, tokenCommand, toolOutput, toolsCommand, type Out, type ToolCall } from "./commands";
import { setupCommand } from "./setup";
import { BRIDGE_VERSION } from "./version";
import { authCli } from "./auth/cli-entry";
import { captchaCli } from "./captcha/cli-entry";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = fileURLToPath(import.meta.url);

function die(msg: string, code = 1): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function portOf(f: Flags) {
  const cfg = loadConfig();
  if (typeof f.port === "string") cfg.port = Number(f.port);
  return cfg;
}

// ---------------------------------------------------------------------------
async function cmdServe(f: Flags) {
  const cfg = portOf(f);
  const existing = await health(cfg.port);
  if (existing) die(`A TabAgent bridge (v${existing.bridgeVersion}) is already running on port ${cfg.port}.`);
  const d = new Daemon(cfg, { profile: typeof f.profile === "string" ? f.profile : undefined, log: (m) => console.log(`[tabagent] ${m}`) });
  try {
    await d.start();
  } catch (e) {
    die(`Could not listen on 127.0.0.1:${cfg.port}: ${(e as Error).message}`);
  }
  console.log(`TabAgent bridge v${BRIDGE_VERSION} on http://127.0.0.1:${d.port}  (MCP: /mcp, REST: /v1, config: ${configPath()})`);
  console.log(`\n  TabAgent pairing code: ${d.pairCode}   (valid ${TIMEOUTS.pairCode / 60_000} min; \`tabagent pair\` mints a new one)\n  Open the TabAgent side panel in Chrome and enter it. Port ${d.port}.\n`);
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function cmdMcp(f: Flags) {
  // D6: stdout carries MCP frames only. Anything else goes to stderr.
  console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  const log = (m: string) => process.stderr.write(`[tabagent] ${m}\n`);
  const cfg = portOf(f);
  const profile = typeof f.profile === "string" ? f.profile : (process.env.TABAGENT_PROFILE ?? "core");
  try {
    toolsForProfiles(profile);
  } catch (e) {
    die((e as Error).message);
  }
  const token = process.env.TABAGENT_TOKEN ?? cfg.secret;
  const sessionId = `${process.pid}-${randomBytes(3).toString("hex")}`;
  let client = typeof f.label === "string" ? f.label : "";
  // AD4: the agent process that owns this proxy (npx puts `npm exec` in between), and AD9: whether its argv
  // loads this server as a channel. Started now, alongside ensureDaemon; needed before the MCP server exists.
  const detected = findAgentPid(process.ppid, readPs)
    .catch(() => undefined)
    .then(async (pid) => ({ pid, channels: await channelsFlag(pid, readArgs, channelName(process.env)) }));

  const up = await ensureDaemon(cfg.port, CLI_PATH);
  if (!up.health) log(`could not start a bridge on port ${cfg.port}; see ${join(dirname(configPath()), "bridge.log")}`);
  else {
    if (up.spawned) log(`started a background bridge on 127.0.0.1:${cfg.port}`);
    const s = await api(cfg.port, token, "/v1/status").catch(() => null);
    if (s?.ok && !s.extension && s.pairCode) log(`TabAgent pairing code: ${s.pairCode}  (enter it in the TabAgent side panel; \`tabagent status\` shows it again)`);
  }

  const headers = () => ({ "x-tabagent-mcp": "1", "x-tabagent-session": sessionId, ...(client ? { "x-tabagent-client": client } : {}) });
  const call = async (tool: string, params: Record<string, unknown>): Promise<OutputResponse> => {
    let r = await restCall({ port: cfg.port, token, headers: headers() }, tool, params);
    if (!r.ok && r.error?.code === "NO_EXTENSION" && /Cannot reach/.test(r.error.message)) {
      // The daemon went away (crash, manual stop): bring one back and retry once.
      if ((await ensureDaemon(cfg.port, CLI_PATH)).health) r = await restCall({ port: cfg.port, token, headers: headers() }, tool, params);
    }
    return r;
  };
  // AD4/AD5: the agent inbox. Registered right after initialize; reconnects and re-registers on its own.
  const { pid, channels } = await detected;
  if (channels === "1") log("instant delivery: this agent loaded TabAgent as a channel (experimental)");
  // AD9: an ignored channel permission request is logged here and audited by the bridge.
  const onIgnored = (method: string) => {
    log(`ignored ${method}: TabAgent never relays channel permission prompts`);
    void fetch(`http://127.0.0.1:${cfg.port}${INBOX_EVENT_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers() },
      body: JSON.stringify({ event: "channel.permission_ignored", method: method.slice(0, 200) }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  };
  const server = buildMcpServer({
    call,
    profile,
    channels: channels === "1",
    onIgnored,
    onClientInfo: (name) => {
      if (!client && name) client = name.replace(/[^\w .-]/g, "").slice(0, 40);
      if (!ended) inbox.start();
    },
  });
  const inbox = new InboxClient({
    port: cfg.port,
    token,
    headers: () => ({
      ...headers(),
      ...(pid ? { "x-tabagent-agent-pid": String(pid) } : {}),
      "x-tabagent-channels": channels,
      "x-tabagent-profile": profile,
    }),
    ensureDaemon: () => ensureDaemon(cfg.port, CLI_PATH),
    // AD9: channel pushes become notifications/claude/channel; acked once written.
    onPush: channelPushHandler(server, channels === "1"),
    log,
  });
  const transport = new StdioServerTransport();
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    inbox.stop();
    try {
      await fetch(`http://127.0.0.1:${cfg.port}/v1/session/end`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers() }, body: "{}", signal: AbortSignal.timeout(1000) }).catch(() => {});
    } finally {
      setTimeout(() => process.exit(0), 50);
    }
  };
  transport.onclose = () => void end();
  process.stdin.on("end", () => void end());
  process.on("SIGTERM", () => void end());
  process.on("SIGINT", () => void end());
  await server.connect(transport);
}

async function cmdStatus(f: Flags) {
  const cfg = portOf(f);
  const h = await health(cfg.port);
  if (!h) {
    console.log(`Bridge: not running on port ${cfg.port}. Start it with \`tabagent serve\` (or let \`tabagent mcp\` start one).`);
    process.exit(1);
  }
  const s = await api(cfg.port, cfg.secret, "/v1/status");
  console.log(`Bridge: running v${s.bridgeVersion} (protocol ${s.protocolVersion}) on 127.0.0.1:${cfg.port}`);
  console.log(`Extension: ${s.extension ? `connected (v${s.extensionVersion})` : "NOT connected"}${s.paired ? "" : " — not paired yet"}`);
  if (!s.extension) console.log(s.pairCode ? `Pairing code: ${s.pairCode}  (enter it in the TabAgent side panel)` : "No valid pairing code; run `tabagent pair`.");
  console.log(`Sessions: ${s.mcpSessions} MCP-HTTP, ${s.restSessions} REST/stdio`);
}

async function cmdPair(f: Flags) {
  const cfg = portOf(f);
  if (!(await health(cfg.port))) die("Bridge is not running. Start it with `tabagent serve`.");
  const r = await api(cfg.port, cfg.secret, "/v1/pair", "POST");
  console.log(`Pairing code: ${r.pairCode}  (valid ${Math.round(r.expiresInSec / 60)} min)`);
}

async function cmdTools(f: Flags) {
  const profile = typeof f.profile === "string" ? f.profile : "full";
  if (f["mcp-json"]) {
    // Exactly what MCP tools/list returns for this profile (used by scripts/tool-budget.mjs).
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = buildMcpServer({ call: async () => ({ ok: true }), profile });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-budget", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    process.stdout.write(JSON.stringify(tools) + "\n");
    await client.close();
    return;
  }
  print(toolsCommand(profile));
}

function print(o: Out): void {
  for (const l of o.out) console.log(l);
  for (const l of o.err) process.stderr.write(l + "\n");
  if (o.code) process.exit(o.code);
}

function cmdAudit(rest: string[], f: Flags) {
  if (rest[0] !== "tail") die("Usage: tabagent audit tail [-n 50] [--follow]");
  print(auditTail(Number(f.n ?? 30)));
  const p = auditPath();
  if ((f.follow || f.f) && existsSync(p)) {
    let size = statSync(p).size;
    watchFile(p, { interval: 500 }, () => {
      const buf = readFileSync(p);
      if (buf.length < size) size = 0; // rotated
      const fresh = buf.subarray(size).toString("utf8");
      size = buf.length;
      for (const l of fresh.split("\n").filter(Boolean)) console.log(formatAuditLine(l));
    });
  }
}

export function skillSource(): string {
  for (const p of [join(HERE, "../skill/SKILL.md"), join(HERE, "../../skill/SKILL.md")]) if (existsSync(p)) return p;
  die("SKILL.md not found in the package");
}

async function cmdTool(name: string, args: string[]) {
  const tool = getTool(name);
  if (!tool) die(`Unknown command or tool "${name}". Run \`tabagent help\` or \`tabagent tools\`.`);
  const { f } = parseFlags(args);
  let params: Record<string, unknown>;
  try {
    params = toolParamsFromArgs(tool, f);
  } catch (e) {
    die(`BAD_REQUEST: ${(e as Error).message}`);
  }
  const cfg = portOf(f);
  if (!(await health(cfg.port))) die("NO_EXTENSION: Bridge is not running. Start it with `tabagent serve`.");
  const resp = await restCall(
    { port: cfg.port, token: process.env.TABAGENT_TOKEN ?? cfg.secret, headers: typeof f.session === "string" ? { "x-tabagent-session": f.session } : {} },
    tool.name,
    params,
  );
  print(toolOutput(resp, f));
}

/** A tool call through the running bridge, for subcommands built on tools (settings show, kill). */
async function bridgeCall(f: Flags): Promise<ToolCall> {
  const cfg = portOf(f);
  if (!(await health(cfg.port))) die("NO_EXTENSION: Bridge is not running. Start it with `tabagent serve`.");
  return (tool, params) => restCall({ port: cfg.port, token: process.env.TABAGENT_TOKEN ?? cfg.secret }, tool, params);
}

const [cmd, ...rest] = process.argv.slice(2);
const { f, rest: pos } = parseFlags(rest);
switch (cmd) {
  case "serve":
    await cmdServe(f);
    break;
  case "mcp":
    await cmdMcp(f);
    break;
  case "status":
    await cmdStatus(f);
    break;
  case "pair":
    await cmdPair(f);
    break;
  case "tools":
    await cmdTools(f);
    break;
  case "token":
    print(tokenCommand(pos, f));
    break;
  case "audit":
    cmdAudit(pos, f);
    break;
  case "settings":
    print(await settingsCommand(pos, f, await bridgeCall(f)));
    break;
  case "kill":
    print(await killCommand(await bridgeCall(f)));
    break;
  case "approve": {
    // #108: the bridge runs Touch ID itself; refuse up front off macOS, before talking to the bridge.
    if (process.platform !== "darwin") {
      print(await approveCommand(pos, f, { platform: process.platform, api: async () => ({}) }));
      break;
    }
    const cfg = portOf(f);
    if (!(await health(cfg.port))) die("Bridge is not running. Start it with `tabagent serve`.");
    print(await approveCommand(pos, f, { platform: process.platform, api: (path, method, body) => api(cfg.port, cfg.secret, path, method, body) }));
    break;
  }
  case "skill":
    print(skillCommand(pos, f, skillSource()));
    break;
  case "setup":
    print(await setupCommand(pos, f, { cliPath: CLI_PATH }));
    break;
  case "config":
    print(pos[0]?.startsWith("auth") ? await authCli.config(pos) : configCommand(pos));
    break;
  case "captcha":
    print(await captchaCli(pos, f));
    break;
  case "doctor":
  case "bitwarden":
    print(await authCli[cmd](pos, f, CLI_PATH));
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(helpText());
    break;
  case "--version":
  case "-v":
    console.log(BRIDGE_VERSION);
    break;
  default:
    await cmdTool(cmd, rest);
}
