// tabagent CLI: serve | mcp | pair | status | tools | token | audit | skill | config | <tool>
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getTool, PROFILES, TabAgentError, toolsForProfiles, type OutputResponse } from "@tabagent/protocol";
import { parseFlags, toolParamsFromArgs, type Flags } from "./args";
import { api, ensureDaemon, health, restCall } from "./client";
import { auditPath, configPath, loadConfig, saveConfig } from "./config";
import { Daemon } from "./daemon";
import { renderCli } from "./format";
import { buildMcpServer } from "./mcp";
import { installSkill, skillTargets, uninstallSkill } from "./skill";
import { createToken, parseSites, revokeToken } from "./tokens";
import { BRIDGE_VERSION } from "./version";

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
  console.log(`\n  TabAgent pairing code: ${d.pairCode}   (valid 10 min; \`tabagent pair\` mints a new one)\n  Open the TabAgent side panel in Chrome and enter it. Port ${d.port}.\n`);
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
  const server = buildMcpServer({
    call,
    profile,
    onClientInfo: (name) => {
      if (!client && name) client = name.replace(/[^\w .-]/g, "").slice(0, 40);
    },
  });
  const transport = new StdioServerTransport();
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
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
  const list = toolsForProfiles(profile);
  for (const t of list) console.log(`${t.name.padEnd(18)} ${t.sensitive ? "! " : "  "}${t.description}`);
  console.log(`\n${list.length} tools. Profiles: ${PROFILES.join(", ")} (core is always included).`);
}

function cmdToken(rest: string[], f: Flags) {
  const cfg = loadConfig();
  const sub = rest[0];
  try {
    if (sub === "create") {
      const name = String(f.name ?? rest[1] ?? "");
      const cap = String(f.caps ?? f.cap ?? "act");
      const sites = parseSites(typeof f.sites === "string" ? f.sites : undefined);
      const tok = createToken(cfg, name, cap, sites);
      saveConfig(cfg);
      console.log(tok);
      process.stderr.write(`Created token "${name}" (caps=${cap}${sites.length ? `, sites=${sites.join(",")}` : ""}). It is shown once.\nUse it as: TABAGENT_TOKEN=<token> tabagent mcp   or   Authorization: Bearer <token>\n`);
    } else if (sub === "list") {
      if (!cfg.tokens.length) console.log("No tokens.");
      for (const t of cfg.tokens) console.log(`${t.name.padEnd(20)} caps=${t.cap.padEnd(5)} sites=${t.sites.join(",") || "*"}  created ${t.created}`);
    } else if (sub === "revoke") {
      const name = String(rest[1] ?? f.name ?? "");
      if (!revokeToken(cfg, name)) die(`No token named ${name}`);
      saveConfig(cfg);
      console.log(`Revoked ${name}. The running bridge picks this up on its next request.`);
    } else die("Usage: tabagent token create --name <n> [--caps read|act|full] [--sites a.com,*.b.com] | list | revoke <name>");
  } catch (e) {
    die(e instanceof TabAgentError ? e.message : String(e));
  }
}

export function formatAuditLine(l: string): string {
  try {
    const e = JSON.parse(l);
    if (e.event) return `${e.ts}  event ${e.event}${e.data ? " " + JSON.stringify(e.data).slice(0, 120) : ""}`;
    return `${e.ts}  ${String(e.caller).padEnd(14)} ${String(e.outcome).padEnd(6)} ${String(e.tool)}${e.action ? `(${e.action})` : ""}  ${e.origin ?? "-"}${e.errorCode ? `  ${e.errorCode}` : ""}${e.params !== undefined ? "  " + JSON.stringify(e.params).slice(0, 100) : ""}`;
  } catch {
    return l;
  }
}

