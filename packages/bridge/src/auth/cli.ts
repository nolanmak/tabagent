// CLI commands for auth: `tabagent doctor`, `tabagent config auth.sms on|off`, `tabagent bitwarden …`.
// Plain functions returning their output (like commands.ts) with injectable deps so they are unit-tested.
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Out } from "../commands";
import { BitwardenProvider, MIN_BW_VERSION } from "./bitwarden";
import {
  bitwardenDataDir,
  readAuthConfig,
  writeAuthConfig,
  type AuthConfig,
} from "./config";
import { childBaseEnv, nodeRunner, versionAtLeast, type Runner } from "./exec";
import { ADMIN_BITWARDEN_SESSION } from "./index";
import { clearKeychainSync } from "./keychain";
import { OnePasswordProvider } from "./onepassword";
import { SmsSource, SMS_HINTS } from "./sms";

const ok = (out: string[] = [], err: string[] = []): Out => ({
  out,
  err,
  code: 0,
});
const fail = (msg: string, out: string[] = []): Out => ({
  out,
  err: [msg],
  code: 1,
});

// ---------------------------------------------------------------------------
// config auth.*
// ---------------------------------------------------------------------------

export const SMS_EXPLAIN = [
  "The SMS code source lets auth.code read one-time codes from Messages on this Mac.",
  "What it grants: the bridge opens ~/Library/Messages/chat.db read-only when an agent calls auth.code",
  "with source sms or auto, on a site you enabled for sign-in, and returns only one 4-8 digit code from",
  "the last 10 minutes. Message text and senders never leave the bridge and are never logged.",
  "It needs Full Disk Access for the app that starts the bridge; `tabagent doctor` checks it.",
];

export function authConfigCommand(rest: string[], path?: string): Out {
  const [key, value] = rest;
  if (key === "auth.sms") {
    if (value !== "on" && value !== "off")
      return fail("Usage: tabagent config auth.sms on|off", SMS_EXPLAIN);
    writeAuthConfig((a) => ({ ...a, sms: value === "on" }), path);
    return ok(
      value === "on"
        ? [
            ...SMS_EXPLAIN,
            "",
            "SMS codes: on. Run `tabagent doctor` to check access.",
          ]
        : ["SMS codes: off. The bridge will not open the Messages database."],
    );
  }
  if (key === "auth" || key === "auth.show") {
    const a = readAuthConfig(path);
    return ok([
      `providers: ${a.providers.join(", ") || "(none)"}`,
      `sms: ${a.sms ? "on" : "off"}`,
      `bitwarden: idle lock ${a.bitwarden.idleLockMinutes ? `${a.bitwarden.idleLockMinutes} min` : "never"}, max unlock ${a.bitwarden.maxUnlockHours ? `${a.bitwarden.maxUnlockHours} h` : "never"}${a.bitwarden.bin ? `, bin ${a.bitwarden.bin}` : ""}`,
    ]);
  }
  if (key === "auth.bitwarden.rememberUnlock") {
    if (value !== "on" && value !== "off")
      return fail(
        "Usage: tabagent config auth.bitwarden.rememberUnlock on|off",
      );
    writeAuthConfig(
      (c) => ({
        ...c,
        bitwarden: { ...c.bitwarden, rememberUnlock: value === "on" },
      }),
      path,
    );
    if (value === "off") clearKeychainSync();
    return ok(
      value === "on"
        ? [
            "auth.bitwarden.rememberUnlock = on (restart the bridge, then `tabagent bitwarden unlock` once)",
            "The session key is saved in your macOS login Keychain and restored on bridge restart or reboot. Any process running as you can read it. `tabagent bitwarden lock`, the kill switch, or turning this off deletes it.",
          ]
        : [
            "auth.bitwarden.rememberUnlock = off (saved session key deleted from the Keychain)",
          ],
    );
  }
  if (
    key === "auth.bitwarden.idleLockMinutes" ||
    key === "auth.bitwarden.maxUnlockHours"
  ) {
    const n = value === "never" || value === "off" ? 0 : Number(value);
    if (!Number.isFinite(n))
      return fail(`Usage: tabagent config ${key} <number>|never`);
    const field = key.split(".")[2] as "idleLockMinutes" | "maxUnlockHours";
    const a = writeAuthConfig(
      (c) => ({ ...c, bitwarden: { ...c.bitwarden, [field]: n } }),
      path,
    );
    const r = readAuthConfig(path);
    void a;
    const v = r.bitwarden[field];
    return ok([
      `${key} = ${v === 0 ? "never" : v} (restart the bridge to apply)`,
      ...(v === 0
        ? [
            "With this timer off, an unlocked vault stays open to every agent on this Mac until `tabagent bitwarden lock`, the kill switch, or a bridge restart.",
          ]
        : []),
    ]);
  }
  return fail(
    `Unknown auth setting "${key ?? ""}". Settings: auth.sms on|off, auth.bitwarden.idleLockMinutes <5-240|never>, auth.bitwarden.maxUnlockHours <1-24|never>, auth.bitwarden.rememberUnlock on|off`,
  );
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  sms?: SmsSource;
  onepassword?: OnePasswordProvider;
  bitwarden?: BitwardenProvider;
  config?: AuthConfig;
  /** Bridge health (port, reachable). */
  bridge?: () => Promise<{ port: number; up: boolean }>;
  /** The running bridge's Bitwarden state; the bridge holds the session, the CLI's copy is always locked. */
  bitwardenDaemon?: () => Promise<string | undefined>;
}

