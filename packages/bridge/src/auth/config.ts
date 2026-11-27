// The `auth` section of config.json (DA5, #36, #37). Read and written here, merged into the file so
// other keys survive. Holds no secrets: never a password, a session key or a message.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_PROVIDERS } from "@tabagent/protocol";
import { configPath, home } from "../config";

export type BridgeProviderName = (typeof BRIDGE_PROVIDERS)[number];

export interface BitwardenConfig {
  /** `bw` binary resolved once at `tabagent bitwarden enable`. */
  bin?: string;
  idleLockMinutes: number;
  maxUnlockHours: number;
}

export interface AuthConfig {
  /** Ordered (DA5). Bitwarden is present only after `tabagent bitwarden enable` (#37). */
  providers: BridgeProviderName[];
  /** #36: the Messages code source. Off by default. */
  sms: boolean;
  bitwarden: BitwardenConfig;
}

export const AUTH_DEFAULTS: AuthConfig = { providers: ["1password"], sms: false, bitwarden: { idleLockMinutes: 30, maxUnlockHours: 8 } };

const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);
/** 0 turns a Bitwarden lock timer off (the user's explicit choice); anything else clamps to the range. */
const clampOrOff = (n: unknown, lo: number, hi: number, d: number) => (n === 0 ? 0 : clamp(n, lo, hi, d));
/** Timer length in ms for the provider; 0 (off) never fires. */
export const lockMs = (value: number, unitMs: number) => (value === 0 ? Infinity : value * unitMs);

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function readAuthConfig(path = configPath()): AuthConfig {
  const a = (readRaw(path).auth ?? {}) as Partial<AuthConfig> & { bitwarden?: Partial<BitwardenConfig> };
  const providers = Array.isArray(a.providers) ? a.providers.filter((p): p is BridgeProviderName => (BRIDGE_PROVIDERS as readonly string[]).includes(p)) : AUTH_DEFAULTS.providers;
  const bw: Partial<BitwardenConfig> = a.bitwarden ?? {};
  return {
    providers: [...new Set(providers)],
    sms: a.sms === true,
    bitwarden: {
      ...(typeof bw.bin === "string" && bw.bin ? { bin: bw.bin } : {}),
      idleLockMinutes: clampOrOff(bw.idleLockMinutes, 5, 240, AUTH_DEFAULTS.bitwarden.idleLockMinutes),
      maxUnlockHours: clampOrOff(bw.maxUnlockHours, 1, 24, AUTH_DEFAULTS.bitwarden.maxUnlockHours),
    },
  };
}

/** Merge a change into config.json's `auth` section, keeping every other key. 0600. */
export function writeAuthConfig(change: (a: AuthConfig) => AuthConfig, path = configPath()): AuthConfig {
  const raw = readRaw(path);
  const next = change(readAuthConfig(path));
  raw.auth = next;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return next;
}

/** #37: TabAgent's own Bitwarden CLI state, separate from the user's. */
export function bitwardenDataDir(): string {
  return join(home(), "bitwarden");
}
