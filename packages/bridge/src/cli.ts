// tabagent CLI: serve | mcp | pair | status | tools | token | audit | skill | config | <tool>
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, watchFile, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getTool, PROFILES, TabAgentError, toolsForProfiles, TOOLS, type Cap, type SessionMeta } from "@tabagent/protocol";
import { auditPath, configPath, hashToken, loadConfig, newToken, saveConfig } from "./config";
import { Daemon, type Dispatch } from "./daemon";
import { formatCli } from "./format";
import { buildMcpServer } from "./mcp";
import { BRIDGE_VERSION } from "./version";

const argv = process.argv.slice(2);

function flags(args: string[]) {
  const out: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) out[a.slice(2)] = args[++i];
      else out[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { f: out, rest };
}

function die(msg: string, code = 1): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

async function health(port: number): Promise<{ ok: boolean; extension: boolean; version: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    const j = (await r.json()) as any;
    return j?.name === "tabagent" ? j : null;
  } catch {
    return null;
  }
}

/** REST client for a running daemon. */
function restDispatch(port: number, token: string): Dispatch {
  return async (meta, tool, params) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/call/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-tabagent-session": meta.id, "x-tabagent-label": meta.label },
      body: JSON.stringify({ params }),
    }).catch((e) => {
      throw new TabAgentError("NO_EXTENSION", `Cannot reach the TabAgent bridge on port ${port}: ${e.message}`, "Start it with `tabagent serve`.");
    });
    const j = (await r.json().catch(() => null)) as any;
    if (!j) throw new TabAgentError("INTERNAL", `Bridge returned HTTP ${r.status}`);
    if (!j.ok) throw new TabAgentError(j.error?.code ?? "INTERNAL", j.error?.message ?? "error", j.error?.hint);
    return j.result;
  };
}

async function api(port: number, token: string, path: string, method = "GET", body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return (await r.json()) as any;
}

function printPairing(d: Daemon, log: (s: string) => void) {
  log(`\n  TabAgent pairing code: ${d.pairCode}   (valid 10 min)\n  Open the TabAgent side panel in Chrome and enter it. Port ${d.cfg.port}.\n`);
}

// ---------------------------------------------------------------------------
async function cmdServe(f: Record<string, string | boolean>) {
  const cfg = loadConfig();
  if (f.port) cfg.port = Number(f.port);
  const existing = await health(cfg.port);
  if (existing) die(`A TabAgent bridge is already running on port ${cfg.port} (extension ${existing.extension ? "connected" : "not connected"}).`);
  const d = new Daemon(cfg, { profile: typeof f.profile === "string" ? f.profile : undefined, log: (m) => console.log(`[tabagent] ${m}`) });
  try {
    await d.start();
  } catch (e) {
    die(`Could not listen on 127.0.0.1:${cfg.port}: ${(e as Error).message}`);
  }
  console.log(`TabAgent bridge v${BRIDGE_VERSION} on http://127.0.0.1:${cfg.port}  (MCP: /mcp, REST: /v1, config: ${configPath()})`);
  printPairing(d, console.log);
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function cmdMcp(f: Record<string, string | boolean>) {
  const log = (m: string) => process.stderr.write(`[tabagent] ${m}\n`);
  const cfg = loadConfig();
  if (f.port) cfg.port = Number(f.port);
  const profile = typeof f.profile === "string" ? f.profile : (process.env.TABAGENT_PROFILE ?? "core");
  try {
    toolsForProfiles(profile);
  } catch (e) {
    die((e as Error).message);
  }
  const envToken = process.env.TABAGENT_TOKEN;
  let dispatch: Dispatch;
  let daemon: Daemon | null = null;
  if (await health(cfg.port)) dispatch = restDispatch(cfg.port, envToken ?? cfg.secret);
  else {
    daemon = new Daemon(cfg, { log });
    try {
      await daemon.start();
      log(`started an in-process bridge on 127.0.0.1:${cfg.port} (run \`tabagent serve\` to share one bridge across agents)`);
      if (!daemon.extensionConnected) printPairing(daemon, log);
      dispatch = daemon.dispatch;
    } catch {
      daemon = null;
      dispatch = restDispatch(cfg.port, envToken ?? cfg.secret);
    }
  }
  const meta: SessionMeta = { id: `stdio-${process.pid}-${randomBytes(3).toString("hex")}`, label: typeof f.label === "string" ? f.label : "agent", cap: "full", sites: [] };
  const server = buildMcpServer({
    dispatch,
    meta: () => meta,
    profile,
    onClientInfo: (name) => {
      if (name && typeof f.label !== "string") meta.label = name.replace(/[^\w .-]/g, "").slice(0, 40) || "agent";
    },
  });
  const transport = new StdioServerTransport();
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    try {
      if (daemon) daemon.endSession(meta.id);
      else await api(cfg.port, envToken ?? cfg.secret, "/v1/session/end", "POST", { sessionId: meta.id }).catch(() => {});
    } finally {
      setTimeout(() => process.exit(0), 200);
    }
  };
  transport.onclose = () => void end();
  process.stdin.on("end", () => void end());
  process.on("SIGTERM", () => void end());
  process.on("SIGINT", () => void end());
  await server.connect(transport);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const h = await health(cfg.port);
  if (!h) {
    console.log(`Bridge: not running on port ${cfg.port}. Start it with \`tabagent serve\`.`);
    process.exit(1);
  }
  const s = await api(cfg.port, cfg.secret, "/v1/status");
  console.log(`Bridge: running v${s.version} on 127.0.0.1:${cfg.port}`);
  console.log(`Extension: ${s.extension ? `connected (v${s.extensionVersion})` : "NOT connected"}`);
  if (!s.extension) console.log(`Pairing code: ${s.pairCode}  (enter it in the TabAgent side panel)`);
  console.log(`Sessions: ${s.mcpSessions} MCP-HTTP, ${s.restSessions} REST/stdio`);
}