export async function doctorCommand(d: DoctorDeps = {}): Promise<Out> {
  const out: string[] = [];
  const line = (
    state: "ok" | "warn" | "FAIL" | "off",
    what: string,
    hint?: string,
  ) => {
    out.push(`[${state.padEnd(4)}] ${what}`);
    if (hint) out.push(`        ${hint}`);
  };
  const platform = d.platform ?? process.platform;
  const cfg = d.config ?? readAuthConfig();
  const nodeV = d.nodeVersion ?? process.versions.node;
  line(
    versionAtLeast(nodeV, "20.0.0") ? "ok" : "FAIL",
    `Node ${nodeV}`,
    versionAtLeast(nodeV, "22.5.0")
      ? undefined
      : "SMS codes need Node 22.5+ (node:sqlite) or better-sqlite3.",
  );
  line("ok", `Platform ${platform}`);
  if (d.bridge) {
    const b = await d.bridge();
    line(
      b.up ? "ok" : "warn",
      b.up
        ? `Bridge running on 127.0.0.1:${b.port}`
        : `Bridge not running on port ${b.port}`,
      b.up
        ? undefined
        : "Start it with `tabagent serve` (agents start it on demand).",
    );
  }
  // SMS / iMessage (#36)
  if (platform !== "darwin") line("off", "SMS codes: UNSUPPORTED (macOS only)");
  else {
    const probe = d.sms ?? new SmsSource({ enabled: () => true, platform });
    const st = probe.status();
    if (st.state === "available")
      line(
        "ok",
        "Messages database readable (Full Disk Access granted)",
        SMS_HINTS.forwarding,
      );
    else if (st.state === "missing")
      line("FAIL", "Messages database not found", SMS_HINTS.fda);
    else
      line(
        "FAIL",
        "Messages database not readable: Full Disk Access is missing",
        SMS_HINTS.fda,
      );
    line(
      cfg.sms ? "ok" : "off",
      `SMS code source ${cfg.sms ? "on" : "off"}`,
      cfg.sms ? undefined : "Turn on with `tabagent config auth.sms on`.",
    );
  }
  // 1Password (#33)
  const op = d.onepassword ?? new OnePasswordProvider();
  const ops = await op
    .status()
    .catch(() => ({
      name: "1password" as const,
      state: "missing" as const,
      hint: undefined,
    }));
  line(
    ops.state === "unlocked" ? "ok" : ops.state === "missing" ? "off" : "warn",
    `1Password CLI: ${ops.state === "unlocked" ? "installed, signed in" : ops.state}${cfg.providers.includes("1password") ? "" : " (not in auth.providers)"}`,
    ops.state === "unlocked" ? undefined : ops.hint,
  );
  // Bitwarden (#37)
  const bw =
    d.bitwarden ??
    new BitwardenProvider({
      bin: cfg.bitwarden.bin,
      dataDir: bitwardenDataDir(),
      enabled: () => cfg.providers.includes("bitwarden"),
    });
  const own = await bw
    .status()
    .catch(() => ({
      name: "bitwarden" as const,
      state: "missing" as const,
      hint: undefined,
    }));
  const daemon =
    own.state === "locked"
      ? await d.bitwardenDaemon?.().catch(() => undefined)
      : undefined;
  const bws =
    daemon === "unlocked"
      ? {
          name: "bitwarden" as const,
          state: "unlocked (bridge)" as const,
          hint: undefined,
        }
      : own;
  line(
    bws.state === "unlocked (bridge)" ||
      bws.state === "unlocked" ||
      bws.state === "locked"
      ? "ok"
      : bws.state === "disabled" || bws.state === "missing"
        ? "off"
        : "warn",
    `Bitwarden CLI: ${bws.state}`,
    bws.hint,
  );
  return ok(out);
}

// ---------------------------------------------------------------------------
// bitwarden enable|disable|login|unlock|lock|status (#37)
// ---------------------------------------------------------------------------

