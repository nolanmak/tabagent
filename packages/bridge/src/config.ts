import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, DEV_EXTENSION_ID, type Cap } from "@tabagent/protocol";

export interface TokenRec {
  name: string;
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
  /** Max bytes downloads.read may return. */
  maxReadBytes: number;
}

export function home(): string {
  return process.env.TABAGENT_HOME ?? join(homedir(), ".tabagent");
}

export function configPath() {
  return join(home(), "config.json");
}

export function auditPath() {
  return join(home(), "audit.jsonl");
}

export function loadConfig(): Config {
  const dir = home();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = configPath();
  let cfg: Partial<Config> = {};
  if (existsSync(p)) {
    try {
      cfg = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`Could not parse ${p}: ${(e as Error).message}`);
    }
  }
  const full: Config = {
    port: cfg.port ?? DEFAULT_PORT,
    secret: cfg.secret ?? randomBytes(24).toString("base64url"),
    extensionIds: cfg.extensionIds ?? [DEV_EXTENSION_ID],
    tokens: cfg.tokens ?? [],
    uploadDirs: cfg.uploadDirs ?? [join(homedir(), "Downloads"), join(homedir(), "Desktop"), join(home(), "uploads"), tmpdir()],
    maxReadBytes: cfg.maxReadBytes ?? 5_000_000,
  };
  const missing = !existsSync(p) || (Object.keys(full) as (keyof Config)[]).some((k) => !(k in cfg));
  if (missing) saveConfig(full);
  if (process.env.TABAGENT_PORT) full.port = Number(process.env.TABAGENT_PORT);
  return full;
}

/** Persist config. The port is re-read from disk so an env override never sticks. */
export function saveConfig(cfg: Config) {
  const p = configPath();
  let port = cfg.port;
  if (existsSync(p)) {
    try {
      port = JSON.parse(readFileSync(p, "utf8")).port ?? cfg.port;
    } catch {
      /* ignore */
    }
  } else if (process.env.TABAGENT_PORT) port = DEFAULT_PORT;
  writeFileSync(p, JSON.stringify({ ...cfg, port }, null, 2), { mode: 0o600 });
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

export function newPairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(6);
  const s = [...b].map((x) => alphabet[x % alphabet.length]).join("");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}
