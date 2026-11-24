// #61 Part B: the `handoff` section of config.json. Read on every handoff so the CLI's changes apply
// to a running bridge without a restart. Holds no secrets (the webhook URL is the user's own endpoint).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HANDOFF_LOCAL_TIMEOUT_MIN, HANDOFF_REMOTE_TIMEOUT_MIN, HANDOFF_TIMEOUT_MIN_MAX } from "@tabagent/protocol";
import { configPath } from "../config";
import { isTailnetIPv4 } from "./tailnet";

export interface HandoffConfig {
  /** Serve the phone page on the tailnet address. Off by default. */
  remote: boolean;
  /** POSTed {event, origin, reason, url, expiresAt, session} when a handoff starts. */
  webhook: string | null;
  /** null → 30 with remote on, else 5. */
  timeoutMin: number | null;
}

export const HANDOFF_DEFAULTS: HandoffConfig = { remote: false, webhook: null, timeoutMin: null };

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function readHandoffConfig(path = configPath()): HandoffConfig {
  const h = (readRaw(path).handoff ?? {}) as Partial<HandoffConfig>;
  let webhook: string | null = null;
  try {
    if (typeof h.webhook === "string" && h.webhook) webhook = validateWebhookUrl(h.webhook);
  } catch {
    webhook = null;
  }
  return {
    remote: h.remote === true,
    webhook,
    timeoutMin: typeof h.timeoutMin === "number" && Number.isFinite(h.timeoutMin) ? h.timeoutMin : null,
  };
}

export function writeHandoffConfig(change: (h: HandoffConfig) => HandoffConfig, path = configPath()): HandoffConfig {
  const raw = readRaw(path);
  const next = change(readHandoffConfig(path));
  raw.handoff = next;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return next;
}

export function handoffTimeoutMs(h: HandoffConfig): number {
  const min = h.timeoutMin ?? (h.remote ? HANDOFF_REMOTE_TIMEOUT_MIN : HANDOFF_LOCAL_TIMEOUT_MIN);
  return Math.min(HANDOFF_TIMEOUT_MIN_MAX, Math.max(1, Math.round(min))) * 60_000;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The webhook body carries a live handoff link, so it must not cross the internet in clear text:
 * https anywhere, plain http only to loopback or the tailnet (WireGuard-encrypted).
 */
export function validateWebhookUrl(s: string): string {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Not a URL: ${s}`);
  }
  if (u.protocol === "https:") return s;
  if (u.protocol === "http:" && (LOOPBACK.has(u.hostname) || isTailnetIPv4(u.hostname) || u.hostname.endsWith(".ts.net"))) return s;
  throw new Error("The webhook must be https, or http to loopback or a tailnet address (it carries a live handoff link)");
}