function cmdAudit(rest: string[], f: Flags) {
  const p = auditPath();
  if (rest[0] !== "tail") die("Usage: tabagent audit tail [-n 50] [--follow]");
  if (!existsSync(p)) {
    console.log("No audit log yet.");
    return;
  }
  const n = Number(f.n ?? 30);
  const lines = readFileSync(p, "utf8").trim().split("\n");
  for (const l of lines.slice(-n)) console.log(formatAuditLine(l));
  if (f.follow || f.f) {
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

function cmdSkill(rest: string[], f: Flags) {
  const sub = rest[0];
  if (sub === "print") {
    process.stdout.write(readFileSync(skillSource(), "utf8"));
    return;
  }
  const targets = skillTargets({ claude: !!f.claude, codex: !!f.codex });
  if (sub === "install") {
    let refused = 0;
    for (const r of installSkill(skillSource(), targets, !!f.force)) {
      if (r.action === "refused") {
        refused++;
        process.stderr.write(`Refused: ${r.path} was edited locally. Re-run with --force to overwrite.\n`);
      } else console.log(`${r.action === "unchanged" ? "Up to date" : r.action === "updated" ? "Updated" : "Installed"} (${r.target.name}): ${r.path}`);
    }
    if (refused) process.exit(1);
  } else if (sub === "uninstall") {
    let refused = 0;
    for (const r of uninstallSkill(targets, !!f.force)) {
      if (r.action === "refused") {
        refused++;
        process.stderr.write(`Refused: ${r.target.dir}/SKILL.md was edited locally. Re-run with --force to remove it.\n`);
      } else console.log(`${r.action === "removed" ? "Removed" : "Not installed"} (${r.target.name}): ${r.target.dir}`);
    }
    if (refused) process.exit(1);
  } else die("Usage: tabagent skill install [--claude] [--codex] [--force] | uninstall [--claude] [--codex] [--force] | print");
}

function cmdConfig(rest: string[]) {
  const cfg = loadConfig();
  const [sub, a, b] = rest;
  if (sub === "show" || !sub) {
    const { secret, tokens, ...safe } = cfg;
    console.log(JSON.stringify({ ...safe, secret: secret ? "(set)" : null, tokens: tokens.map((t) => t.name), path: configPath() }, null, 2));
  } else if (sub === "add-upload-dir" && a) {
    cfg.uploadDirs = [...new Set([...cfg.uploadDirs, resolve(a)])];
    saveConfig(cfg);
    console.log(`Upload dirs: ${cfg.uploadDirs.join(", ")}`);
  } else if (sub === "set" && a === "port" && b) {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    raw.port = Number(b);
    writeFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 });
    console.log(`Port set to ${b}. Also set it in the extension side panel when pairing.`);
  } else die("Usage: tabagent config [show] | add-upload-dir <dir> | set port <n>");
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
  if (!resp.ok) die(`${resp.error!.code}: ${resp.error!.message}${resp.error!.hint ? `\nHint: ${resp.error!.hint}` : ""}`);
  const r = resp.result as Record<string, any> | undefined;
  // D30: screenshots go to a file; print its path.
  if (r && typeof r.dataBase64 === "string" && typeof r.mime === "string") {
    const ext = r.mime.split("/")[1] === "jpeg" ? "jpg" : (r.mime.split("/")[1] ?? "png");
    const out = typeof f.out === "string" ? resolve(f.out) : join(tmpdir(), `tabagent-${Date.now()}.${ext}`);
    writeFileSync(out, Buffer.from(r.dataBase64, "base64"));
    const { dataBase64, ...meta } = r;
    void dataBase64;
    if (f.raw) console.log(JSON.stringify({ ...resp, result: { ...meta, savedTo: out } }, null, 2));
    else console.log(out);
    return;
  }
  console.log(f.raw ? JSON.stringify(resp, null, 2) : renderCli(resp));
}

function help() {
  console.log(`tabagent v${BRIDGE_VERSION} — let AI agents drive your real Chrome

Usage:
  tabagent serve [--port N]            Run the bridge (prints a pairing code)
  tabagent mcp [--profile core,dev]    MCP stdio server; proxies to the bridge, starting one in the background if needed
  tabagent pair                        Mint a new pairing code on the running bridge
  tabagent status                      Bridge + extension status (and the pairing code when unpaired)
  tabagent tools [--profile P]         List tools (profiles: ${PROFILES.join(", ")})
  tabagent token create --name N [--caps read|act|full] [--sites a.com,*.b.com]
  tabagent token list | revoke <name>
  tabagent audit tail [-n 50] [--follow]
  tabagent skill install [--claude] [--codex] [--force] | uninstall | print
  tabagent config [show] | add-upload-dir <dir> | set port <n>
  tabagent <tool> --json '{...}' [--param value ...] [--session S] [--raw] [--out file.png]

Examples:
  claude mcp add tabagent -- npx tabagent mcp
  codex mcp add tabagent -- npx tabagent mcp
  tabagent nav.goto --json '{"url":"https://example.com"}'
  tabagent page.snapshot
  tabagent act.click --ref e7
  tabagent page.screenshot --out shot.png`);
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
    cmdToken(pos, f);
    break;
  case "audit":
    cmdAudit(pos, f);
    break;
  case "skill":
    cmdSkill(pos, f);
    break;
  case "config":
    cmdConfig(pos);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  case "--version":
  case "-v":
    console.log(BRIDGE_VERSION);
    break;
  default:
    await cmdTool(cmd, rest);
}
