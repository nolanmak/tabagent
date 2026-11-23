// Bridge side of the secret channel (DA2, CONTRACT "M6 Auth addendum").
//
// The extension asks for accounts, then (after consent) for one secret field, or for an SMS code. The
// bridge answers ONLY for an in-flight auth.* command with that commandId, only with accounts it found
// for that command's origin, and each field at most once per command. Secret values are held in this
// command's state just long enough to screen the command's Result for them, then wiped. They are never
// logged, audited, persisted or put into any Result.
import {
  AuthAccountsRequestSchema,
  AuthCodeRequestSchema,
  AuthSecretRequestSchema,
  getTool,
  httpsOrigin,
  isAuthExtMessage,
  parseAccountId,
  TabAgentError,
  toTabAgentError,
  type AuthAccount,
  type AuthBridgeToExt,
  type CodeSourceStatus,
  type ProviderStatus,
  type SecretField,
} from "@tabagent/protocol";
import type { BridgeProvider, SecretRequestField } from "./provider";
import type { SmsSource } from "./sms";

/** #37: provider work inside one auth.* call is capped at 30s. */
export const AUTH_PROVIDER_CAP_MS = 30_000;

export interface InFlight {
  tool: string;
  /** Connection the command went out on; replies must come back on it. */
  ws?: unknown;
}

export interface AuthAuditSink {
  event(event: string, data: Record<string, unknown> | undefined, who?: { caller: string; session?: string }): void;
}

export interface AuthBridgeOpts {
  inFlight: (commandId: string) => InFlight | undefined;
  providers: () => BridgeProvider[];
  sms?: SmsSource;
  audit: AuthAuditSink;
  log?: (m: string) => void;
}

interface CommandState {
  tool: string;
  origin?: string;
  accounts: Map<string, AuthAccount>;
  delivered: Set<string>;
  secrets: string[];
  aborter: AbortController;
}

const LOOKUP_TOOLS = new Set(["auth.status", "auth.login", "auth.code"]);
const WITHHELD = { code: "INTERNAL" as const, message: "TabAgent withheld this auth result because it did not match the secret-free result schema" };

export class AuthBridge {
  private cmds = new Map<string, CommandState>();
  constructor(private o: AuthBridgeOpts) {}

  /**
   * Hook for the daemon's extension-message switch. Returns true when the message was an auth.* request
   * (fully handled here). For a `result` of a tracked auth command it screens the envelope in place and
   * returns false so the daemon carries on. An `event` kill drops provider sessions.
   */
  onExtMessage(msg: unknown, ws: unknown, send: (m: AuthBridgeToExt) => void): boolean {
    if (isAuthExtMessage(msg)) {
      void this.handle(msg as { type: string }, ws, send);
      return true;
    }
    const m = msg as { type?: string; id?: unknown; event?: unknown; data?: { kind?: unknown } } | null;
    if (m?.type === "result" && typeof m.id === "string") this.screen(m as unknown as Record<string, unknown>);
    if (m?.type === "event" && (m.event === "killed" || m.event === "kill" || m.data?.kind === "kill")) void this.dropAll("kill");
    return false;
  }

  /** #37: a hello with `paused: true` (kill happened while the socket was down) drops sessions first. */
  onHello(raw: unknown): void {
    if ((raw as { paused?: unknown } | null)?.paused === true) void this.dropAll("kill");
  }

  async dropAll(reason: string): Promise<void> {
    for (const c of this.cmds.values()) c.aborter.abort();
    await Promise.all(this.o.providers().map((p) => p.drop?.(reason).catch(() => {})));
  }

  /** Commands tracked right now (tests). */
  get tracked(): number {
    return this.cmds.size;
  }

  private state(commandId: string, ws: unknown): CommandState | null {
    const f = this.o.inFlight(commandId);
    if (!f || !f.tool.startsWith("auth.") || (f.ws !== undefined && ws !== undefined && f.ws !== ws)) return null;
    let s = this.cmds.get(commandId);
    if (!s) {
      // Commands that ended without a result (timeout, disconnect) leave state behind: wipe it.
      for (const [k, c] of this.cmds) if (!this.o.inFlight(k)) (c.secrets.length = 0), this.cmds.delete(k);
      s = { tool: f.tool, accounts: new Map(), delivered: new Set(), secrets: [], aborter: new AbortController() };
      this.cmds.set(commandId, s);
    }
    return s;
  }

