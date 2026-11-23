// HTTP credentials (D2, D3). Until per-client tokens (#15) the bridge secret is the only credential.
import { timingSafeEqual } from "node:crypto";
import type { Cap } from "@tabagent/protocol";
import type { Config } from "./config";

export interface Principal {
  /** "local" for the bridge secret. */
  name: string;
  kind: "secret";
  cap: Cap;
  sites: string[];
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Resolve a bearer credential to a principal, or null. */
export function authenticate(cfg: Pick<Config, "secret">, bearer: string | undefined): Principal | null {
  if (!bearer) return null;
  if (safeEq(bearer, cfg.secret)) return { name: "local", kind: "secret", cap: "full", sites: [] };
  return null;
}

export function bearerOf(header: string | undefined): string | undefined {
  const m = String(header ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}
