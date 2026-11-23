// Talking to a running daemon: health probe, D6 detached spawn, REST calls (used by the CLI and the stdio MCP proxy).
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import type { OutputResponse } from "@tabagent/protocol";
import { home } from "./config";

export interface Health {
  ok: boolean;
  bridgeVersion: string;
  protocolVersion: number;
}

export async function health(port: number, timeoutMs = 800): Promise<Health | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = (await r.json()) as Health;
    return j?.ok && typeof j.bridgeVersion === "string" ? j : null;
  } catch {
    return null;
  }
}

/**
 * D6: if no daemon answers, spawn a detached `tabagent serve` (logs to ~/.tabagent/bridge.log, never to our
 * stdout) and wait for /v1/health. The daemon outlives this process.
 */
export async function ensureDaemon(port: number, cliPath: string, waitMs = 10_000): Promise<{ spawned: boolean; health: Health | null }> {
  const h = await health(port);
  if (h) return { spawned: false, health: h };
  const log = openSync(join(home(), "bridge.log"), "a", 0o600);
  const child = spawn(process.execPath, [cliPath, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const hh = await health(port, 400);
    if (hh) return { spawned: true, health: hh };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { spawned: true, health: null };
}

export interface RestOpts {
  port: number;
  token: string;
  headers?: Record<string, string>;
}

/** POST /v1/<tool>; returns the bridge's (already wrapped) response. Network failure -> NO_EXTENSION-style error. */
export async function restCall(o: RestOpts, tool: string, params: unknown): Promise<OutputResponse> {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${o.port}/v1/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.token}`, ...(o.headers ?? {}) },
      body: JSON.stringify(params ?? {}),
    });
  } catch (e) {
    return { ok: false, error: { code: "NO_EXTENSION", message: `Cannot reach the TabAgent bridge on port ${o.port}: ${(e as Error).message}`, hint: "Start it with `tabagent serve`." } };
  }
  const j = (await r.json().catch(() => null)) as OutputResponse | null;
  if (!j || typeof j.ok !== "boolean") return { ok: false, error: { code: "INTERNAL", message: `Bridge returned HTTP ${r.status}` } };
  return j;
}

export async function api(port: number, token: string, path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