  private async handle(msg: { type: string }, ws: unknown, send: (m: AuthBridgeToExt) => void): Promise<void> {
    try {
      if (msg.type === "auth.accounts") return await this.onAccounts(msg, ws, send);
      if (msg.type === "auth.secret.request") return await this.onSecret(msg, ws, send);
      if (msg.type === "auth.code.request") return await this.onCode(msg, ws, send);
    } catch (e) {
      // Never let a provider error text through: fixed messages only come from our own TabAgentErrors.
      this.o.log?.(`auth: ${msg.type} failed (${toTabAgentError(e).code})`);
    }
  }

  private async onAccounts(raw: unknown, ws: unknown, send: (m: AuthBridgeToExt) => void) {
    const p = AuthAccountsRequestSchema.safeParse(raw);
    if (!p.success) return;
    const { id, commandId } = p.data;
    const reply = (m: Omit<Extract<AuthBridgeToExt, { type: "auth.accounts.result" }>, "type" | "id">) => send({ type: "auth.accounts.result", id, ...m });
    const s = this.state(commandId, ws);
    if (!s || !LOOKUP_TOOLS.has(s.tool)) return reply({ ok: false, error: noCommand() });
    const origin = httpsOrigin(p.data.origin);
    if (!origin) {
      this.audit("auth.accounts", { tool: s.tool, origin: p.data.origin.slice(0, 200), outcome: "denied", errorCode: "PERMISSION_DENIED" });
      return reply({ ok: false, error: { code: "PERMISSION_DENIED", message: "Sign-in is only offered on https pages (DA3)" } });
    }
    s.origin = origin;
    const accounts: AuthAccount[] = [];
    const providers: ProviderStatus[] = [];
    for (const prov of this.o.providers()) {
      let st: ProviderStatus;
      try {
        st = await capped(prov.status());
      } catch {
        st = { name: prov.name, state: "missing" };
      }
      if (st.state === "disabled") continue; // #37: a disabled provider is absent from auth.status
      if (st.state === "unlocked") {
        try {
          for (const a of await capped(prov.find(origin))) {
            accounts.push(a);
            s.accounts.set(a.id, a);
          }
        } catch (e) {
          const err = toTabAgentError(e);
          if (err.hint) st = { ...st, hint: err.hint };
        }
      }
      providers.push(st);
    }
    const codeSources: CodeSourceStatus[] = [];
    if (this.o.sms) codeSources.push(this.o.sms.status());
    this.audit("auth.accounts", { tool: s.tool, origin, outcome: "ok", accounts: accounts.length, providers: providers.map((x) => `${x.name}:${x.state}`) });
    reply({ ok: true, accounts, providers, codeSources });
  }

  private async onSecret(raw: unknown, ws: unknown, send: (m: AuthBridgeToExt) => void) {
    const p = AuthSecretRequestSchema.safeParse(raw);
    if (!p.success) return;
    const { id, commandId, accountId, field } = p.data;
    const wire: SecretField = field === "totp" ? "code" : field;
    const fail = (error: { code: TabAgentError["code"]; message: string; hint?: string }) => send({ type: "secret", id, commandId, field: wire, ok: false, error });
    const s = this.state(commandId, ws);
    const allowed = s && (field === "totp" ? s.tool === "auth.code" : s.tool === "auth.login");
    if (!s || !allowed) return fail(noCommand());
    const acct = s.accounts.get(accountId);
    const ref = parseAccountId(accountId);
    const base = { tool: s.tool, origin: s.origin ?? null, provider: ref?.provider, account: acct?.accountMasked, field };
    // DA3 on the bridge side too: only an account found for this command's origin; nothing is fetched otherwise.
    if (!acct || !ref) {
      this.audit("auth.secret", { ...base, outcome: "denied", errorCode: "PERMISSION_DENIED" });
      return fail({ code: "PERMISSION_DENIED", message: "That account was not offered for this page" });
    }
    if (s.delivered.has(field)) {
      this.audit("auth.secret", { ...base, outcome: "denied", errorCode: "BAD_REQUEST" });
      return fail({ code: "BAD_REQUEST", message: `The ${field} was already sent for this command` });
    }
    if ((acct.passkeyOnly || acct.reprompt) && field !== "totp") {
      this.audit("auth.secret", { ...base, outcome: "denied", errorCode: "PERMISSION_DENIED" });
      return fail({ code: "PERMISSION_DENIED", message: "This item needs the user (passkey or re-prompt)", hint: "Use auth.handoff." });
    }
    const prov = this.o.providers().find((x) => x.name === ref.provider);
    if (!prov) return fail({ code: "NOT_FOUND", message: `Provider ${ref.provider} is not configured` });
    try {
      const value = await capped(prov.secret(ref.localId, field as SecretRequestField));
      s.delivered.add(field);
      s.secrets.push(value);
      this.audit("auth.secret", { ...base, outcome: "ok" });
      send({ type: "secret", id, commandId, field: wire, ok: true, value });
    } catch (e) {
      const err = toTabAgentError(e);
      this.audit("auth.secret", { ...base, outcome: "error", errorCode: err.code });
      fail(safeError(err));
    }
  }

