// Synchronous CLI commands as plain functions returning their output, so they are unit-tested in-process.
// cli.ts prints the Out and sets the exit code.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { answerLabel, PROFILES, TabAgentError, toolsForProfiles, type MirroredPrompt, type OutputResponse, type PromptAnswer, type SettingsSnapshot } from "@tabagent/protocol";
import type { Flags } from "./args";
import { auditPath, configPath, loadConfig, saveConfig } from "./config";
import { renderCli } from "./format";
import { handoffTimeoutMs, validateWebhookUrl, writeHandoffConfig } from "./handoff/config";
import { installSkill, skillTargets, uninstallSkill } from "./skill";
import { createToken, parseSites, revokeToken, setAutoCaptcha } from "./tokens";
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

export function tokenCommand(rest: string[], f: Flags): Out {
  const cfg = loadConfig();
  const sub = rest[0];
  try {
    if (sub === "create") {
      const name = String(f.name ?? rest[1] ?? "");
      const cap = String(f.caps ?? f.cap ?? "act");
      const sites = parseSites(typeof f.sites === "string" ? f.sites : undefined);
      const autoCaptcha = f["auto-captcha"] === true || f["auto-captcha"] === "on";
      const tok = createToken(cfg, name, cap, sites, new Date(), { autoCaptcha });
      saveConfig(cfg);
      return ok([tok], [`Created token "${name}" (caps=${cap}${sites.length ? `, sites=${sites.join(",")}` : ""}${autoCaptcha ? ", auto-captcha" : ""}). It is shown once.`, "Use it as: TABAGENT_TOKEN=<token> tabagent mcp   or   Authorization: Bearer <token>"]);
    }
    if (sub === "list") {
      if (!cfg.tokens.length) return ok(["No tokens."]);
      return ok(cfg.tokens.map((t) => `${t.name.padEnd(20)} caps=${t.cap.padEnd(5)} sites=${t.sites.join(",") || "*"}  created ${t.created}${t.autoCaptcha ? "  auto-captcha" : ""}`));
    }
    if (sub === "auto-captcha") {
      const name = String(rest[1] ?? f.name ?? "");
      const v = rest[2];
      if (v !== "on" && v !== "off") return fail("Usage: tabagent token auto-captcha <name> on|off");
      if (!setAutoCaptcha(cfg, name, v === "on")) return fail(`No token named ${name}`);
      saveConfig(cfg);
      return ok([`auto-captcha ${v} for ${name}: act.click and form.submit ${v === "on" ? "solve a blocking CAPTCHA with the bridge's solver (see `tabagent captcha status`)" : "leave CAPTCHAs to captcha.solve"}. Applies on the next call.`]);
    }
    if (sub === "revoke") {
      const name = String(rest[1] ?? f.name ?? "");
      if (!revokeToken(cfg, name)) return fail(`No token named ${name}`);
      saveConfig(cfg);
      return ok([`Revoked ${name}. The running bridge picks this up on its next request.`]);
    }
  } catch (e) {
    return fail(e instanceof TabAgentError ? e.message : String(e));
  }
  return fail("Usage: tabagent token create --name <n> [--caps read|act|full] [--sites a.com,*.b.com] [--auto-captcha] | list | revoke <name> | auto-captcha <name> on|off");
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

export function auditTail(n: number): Out {
  const p = auditPath();
  if (!existsSync(p)) return ok(["No audit log yet."]);
  return ok(readFileSync(p, "utf8").trim().split("\n").filter(Boolean).slice(-n).map(formatAuditLine));
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

const HANDOFF_USAGE = "Usage: tabagent config handoff.remote on|off | handoff.webhook <url>|off | handoff.timeoutMin <1-120>|default";

/** #61: `tabagent config handoff.*`. A running bridge reads these on the next handoff. */
export function handoffConfigCommand(key: string, value: string | undefined): Out {
  const port = loadConfig().port; // also creates config.json with its defaults when missing
  try {
    if (key === "handoff.remote") {
      if (value !== "on" && value !== "off") return fail(HANDOFF_USAGE);
      const h = writeHandoffConfig((c) => ({ ...c, remote: value === "on" }));
      return ok([
        `Remote handoff ${h.remote ? "on" : "off"}.`,
        ...(h.remote
          ? ["During auth.handoff the bridge serves a one-time phone page on this machine's Tailscale address only (port " + port + "), and closes it when the handoff ends.", `Handoff timeout: ${handoffTimeoutMs(h) / 60_000} min.`]
          : []),
      ]);
    }
    if (key === "handoff.webhook") {
      if (!value) return fail(HANDOFF_USAGE);
      const url = value === "off" ? null : validateWebhookUrl(value);
      writeHandoffConfig((c) => ({ ...c, webhook: url }));
      return ok([url ? "Handoff webhook set. It receives {event, origin, reason, url, expiresAt, session} when a handoff starts; the url is a live one-time link." : "Handoff webhook off."]);
    }
    if (key === "handoff.timeoutMin") {
      if (value === "default") {
        const h = writeHandoffConfig((c) => ({ ...c, timeoutMin: null }));
        return ok([`Handoff timeout: default (${handoffTimeoutMs(h) / 60_000} min).`]);
      }
      const n = Number(value);
      if (!value || !Number.isInteger(n) || n < 1 || n > 120) return fail(HANDOFF_USAGE);
      writeHandoffConfig((c) => ({ ...c, timeoutMin: n }));
      return ok([`Handoff timeout: ${n} min.`]);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
  return fail(HANDOFF_USAGE);
}

export function configCommand(rest: string[]): Out {
  if (rest[0]?.startsWith("handoff.")) return handoffConfigCommand(rest[0], rest[1]);
  const cfg = loadConfig();
  const [sub, a, b] = rest;
  if (sub === "show" || !sub) {
    const { secret, tokens, ...safe } = cfg;
    return ok([JSON.stringify({ ...safe, secret: secret ? "(set)" : null, tokens: tokens.map((t) => t.name), path: configPath() }, null, 2)]);
  }
  if (sub === "add-upload-dir" && a) {
    cfg.uploadDirs = [...new Set([...cfg.uploadDirs, resolve(a)])];
    saveConfig(cfg);
    return ok([`Upload dirs: ${cfg.uploadDirs.join(", ")}`]);
  }
  if (sub === "set" && a === "port" && b && Number.isInteger(Number(b))) {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    raw.port = Number(b);
    writeFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 });
    return ok([`Port set to ${b}. Also set it in the extension side panel when pairing.`]);
  }
  return fail("Usage: tabagent config [show] | add-upload-dir <dir> | set port <n>");
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

/** Runs one tool through the bridge (cli.ts passes a REST call; tests pass a fake). */
export type ToolCall = (tool: string, params: Record<string, unknown>) => Promise<OutputResponse>;

const errorOut = (resp: OutputResponse): Out => fail(`${resp.error!.code}: ${resp.error!.message}${resp.error!.hint ? `\nHint: ${resp.error!.hint}` : ""}`);
const onOff = (b: boolean) => (b ? "on" : "off");
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");

export function formatSettings(s: SettingsSnapshot): string[] {
  const origins = Object.keys(s.sites).sort();
  const width = Math.max(0, ...origins.map((o) => o.length));
  const sites = origins.map((o) => {
    const e = s.sites[o];
    const parts = [o.padEnd(width), e.policy.padEnd(4), `sign-in ${onOff(e.auth)}`, `lite ${onOff(e.lite)}`];
    if (e.preapproved?.length) parts.push(`pre-approved ${e.preapproved.join(",")}`);
    if (e.alwaysAccounts) parts.push(`${e.alwaysAccounts} account${e.alwaysAccounts === 1 ? "" : "s"} always`);
    return `  ${parts.join("  ")}`;
  });
  return [
    `Denylist (${s.denylist.length}): ${list(s.denylist)}`,
    ...(sites.length ? ["Sites:", ...sites] : ["Sites: (none saved)"]),
    `YOLO: ${onOff(s.yolo)}`,
    `Developer mode (devAllowSensitive): ${onOff(s.devAllowSensitive)}`,
    `On session end: ${s.onSessionEnd}`,
    `beforeunload dialogs: ${s.beforeUnload}`,
    `On-page border: ${onOff(s.showOverlay)}`,
    `Lite mode everywhere: ${onOff(s.forceLite)}`,
    `Lite sites: ${list(s.liteSites)}`,
    `Never signs in: ${list(s.authDenyHosts)}`,
    `Never reachable: ${list(s.vaultDenyHosts)}`,
  ];
}

/** #105: `tabagent settings show [--json]`, through the settings.get tool. */
export async function settingsCommand(rest: string[], f: Flags, call: ToolCall): Promise<Out> {
  if (rest[0] !== undefined && rest[0] !== "show") return fail(`Usage: tabagent settings show [--json]   (change preferences with \`tabagent settings.change --json '{"changes":{...}}'\`)`);
  const resp = await call("settings.get", {});
  if (!resp.ok) return errorOut(resp);
  const snap = resp.result as SettingsSnapshot;
  return ok(f.json ? [JSON.stringify(snap, null, 2)] : formatSettings(snap));
}

/** #106: `tabagent kill`, through session.kill_all. Works without a session; resuming is panel-only. */
export async function killCommand(call: ToolCall): Promise<Out> {
  const resp = await call("session.kill_all", {});
  if (!resp.ok) return errorOut(resp);
  const already = (resp.result as { alreadyPaused?: boolean } | undefined)?.alreadyPaused;
  return ok([already ? "Agents were already stopped." : "Stopped all agents.", "Only the user can resume: press Resume in the TabAgent side panel."]);
}

export function helpText(): string {
  return `tabagent v${BRIDGE_VERSION} — let AI agents drive your real Chrome

Usage:
  tabagent serve [--port N]            Run the bridge (prints a pairing code)
  tabagent mcp [--profile core,dev]    MCP stdio server; proxies to the bridge, starting one in the background if needed
  tabagent pair                        Mint a new pairing code on the running bridge
  tabagent status                      Bridge + extension status (and the pairing code when unpaired)
  tabagent tools [--profile P]         List tools (profiles: ${PROFILES.join(", ")})
  tabagent token create --name N [--caps read|act|full] [--sites a.com,*.b.com] [--auto-captcha]
  tabagent token list | revoke <name> | auto-captcha <name> on|off
  tabagent captcha enable [capsolver|2captcha|vision] [--fallback vision] [--base-url URL --model M]
  tabagent captcha disable [provider] | status [--check]   CAPTCHA solving (key read from stdin or env)
  tabagent audit tail [-n 50] [--follow]
  tabagent settings show [--json]      Denylist, site policies, YOLO and preferences (never secrets)
  tabagent kill                        Stop every agent now (resume only from the side panel)
  tabagent approve [<n> once|always|deny]   List or answer pending prompts with Touch ID (macOS)
  tabagent approve --phone [--ttl 60]  One-time phone page for prompts (Touch ID first; needs handoff.remote)
  tabagent setup claude [--scope user|project|local] [--profile P] [--channels] [--dry-run] [--local]
                                       Point Claude Code's tabagent MCP server at the latest TabAgent
  tabagent setup codex [--profile P] [--dry-run] [--local]   The same for Codex
  tabagent skill install [--claude] [--codex] [--force] | uninstall | print
  tabagent config [show] | add-upload-dir <dir> | set port <n>
  tabagent config auth.sms on|off      SMS/iMessage one-time codes for auth.code (macOS)
  tabagent config handoff.remote on|off        Phone page for auth.handoff on the Tailscale address
  tabagent config handoff.webhook <url>|off    POST a notice with the link when a handoff starts
  tabagent config handoff.timeoutMin <n>|default   Handoff wait (default 5 min; 30 with remote on)
  tabagent doctor                      Check sign-in prerequisites (Full Disk Access, op, bw)
  tabagent bitwarden enable|disable|login|unlock|lock|status
  tabagent <tool> --json '{...}' [--param value ...] [--session S] [--raw] [--out file.png]

Examples:
  tabagent setup claude --profile core,auth
  claude mcp add tabagent -- npx -y @nolmak/tabagent mcp
  codex mcp add tabagent -- npx -y @nolmak/tabagent mcp
  tabagent nav.goto --json '{"url":"https://example.com"}'
  tabagent page.snapshot
  tabagent act.click --ref e7
  tabagent page.screenshot --out shot.png`;
}

// ---------------------------------------------------------------------------
// #108: tabagent approve
// ---------------------------------------------------------------------------
export interface ApproveDeps {
  platform: NodeJS.Platform;
  /** Authenticated call to the running bridge (local owner). */
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  now?: () => number;
}

const CLI_ORDER: PromptAnswer[] = ["once", "always", "deny"];
const answersOf = (p: MirroredPrompt) => CLI_ORDER.filter((a) => p.answers.includes(a));
const NOT_MAC =
  "tabagent approve needs macOS: it confirms it is you with Touch ID or your login password (LocalAuthentication). On this system, answer in the TabAgent side panel, or open a one-time phone approval link from the side panel (Settings → Phone link for approvals; needs `tabagent config handoff.remote on`).";
const OUTCOME_TEXT: Record<string, string> = {
  expired: "The prompt expired before the answer arrived; nothing was applied.",
  not_found: "That prompt is no longer pending.",
  not_offered: "That answer is not offered for this prompt.",
  disabled: "Answering outside the side panel is off. Turn on “Answer prompts outside this panel” in the TabAgent side panel settings.",
  busy: "Another approval is in progress.",
  no_extension: "The TabAgent extension is not connected.",
};

function promptLines(p: MirroredPrompt, n: number, now: number): string[] {
  const left = Math.max(0, Math.round((p.expires - now) / 1000));
  return [
    `${n}. ${p.title}`,
    `   ${p.detail}`,
    ...(p.summary ? [`   ${p.summary}`] : []),
    ...p.reasons.map((r) => `   - ${r}`),
    `   Tool: ${p.tool} · ${left}s left · answers: ${answersOf(p).join(" | ")}${p.alwaysLabel && p.answers.includes("always") ? ` (always = “${p.alwaysLabel}”)` : ""}`,
  ];
}

/**
 * List pending prompts, or answer one. The bridge runs the presence check (Touch ID / password) itself
 * before it relays the answer; this command sends only {promptId, answer}, so no flag can skip it.
 */
export async function approveCommand(pos: string[], f: Flags, d: ApproveDeps): Promise<Out> {
  if (d.platform !== "darwin") return fail(NOT_MAC);
  const now = (d.now ?? Date.now)();
  if (f.phone) {
    const ttl = typeof f.ttl === "string" && Number.isFinite(Number(f.ttl)) ? Number(f.ttl) : undefined;
    const r = await d.api("/v1/approvals/phone", "POST", ttl === undefined ? {} : { ttlMin: ttl });
    if (!r?.ok) return fail(`No phone link: ${r?.error?.message ?? "the bridge refused"}${r?.error?.hint ? `\n${r.error.hint}` : ""}`);
    return ok([
      r.url,
      `One-time link: the first device to open it gets it. Valid until ${new Date(r.expiresAt).toLocaleTimeString()}, while outside approvals stay on.`,
      "Open it on your phone (on your tailnet). Anyone with this link can answer your prompts: do not paste it anywhere an agent can read.",
    ]);
  }
  const list = await d.api("/v1/approvals");
  if (!list?.ok) return fail(`Could not list prompts: ${list?.error?.message ?? "the bridge did not answer"}`);
  if (!list.enabled) return fail(OUTCOME_TEXT.disabled);
  const prompts = (list.prompts ?? []) as MirroredPrompt[];
  if (!pos.length) {
    if (!prompts.length) return ok(["No pending TabAgent prompts."]);
    const out = ["Pending TabAgent prompts:", ""];
    prompts.forEach((p, i) => out.push(...promptLines(p, i + 1, now), ""));
    out.push("Answer one (asks for Touch ID or your login password):", "  tabagent approve <number> once|always|deny");
    return ok(out);
  }
  const [which, answer] = pos;
  const p = /^\d+$/.test(which) ? prompts[Number(which) - 1] : prompts.find((x) => x.promptId === which);
  if (!p) return fail(`No pending prompt ${JSON.stringify(which)}. Run \`tabagent approve\` to list them.`);
  if (!(CLI_ORDER as string[]).includes(answer ?? "")) return fail("Usage: tabagent approve <number> once|always|deny");
  if (!p.answers.includes(answer as PromptAnswer)) return fail(`This prompt offers ${answersOf(p).join(" | ")}.`);
  const r = await d.api("/v1/approvals/answer", "POST", { promptId: p.promptId, answer });
  if (r?.ok) return ok([`${answerLabel(answer as PromptAnswer, p.alwaysLabel)}: ${p.title}`, "Confirmed with Touch ID or your password."]);
  if (r?.outcome === "already_answered") return fail(`Already answered${r.by ? ` (${r.by === "panel" ? "in the side panel" : r.by === "phone" ? "on the phone page" : "with tabagent approve"})` : ""}; nothing changed.`);
  return fail(r?.error?.message ?? OUTCOME_TEXT[r?.outcome] ?? "The answer was not applied.");
}
