// #15 per-client tokens (D3): least privilege among cooperating agents, not a sandbox.
import { timingSafeEqual } from "node:crypto";
import { CapSchema, TabAgentError, type Cap } from "@tabagent/protocol";
import { hashToken, newToken, type Config } from "./config";

export interface Principal {
  /** "local" for the bridge secret, else the token name. */
  name: string;
  kind: "secret" | "token";
  cap: Cap;
  sites: string[];
}

const NAME_RE = /^[\w.-]{1,40}$/;
const SITE_RE = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/i;

export function parseSites(s: string | undefined): string[] {
  if (!s) return [];
  const list = s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const g of list) if (!SITE_RE.test(g)) throw new TabAgentError("BAD_REQUEST", `Bad site glob "${g}". Use hostnames like example.com or *.github.com`);
  return list;
}

export function createToken(cfg: Config, name: string, cap: string = "act", sites: string[] = [], now = new Date()): string {
  if (!NAME_RE.test(name)) throw new TabAgentError("BAD_REQUEST", "Token name must be 1-40 chars of letters, digits, _ . -");
  const c = CapSchema.safeParse(cap);
  if (!c.success) throw new TabAgentError("BAD_REQUEST", "--caps must be one of read, act, full (a single maximum level)");
  if (name === "local") throw new TabAgentError("BAD_REQUEST", '"local" is reserved for the bridge secret');
  if (cfg.tokens.some((t) => t.name === name)) throw new TabAgentError("BAD_REQUEST", `Token "${name}" exists. Revoke it first.`);
  const tok = newToken();
  cfg.tokens.push({ name, hash: hashToken(tok), cap: c.data, sites, created: now.toISOString() });
  return tok;
}

export function revokeToken(cfg: Config, name: string): boolean {
  const n = cfg.tokens.length;
  cfg.tokens = cfg.tokens.filter((t) => t.name !== name);
  return cfg.tokens.length !== n;
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Resolve a bearer credential to a principal, or null. */
export function authenticate(cfg: Pick<Config, "secret" | "tokens">, bearer: string | undefined): Principal | null {
  if (!bearer) return null;
  if (safeEq(bearer, cfg.secret)) return { name: "local", kind: "secret", cap: "full", sites: [] };
  const h = hashToken(bearer);
  const rec = cfg.tokens.find((t) => safeEq(t.hash, h));
  return rec ? { name: rec.name, kind: "token", cap: rec.cap, sites: [...rec.sites] } : null;
}

export function bearerOf(header: string | undefined): string | undefined {
  const m = String(header ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}