  private async onCode(raw: unknown, ws: unknown, send: (m: AuthBridgeToExt) => void) {
    const p = AuthCodeRequestSchema.safeParse(raw);
    if (!p.success) return;
    const { id, commandId, since, timeout } = p.data;
    const fail = (error: { code: TabAgentError["code"]; message: string; hint?: string }) => send({ type: "secret", id, commandId, field: "code", ok: false, error });
    const s = this.state(commandId, ws);
    if (!s || s.tool !== "auth.code") return fail(noCommand());
    const base = { tool: s.tool, origin: s.origin ?? null, source: "sms" };
    if (s.delivered.has("code")) return fail({ code: "BAD_REQUEST", message: "A code was already sent for this command" });
    if (!this.o.sms) {
      this.audit("auth.code", { ...base, outcome: "error", errorCode: "UNSUPPORTED" });
      return fail({ code: "UNSUPPORTED", message: "No SMS code source in this bridge" });
    }
    try {
      const code = await this.o.sms.fetch({ since, timeout, signal: s.aborter.signal });
      s.delivered.add("code");
      s.secrets.push(code);
      this.audit("auth.code", { ...base, outcome: "ok" });
      send({ type: "secret", id, commandId, field: "code", ok: true, value: code });
    } catch (e) {
      const err = toTabAgentError(e);
      this.audit("auth.code", { ...base, outcome: "error", errorCode: err.code });
      fail(safeError(err));
    }
  }

  /**
   * Defence in depth on the Result of a tracked auth command: a secret tool's result must parse against
   * its strict schema, and no value this command delivered may appear anywhere in the envelope (result,
   * error, audit record, side fields). Either failure replaces the result with a fixed INTERNAL error.
   */
  private screen(env: Record<string, unknown>) {
    const id = env.id as string;
    const s = this.cmds.get(id);
    const tool = s?.tool ?? this.o.inFlight(id)?.tool;
    if (!tool?.startsWith("auth.")) return;
    this.cmds.delete(id);
    const def = getTool(tool);
    let leak = false;
    if (s?.secrets.length) {
      const text = JSON.stringify(env);
      leak = s.secrets.some((v) => v.length > 0 && text.includes(v));
    }
    const badShape = env.ok === true && !!def?.secret && !def.result.safeParse(env.result).success;
    if (leak || badShape) {
      env.ok = false;
      delete env.result;
      for (const k of ["snapshotDiff", "navigation", "dialogs", "downloads"]) delete env[k];
      env.error = WITHHELD;
      const a = env.audit as Record<string, unknown> | undefined;
      if (a && typeof a === "object") {
        a.params = "[withheld]";
        a.outcome = "error";
        a.errorCode = "INTERNAL";
      }
      this.o.log?.(`auth: withheld ${tool} result (${leak ? "secret material" : "schema"})`);
    }
    if (s) s.secrets.length = 0;
  }

  private audit(event: string, data: Record<string, unknown>) {
    this.o.audit.event(event, { kind: "auth", ...data });
  }
}

function noCommand() {
  return { code: "PERMISSION_DENIED" as const, message: "No auth command in flight with that id" };
}

/** Only our own codes and fixed messages reach the extension; hints are TabAgent-authored. */
function safeError(e: TabAgentError) {
  return { code: e.code, message: e.message.slice(0, 200), ...(e.hint ? { hint: e.hint } : {}) };
}

function capped<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new TabAgentError("TIMEOUT", "The password manager did not answer in 30s")), AUTH_PROVIDER_CAP_MS)))]).finally(() => clearTimeout(t));
}
