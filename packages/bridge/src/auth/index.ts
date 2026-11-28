// Wiring for the daemon: one object the daemon holds, with the few hooks it calls.
//   daemon field:      this.auth = createAuth({ inFlight: (id) => this.pending.get(id), audit: this.audit, log: this.log })
//   onExtMessage:      if (this.auth.bridge.onExtMessage(msg, ws, (m) => this.sendTo(ws, m as never))) return;
//   onHello:           this.auth.bridge.onHello(raw)
//   send() timeout:    + authExtraTimeout(tool)
//   onHttp (authed):   if (path.startsWith("/v1/admin/")) return this.auth.onAdmin(req, res, who.kind === "secret", path, () => this.readBody(req))
//   start / stop:      this.auth.start() / await this.auth.stop()
import type { IncomingMessage, ServerResponse } from "node:http";
import { TabAgentError, toTabAgentError } from "@tabagent/protocol";
import { BitwardenProvider } from "./bitwarden";
import { AuthBridge, type AuthAuditSink, type InFlight } from "./bridge";
import { bitwardenDataDir, lockMs, readAuthConfig, type AuthConfig } from "./config";
import { macKeychain } from "./keychain";
import { OnePasswordProvider } from "./onepassword";
import type { BridgeProvider } from "./provider";
import { SmsSource } from "./sms";

export const ADMIN_BITWARDEN_SESSION = "/v1/admin/bitwarden/session";

export interface AuthOpts {
  inFlight: (commandId: string) => InFlight | undefined;
  audit: AuthAuditSink;
  log?: (m: string) => void;
  now?: () => number;
  /** Tests: replace the config reader, providers, sms source. */
  config?: () => AuthConfig;
  onepassword?: OnePasswordProvider;
  bitwarden?: BitwardenProvider;
  sms?: SmsSource;
}

export interface Auth {
  bridge: AuthBridge;
  bitwarden: BitwardenProvider;
  providers(): BridgeProvider[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Admin routes; bridge secret only, never a D3 token, never in the tool registry (#37). */
  onAdmin(req: IncomingMessage, res: ServerResponse, isSecret: boolean, path: string, body: () => Promise<unknown>): Promise<void>;
}

export function createAuth(o: AuthOpts): Auth {
  const config = o.config ?? (() => readAuthConfig());
  const cfg0 = config();
  const onepassword = o.onepassword ?? new OnePasswordProvider();
  const bitwarden =
    o.bitwarden ??
    new BitwardenProvider({
      bin: cfg0.bitwarden.bin,
      dataDir: bitwardenDataDir(),
      now: o.now,
      enabled: () => config().providers.includes("bitwarden"),
      idleLockMs: lockMs(cfg0.bitwarden.idleLockMinutes, 60_000),
      maxUnlockMs: lockMs(cfg0.bitwarden.maxUnlockHours, 3_600_000),
      remember: () => config().bitwarden.rememberUnlock === true,
      keyStore: macKeychain(),
      event: (e, d) => o.audit.event(e, { kind: "auth", ...d }),
    });
  const sms = o.sms ?? new SmsSource({ enabled: () => config().sms });
  const providers = (): BridgeProvider[] => {
    const all: Record<string, BridgeProvider> = { "1password": onepassword, bitwarden };
    return config()
      .providers.map((n) => all[n])
      .filter(Boolean);
  };
  // Bitwarden is listed whenever configured so a disabled state can still be reported to `doctor`.
  const bridge = new AuthBridge({ inFlight: o.inFlight, providers, sms, audit: o.audit, log: o.log });
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    bridge,
    bitwarden,
    providers,
    async start() {
      await bitwarden.startup();
      timer = setInterval(() => void bitwarden.tick().catch(() => {}), 30_000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      await bitwarden.drop("daemon-exit");
    },
    async onAdmin(req, res, isSecret, path, body) {
      const send = (status: number, j?: unknown) => {
        if (res.headersSent) return;
        if (j === undefined) {
          res.writeHead(status);
          res.end();
        } else {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(j));
        }
      };
      if (!isSecret) return send(401, { ok: false, error: { code: "UNAUTHORIZED", message: "Admin routes need the bridge secret" } });
      if (path !== ADMIN_BITWARDEN_SESSION) return send(404, { ok: false, error: { code: "NOT_FOUND", message: "No such admin route" } });
      try {
        if (req.method === "DELETE") {
          await bitwarden.drop("lock");
          return send(204);
        }
        if (req.method === "POST") {
          const b = (await body()) as { key?: unknown } | undefined;
          if (typeof b?.key !== "string") throw new TabAgentError("BAD_REQUEST", "Body must be {key}");
          await bitwarden.setSession(b.key);
          return send(204);
        }
        if (req.method === "GET") return send(200, { ok: true, status: await bitwarden.status() });
        return send(405, { ok: false, error: { code: "BAD_REQUEST", message: "Use POST, DELETE or GET" } });
      } catch (e) {
        const err = toTabAgentError(e);
        // Never echo the body: it may hold the key.
        return send(err.code === "BAD_REQUEST" ? 400 : err.code === "PERMISSION_DENIED" ? 403 : 500, { ok: false, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } });
      }
    },
  };
}

export { AuthBridge } from "./bridge";
export { BitwardenProvider } from "./bitwarden";
export { OnePasswordProvider } from "./onepassword";
export { SmsSource } from "./sms";
