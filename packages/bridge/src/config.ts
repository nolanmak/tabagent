// Bridge config (D32): ~/.tabagent (or TABAGENT_HOME), dir 0700, config.json 0600.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, type Cap } from "@tabagent/protocol";

export interface TokenRec {
  name: string;
  /** SHA-256 hex of the token; the plaintext is never stored. */
  hash: string;
  cap: Cap;
  sites: string[];
  created: string;
}

export interface Config {
  port: number;
  secret: string;
  extensionIds: string[];
  tokens: TokenRec[];
  uploadDirs: string[];
  /** Max bytes downloads.read may return (D31: 5 MB). */
  maxReadBytes: number;
}

export const MAX_READ_BYTES = 5 * 1024 * 1024;

export function home(): string {
  return process.env.TABAGENT_HOME ?? join(homedir(), ".tabagent");
}
export function configPath() {
  return join(home(), "config.json");
}
export function auditPath() {
  return join(home(), "audit.jsonl");
}
export function defaultUploadDir() {
  return join(home(), "uploads");
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* windows */
  }
}

function readRaw(): Partial<Config> | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse ${p}: ${(e as Error).message}`);
  }
}

export function loadConfig(): Config {
  ensureDir(home());
  const raw = readRaw() ?? {};
  // Unknown top-level keys (e.g. `auth`, owned by the auth bridge) are kept as they are.
  const full: Config = {
    ...(raw as object),
    port: raw.port ?? DEFAULT_PORT,
    secret: raw.secret ?? randomBytes(24).toString("base64url"),
    extensionIds: raw.extensionIds ?? [],
    tokens: raw.tokens ?? [],
    uploadDirs: raw.uploadDirs ?? [defaultUploadDir()],
    maxReadBytes: Math.min(raw.maxReadBytes ?? MAX_READ_BYTES, MAX_READ_BYTES),
  };
  if (!raw.uploadDirs) ensureDir(defaultUploadDir());
  const missing = (["port", "secret", "extensionIds", "tokens", "uploadDirs", "maxReadBytes"] as const).some((k) => !(k in raw));
  if (missing) saveConfig(full);
  if (process.env.TABAGENT_PORT) full.port = Number(process.env.TABAGENT_PORT);
  return full;
}

/** Persist config atomically with mode 0600. The port is re-read from disk so an env override never sticks. */
export function saveConfig(cfg: Config) {
  ensureDir(home());
  const p = configPath();
  let port = cfg.port;
  const raw = existsSync(p) ? (() => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } })() : null;
  if (raw && typeof raw.port === "number") port = raw.port;
  else if (process.env.TABAGENT_PORT && Number(process.env.TABAGENT_PORT) === cfg.port) port = DEFAULT_PORT;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...(raw ?? {}), ...cfg, port }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
}

export function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

export function newToken(): string {
  return "tab_" + randomBytes(24).toString("base64url");
}

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newPairCode(): string {
  const b = randomBytes(6);
  const s = [...b].map((x) => PAIR_ALPHABET[x % PAIR_ALPHABET.length]).join("");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}
