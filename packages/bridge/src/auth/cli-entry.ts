// Real-world deps for the auth CLI commands (kept out of cli.ts so its hook stays one line per command).
import { ensureDaemon, health } from "../client";
import type { Out } from "../commands";
import { loadConfig } from "../config";
import { authConfigCommand, bitwardenCommand, doctorCommand } from "./cli";
import { ADMIN_BITWARDEN_SESSION } from "./index";

type Flags = Record<string, string | boolean>;

function port(f: Flags) {
  const cfg = loadConfig();
  if (typeof f.port === "string") cfg.port = Number(f.port);
  return cfg;
}

export const authCli = {
  async config(pos: string[]): Promise<Out> {
    return authConfigCommand(pos);
  },
  async doctor(_pos: string[], f: Flags): Promise<Out> {
    const cfg = port(f);
    return doctorCommand({ bridge: async () => ({ port: cfg.port, up: !!(await health(cfg.port)) }) });
  },
  async bitwarden(pos: string[], f: Flags, cliPath: string): Promise<Out> {
    const cfg = port(f);
    return bitwardenCommand(pos, f, {
      ensureDaemon: async () => !!(await ensureDaemon(cfg.port, cliPath)).health,
      admin: async (method, body) => {
        const r = await fetch(`http://127.0.0.1:${cfg.port}${ADMIN_BITWARDEN_SESSION}`, {
          method,
          headers: { authorization: `Bearer ${cfg.secret}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let j: unknown;
        try {
          j = text ? JSON.parse(text) : undefined;
        } catch {
          j = undefined;
        }
        return { status: r.status, body: j };
      },
    });
  },
};
