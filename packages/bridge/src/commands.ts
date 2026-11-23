// Synchronous CLI commands as plain functions returning their output, so they are unit-tested in-process.
// cli.ts prints the Out and sets the exit code.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROFILES, toolsForProfiles, type OutputResponse } from "@tabagent/protocol";
import type { Flags } from "./args";
import { configPath, loadConfig } from "./config";
import { renderCli } from "./format";
import { installSkill, skillTargets, uninstallSkill } from "./skill";
import { BRIDGE_VERSION } from "./version";

export interface Out {
  out: string[];
  err: string[];
  code: number;
}
const ok = (out: string[] = [], err: string[] = []): Out => ({ out, err, code: 0 });
const fail = (msg: string, out: string[] = []): Out => ({ out, err: [msg], code: 1 });

export function toolsCommand(profile: string): Out {
  try {
    const list = toolsForProfiles(profile);
    return ok([...list.map((t) => `${t.name.padEnd(18)} ${t.sensitive ? "! " : "  "}${t.description}`), "", `${list.length} tools. Profiles: ${PROFILES.join(", ")} (core is always included).`]);
  } catch (e) {
    return fail((e as Error).message);
  }
}

export function skillCommand(rest: string[], f: Flags, src: string): Out {
  const sub = rest[0];
  if (sub === "print") return ok([readFileSync(src, "utf8")]);
  const targets = skillTargets({ claude: !!f.claude, codex: !!f.codex });
  const o = ok();
  if (sub === "install") {
    for (const r of installSkill(src, targets, !!f.force)) {
      if (r.action === "refused") {
        o.code = 1;
        o.err.push(`Refused: ${r.path} was edited locally. Re-run with --force to overwrite.`);
      } else o.out.push(`${r.action === "unchanged" ? "Up to date" : r.action === "updated" ? "Updated" : "Installed"} (${r.target.name}): ${r.path}`);
    }
    return o;
  }
  if (sub === "uninstall") {
    for (const r of uninstallSkill(targets, !!f.force)) {
      if (r.action === "refused") {
        o.code = 1;
        o.err.push(`Refused: ${r.target.dir}/SKILL.md was edited locally. Re-run with --force to remove it.`);
      } else o.out.push(`${r.action === "removed" ? "Removed" : "Not installed"} (${r.target.name}): ${r.target.dir}`);
    }
    return o;
  }
  return fail("Usage: tabagent skill install [--claude] [--codex] [--force] | uninstall [--claude] [--codex] [--force] | print");
}

export function configCommand(rest: string[]): Out {
  const cfg = loadConfig();
  const [sub, a, b] = rest;
  if (sub === "show" || !sub) {
    const { secret, ...safe } = cfg;
    return ok([JSON.stringify({ ...safe, secret: secret ? "(set)" : null, path: configPath() }, null, 2)]);
  }
  if (sub === "set" && a === "port" && b && Number.isInteger(Number(b))) {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    raw.port = Number(b);
    writeFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 });
    return ok([`Port set to ${b}. Also set it in the extension side panel when pairing.`]);
  }
  return fail("Usage: tabagent config [show] | set port <n>");
}

/** D30 CLI output for a tool response: screenshots are written to a file and the path printed. */
export function toolOutput(resp: OutputResponse, f: Flags, now = Date.now()): Out {
  if (!resp.ok) return fail(`${resp.error!.code}: ${resp.error!.message}${resp.error!.hint ? `\nHint: ${resp.error!.hint}` : ""}`);
  const r = resp.result as Record<string, any> | undefined;
  if (r && typeof r.dataBase64 === "string" && typeof r.mime === "string") {
    const sub = r.mime.split("/")[1] ?? "png";
    const ext = sub === "jpeg" ? "jpg" : sub;
    const out = typeof f.out === "string" ? resolve(f.out) : join(tmpdir(), `tabagent-${now}.${ext}`);
    writeFileSync(out, Buffer.from(r.dataBase64, "base64"));
    const { dataBase64: _drop, ...meta } = r;
    return ok([f.raw ? JSON.stringify({ ...resp, result: { ...meta, savedTo: out } }, null, 2) : out]);
  }
  return ok([f.raw ? JSON.stringify(resp, null, 2) : renderCli(resp)]);
}

export function helpText(): string {
  return `tabagent v${BRIDGE_VERSION} — let AI agents drive your real Chrome

Usage:
  tabagent serve [--port N]            Run the bridge (prints a pairing code)
  tabagent mcp [--profile core,dev]    MCP stdio server; proxies to the bridge, starting one in the background if needed
  tabagent pair                        Mint a new pairing code on the running bridge
  tabagent status                      Bridge + extension status (and the pairing code when unpaired)
  tabagent tools [--profile P]         List tools (profiles: ${PROFILES.join(", ")})
  tabagent skill install [--claude] [--codex] [--force] | uninstall | print
  tabagent config [show] | set port <n>
  tabagent <tool> --json '{...}' [--param value ...] [--session S] [--raw] [--out file.png]

Examples:
  claude mcp add tabagent -- npx tabagent mcp
  codex mcp add tabagent -- npx tabagent mcp
  tabagent nav.goto --json '{"url":"https://example.com"}'
  tabagent page.snapshot
  tabagent act.click --ref e7
  tabagent page.screenshot --out shot.png`;
}