export interface BitwardenCliDeps {
  configPath?: string;
  dataDir?: string;
  isTTY?: boolean;
  runner?: Runner;
  /** Run `bw` attached to the terminal (stdin/stderr inherited). Returns exit code and captured stdout. */
  interactive?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number | null; stdout: string }>;
  /** Start the daemon the D6 way if needed; returns true when it answers. */
  ensureDaemon?: () => Promise<boolean>;
  /** Call the admin route with the bridge secret. */
  admin?: (
    method: "POST" | "DELETE" | "GET",
    body?: unknown,
  ) => Promise<{ status: number; body?: any }>;
  /** PATH for resolving `bw` (tests). */
  path?: string;
}

/** Resolve a command on PATH once (#37: the path is stored in config.json). */
export function resolveBin(
  name: string,
  pathEnv = process.env.PATH ?? "",
): string | null {
  if (isAbsolute(name)) return canExec(name) ? name : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (canExec(p)) return p;
  }
  return null;
}
function canExec(p: string) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultInteractive(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...childBaseEnv(), ...env },
    });
    const out: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8") }),
    );
  });
}

export async function bitwardenCommand(
  rest: string[],
  f: Record<string, string | boolean>,
  d: BitwardenCliDeps = {},
): Promise<Out> {
  const sub = rest[0];
  const cfg = readAuthConfig(d.configPath);
  const enabled = cfg.providers.includes("bitwarden");
  const dataDir = d.dataDir ?? bitwardenDataDir();
  const runner = d.runner ?? nodeRunner();
  const isTTY = d.isTTY ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  const bin = cfg.bitwarden.bin ?? "bw";
  const env = { BITWARDENCLI_APPDATA_DIR: dataDir };
  const bwRun = (args: string[], extra: Record<string, string> = {}) =>
    runner.run(bin, [...args, "--nointeraction", "--response"], {
      env: { ...env, ...extra },
    });

  switch (sub) {
    case "enable": {
      const found = resolveBin(
        typeof f.bin === "string" ? f.bin : "bw",
        d.path,
      );
      if (!found)
        return fail(
          "Bitwarden CLI (`bw`) not found on PATH. Install it (`brew install bitwarden-cli`) and run this again.",
        );
      const v = await runner
        .run(found, ["--version", "--nointeraction", "--response"], { env })
        .catch(() => null);
      const version = v?.stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (!version) return fail(`Could not read the version of ${found}.`);
      if (!versionAtLeast(version, MIN_BW_VERSION))
        return fail(
          `Bitwarden CLI ${version} is too old; TabAgent needs ${MIN_BW_VERSION} or later.`,
        );
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeAuthConfig(
        (a) => ({
          ...a,
          providers: [
            ...a.providers.filter((p) => p !== "bitwarden"),
            "bitwarden",
          ],
          bitwarden: { ...a.bitwarden, bin: found },
        }),
        d.configPath,
      );
      return ok([
        `Bitwarden provider enabled (${found}, v${version}).`,
        `TabAgent keeps its own Bitwarden CLI state in ${dataDir}; your own \`bw\` login is untouched.`,
        "Next: `tabagent bitwarden login`, then `tabagent bitwarden unlock`.",
        "",
        "Risk: while the vault is unlocked, any process running as your macOS user (including a shell-capable",
        "agent such as Claude Code or Codex) can obtain the session key and with it the vault. Use Bitwarden",
        "with TabAgent only for accounts you would let your agents reach. By default it locks after 30 idle minutes and 8 hours (`tabagent config auth.bitwarden.*`).",
      ]);
    }
    case "disable": {
      writeAuthConfig(
        (a) => ({
          ...a,
          providers: a.providers.filter((p) => p !== "bitwarden"),
        }),
        d.configPath,
      );
      await d.admin?.("DELETE").catch(() => null);
      await bwRun(["lock"]).catch(() => null);
      return ok(["Bitwarden provider disabled and locked."]);
    }
    case "login":
    case "unlock": {
      if (!enabled)
        return fail(
          "The Bitwarden provider is not enabled. Run `tabagent bitwarden enable` first.",
        );
      if (!isTTY)
        return fail(
          `\`tabagent bitwarden ${sub}\` must be run by you in a terminal (stdin is not a TTY). TabAgent never takes the master password from an agent.`,
        );
      const interactive = d.interactive ?? defaultInteractive;
      if (sub === "login") {
        if (typeof f.server === "string") {
          const r = await runner
            .run(
              bin,
              ["config", "server", f.server, "--nointeraction", "--response"],
              { env },
            )
            .catch(() => null);
          if (!r || r.code !== 0)
            return fail("Could not set the Bitwarden server.");
        }
        const r = await interactive(bin, ["login"], env);
        return r.code === 0
          ? ok(["Logged in. Now run `tabagent bitwarden unlock`."])
          : fail("Bitwarden login failed.");
      }
      // Already unlocked in the bridge: don't ask again (a new `bw unlock` would also replace that session).
      const cur = await d.admin?.("GET").catch(() => null);
      if (cur?.status === 200 && cur.body?.status?.state === "unlocked")
        return ok([
          "Bitwarden is already unlocked for TabAgent; nothing to do.",
        ]);
      // One unlock at a time: each `bw unlock` issues a new session key and invalidates the previous one.
      const lockPath = join(dataDir, "unlock.lock");
      const holder = existsSync(lockPath)
        ? Number(readFileSync(lockPath, "utf8").trim())
        : 0;
      if (holder && holder !== process.pid && pidAlive(holder))
        return fail(
          `Another \`tabagent bitwarden unlock\` is running (pid ${holder}). Finish it or press Ctrl-C there first; a second unlock would cancel the first.`,
        );
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
      try {
        const r = await interactive(bin, ["unlock", "--raw"], env);
        const key = r.stdout.trim();
        if (r.code !== 0 || !key)
          return fail("Bitwarden unlock failed or was cancelled.");
        const lockAndFail = async (msg: string) => {
          await bwRun(["lock"], { BW_SESSION: key }).catch(() => null);
          return fail(msg);
        };
        const st = await bwRun(["status"], { BW_SESSION: key }).catch(
          () => null,
        );
        let status: unknown;
        try {
          status = JSON.parse(st?.stdout ?? "")?.data?.template?.status;
        } catch {
          status = undefined;
        }
        if (status !== "unlocked")
          return lockAndFail(
            "Bitwarden did not accept the new session key; the vault was locked again.",
          );
        const up = await (d.ensureDaemon?.() ?? Promise.resolve(false));
        if (!up)
          return lockAndFail(
            "The TabAgent bridge is not running and could not be started; the vault was locked again.",
          );
        const res = await d.admin?.("POST", { key }).catch(() => null);
        if (!res || res.status !== 204)
          return lockAndFail(
            `The bridge refused the session (${res?.body?.error?.message ?? "no answer"}); the vault was locked again.`,
          );
        const restart = cfg.bitwarden.rememberUnlock
          ? "It stays unlocked across bridge restarts (saved in your Keychain)"
          : "It locks on a bridge restart";
        const timers = [
          cfg.bitwarden.idleLockMinutes
            ? `after ${cfg.bitwarden.idleLockMinutes} idle minutes`
            : "",
          cfg.bitwarden.maxUnlockHours
            ? `after ${cfg.bitwarden.maxUnlockHours} hours`
            : "",
        ].filter(Boolean);
        return ok([
          `Bitwarden unlocked for TabAgent. ${restart}; it locks ${timers.concat("on the kill switch, or with \`tabagent bitwarden lock\`").join(", ")}.`,
        ]);
      } finally {
        rmSync(lockPath, { force: true });
      }
    }
    case "lock": {
      await d.admin?.("DELETE").catch(() => null);
      await bwRun(["lock"]).catch(() => null);
      return ok(["Bitwarden locked."]);
    }
    case "status": {
      if (!enabled)
        return ok(["Bitwarden: disabled (run `tabagent bitwarden enable`)."]);
      const r = await d.admin?.("GET").catch(() => null);
      const daemonState = r?.status === 200 ? r.body?.status?.state : undefined;
      const st = await bwRun(["status"]).catch(() => null);
      let t: {
        status?: string;
        serverUrl?: string | null;
        lastSync?: string | null;
        userEmail?: string;
      } = {};
      try {
        t = JSON.parse(st?.stdout ?? "")?.data?.template ?? {};
      } catch {
        /* keep empty */
      }
      return ok([
        `Bitwarden for TabAgent: ${daemonState ?? (t.status === "unauthenticated" ? "logged-out" : "locked")}${daemonState ? "" : " (bridge not running)"}`,
        `  CLI: ${bin}`,
        `  data dir: ${dataDir}`,
        `  server: ${t.serverUrl ?? "bitwarden.com (default)"}`,
        `  account: ${t.userEmail ?? "-"}`,
        `  last sync: ${t.lastSync ?? "-"}`,
      ]);
    }
    default:
      return fail(
        "Usage: tabagent bitwarden enable [--bin path] | disable | login [--server URL] | unlock | lock | status",
      );
  }
}

/** True if a process with this pid exists (EPERM means it exists but isn't ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export { ADMIN_BITWARDEN_SESSION };