async function cmdPair() {
  const cfg = loadConfig();
  if (!(await health(cfg.port))) die("Bridge is not running. Start it with `tabagent serve` (it prints a pairing code).");
  const r = await api(cfg.port, cfg.secret, "/v1/pair", "POST");
  console.log(`Pairing code: ${r.pairCode}  (valid ${Math.round(r.expiresInSec / 60)} min)`);
}

function cmdTools(f: Record<string, string | boolean>) {
  const list = toolsForProfiles(typeof f.profile === "string" ? f.profile : "full");
  for (const t of list) console.log(`${t.name.padEnd(18)} ${t.sensitive ? "⚠ " : "  "}${t.description}`);
  console.log(`\n${list.length} tools. Profiles: ${PROFILES.join(", ")} (core is always included).`);
}

function cmdToken(rest: string[], f: Record<string, string | boolean>) {
  const cfg = loadConfig();
  const sub = rest[0];
  if (sub === "create") {
    const name = String(f.name ?? "");
    if (!/^[\w.-]{1,40}$/.test(name)) die("Usage: tabagent token create --name <name> [--cap read|act|full] [--sites '*.github.com,example.com']");
    const cap = String(f.cap ?? "act") as Cap;
    if (!["read", "act", "full"].includes(cap)) die("--cap must be read, act or full");
    const sites = typeof f.sites === "string" ? f.sites.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (cfg.tokens.some((t) => t.name === name)) die(`Token "${name}" exists. Revoke it first.`);
    const tok = newToken();
    cfg.tokens.push({ name, hash: hashToken(tok), cap, sites, created: new Date().toISOString() });
    saveConfig(cfg);
    console.log(tok);
    process.stderr.write(`Created token "${name}" (cap=${cap}${sites.length ? `, sites=${sites.join(",")}` : ""}). It is shown once.\nUse it as: TABAGENT_TOKEN=<token> tabagent mcp   or   Authorization: Bearer <token>\n`);
  } else if (sub === "list") {
    if (!cfg.tokens.length) console.log("No tokens.");
    for (const t of cfg.tokens) console.log(`${t.name.padEnd(20)} cap=${t.cap.padEnd(5)} sites=${t.sites.join(",") || "*"}  created ${t.created}`);
  } else if (sub === "revoke") {
    const name = rest[1] ?? f.name;
    const n = cfg.tokens.length;
    cfg.tokens = cfg.tokens.filter((t) => t.name !== name);
    if (cfg.tokens.length === n) die(`No token named ${name}`);
    saveConfig(cfg);
    console.log(`Revoked ${name}. Restart the bridge for it to take effect.`);
  } else die("Usage: tabagent token create|list|revoke");
}

function cmdAudit(rest: string[], f: Record<string, string | boolean>) {
  const p = auditPath();
  if (rest[0] !== "tail") die("Usage: tabagent audit tail [-n 50] [--follow]");
  if (!existsSync(p)) {
    console.log("No audit log yet.");
    return;
  }
  const n = Number(f.n ?? 30);
  const fmt = (l: string) => {
    try {
      const e = JSON.parse(l);
      return `${e.ts}  ${String(e.client).padEnd(14)} ${e.ok ? "ok " : "ERR"} ${String(e.tool).padEnd(16)} ${JSON.stringify(e.params).slice(0, 100)}${e.error ? `  ${e.error.code}: ${e.error.message}` : ""}`;
    } catch {
      return l;
    }
  };
  const lines = readFileSync(p, "utf8").trim().split("\n");
  for (const l of lines.slice(-n)) console.log(fmt(l));
  if (f.follow || f.f) {
    let size = statSync(p).size;
    watchFile(p, { interval: 500 }, () => {
      const buf = readFileSync(p);
      const fresh = buf.subarray(size).toString("utf8");
      size = buf.length;
      for (const l of fresh.split("\n").filter(Boolean)) console.log(fmt(l));
    });
  }
}

function skillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "../skill/SKILL.md"), join(here, "../../skill/SKILL.md")]) if (existsSync(p)) return p;
  die("SKILL.md not found in the package");
}

function cmdSkill(rest: string[], f: Record<string, string | boolean>) {
  if (rest[0] === "print") {
    process.stdout.write(readFileSync(skillSource(), "utf8"));
    return;
  }
  if (rest[0] !== "install") die("Usage: tabagent skill install [--claude] [--codex] [--dir <skills dir>] | tabagent skill print");
  const src = skillSource();
  const targets: string[] = [];
  const all = !f.claude && !f.codex && !f.dir;
  if (f.claude || all) targets.push(join(homedir(), ".claude", "skills", "tabagent"));
  if (f.codex || all) targets.push(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", "tabagent"));
  if (typeof f.dir === "string") targets.push(join(resolve(f.dir), "tabagent"));
  for (const t of targets) {
    mkdirSync(t, { recursive: true });
    copyFileSync(src, join(t, "SKILL.md"));
    console.log(`Installed skill -> ${join(t, "SKILL.md")}`);
  }
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

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function cmdTool(name: string, args: string[]) {
  const tool = getTool(name);
  if (!tool) die(`Unknown command or tool "${name}". Run \`tabagent help\` or \`tabagent tools\`.`);
  const { f } = flags(args);
  let params: Record<string, unknown> = {};
  if (typeof f.json === "string") params = JSON.parse(f.json);
  for (const [k, v] of Object.entries(f)) {
    if (["json", "raw", "out", "session", "label", "port"].includes(k)) continue;
    params[k] = typeof v === "string" ? (tool.params.shape[k] && String(tool.params.shape[k]._zod?.def?.type ?? "") === "string" ? v : parseValue(v)) : v;
  }
  const cfg = loadConfig();
  if (f.port) cfg.port = Number(f.port);
  if (!(await health(cfg.port))) die("Bridge is not running. Start it with `tabagent serve`.");
  const meta: SessionMeta = { id: typeof f.session === "string" ? f.session : "cli", label: typeof f.label === "string" ? f.label : "cli", cap: "full", sites: [] };
  try {
    const result = (await restDispatch(cfg.port, process.env.TABAGENT_TOKEN ?? cfg.secret)(meta, tool.name, params)) as any;
    if (result?.image?.data) {
      const out = typeof f.out === "string" ? f.out : join(tmpdir(), `tabagent-${Date.now()}.${result.image.mimeType.split("/")[1]}`);
      writeFileSync(out, Buffer.from(result.image.data, "base64"));
      result.image = undefined;
      result.savedTo = out;
    }
    console.log(f.raw ? JSON.stringify(result, null, 2) : formatCli(tool, result));
  } catch (e) {
    const err = e as TabAgentError;
    die(`${err.code ?? "ERROR"}: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`);
  }
}

function help() {
  console.log(`tabagent v${BRIDGE_VERSION} — let AI agents drive your real Chrome

Usage:
  tabagent serve [--port N]            Run the bridge (prints a pairing code)
  tabagent mcp [--profile core,dev]    MCP stdio server (proxies to a running bridge, or starts one)
  tabagent pair                        New pairing code from the running bridge
  tabagent status                      Bridge + extension status
  tabagent tools [--profile P]         List tools (profiles: ${PROFILES.join(", ")})
  tabagent token create --name N [--cap read|act|full] [--sites a.com,*.b.com]
  tabagent token list | revoke <name>
  tabagent audit tail [-n 50] [--follow]
  tabagent skill install [--claude] [--codex] [--dir D]
  tabagent config [show] | add-upload-dir <dir> | set port <n>
  tabagent <tool> [--param value ...] [--json '{...}'] [--raw] [--out file.png]

Examples:
  claude mcp add tabagent -- npx tabagent mcp
  codex mcp add tabagent -- npx tabagent mcp
  tabagent nav.goto --url https://example.com
  tabagent page.snapshot
  tabagent act.click --ref e7
  tabagent page.screenshot --out shot.png`);
}

const [cmd, ...rest] = argv;
const { f, rest: pos } = flags(rest);
switch (cmd) {
  case "serve":
    await cmdServe(f);
    break;
  case "mcp":
    await cmdMcp(f);
    break;
  case "status":
    await cmdStatus();
    break;
  case "pair":
    await cmdPair();
    break;
  case "tools":
    cmdTools(f);
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
void TOOLS;
