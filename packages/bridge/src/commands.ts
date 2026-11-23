// Synchronous CLI commands as plain functions returning their output, so they are unit-tested in-process.
// cli.ts prints the Out and sets the exit code.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROFILES, toolsForProfiles, type OutputResponse } from "@tabagent/protocol";
import type { Flags } from "./args";
import { renderCli } from "./format";
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
  tabagent <tool> --json '{...}' [--param value ...] [--session S] [--raw]

Examples:
  claude mcp add tabagent -- npx tabagent mcp
  codex mcp add tabagent -- npx tabagent mcp
  tabagent tabs --action new
  tabagent nav.goto --json '{"url":"https://example.com"}'
  tabagent nav.back`;
}
