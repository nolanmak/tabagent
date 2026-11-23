// DA2 secret channel, extension side (CONTRACT "M6 Auth addendum" wire). index.ts hands every
// bridge message of type auth.accounts.result / secret to onMessage(). A secret's value is returned
// to exactly one awaiting caller and is never stored here: the pending map holds resolvers only.
import { TabAgentError, type AuthAccountsResult, type ErrorCode } from "@tabagent/protocol";

export type Sender = (msg: unknown) => boolean;

interface Waiter {
  kind: "accounts" | "secret";
  commandId: string;
  field?: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

export interface ChannelDeps {
  send: Sender;
  newId?: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

const wireErr = (e: { code?: string; message?: string; hint?: string } | undefined, fallback: string) =>
  new TabAgentError(((e?.code as ErrorCode) ?? "INTERNAL") as ErrorCode, e?.message ?? fallback, e?.hint);

export function createAuthChannel(deps: ChannelDeps) {
  const waiting = new Map<string, Waiter>();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const st = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  function request<T>(kind: Waiter["kind"], msg: Record<string, unknown>, commandId: string, timeoutMs: number, field?: string): Promise<T> {
    const id = newId();
    return new Promise<T>((resolve, reject) => {
      if (!deps.send({ ...msg, id, commandId })) {
        reject(new TabAgentError("NO_EXTENSION", "The TabAgent bridge is not connected"));
        return;
      }
      const timer = st(() => {
        waiting.delete(id);
        reject(new TabAgentError("TIMEOUT", kind === "accounts" ? "The bridge did not list accounts in time" : "The bridge did not deliver the secret in time"));
      }, timeoutMs);
      waiting.set(id, { kind, commandId, field, resolve, reject, timer });
    });
  }

  return {
    /** #33 step 2: accounts matching the origin the extension reports. */
    accounts(commandId: string, origin: string, timeoutMs = 30_000): Promise<AuthAccountsResult> {
      return request("accounts", { type: "auth.accounts", origin }, commandId, timeoutMs);
    },
    /** #33 step 4, only after consent. Resolves to the plaintext; the caller types it and drops it. */
    secret(commandId: string, accountId: string, field: "username" | "password" | "totp", timeoutMs = 60_000): Promise<string> {
      return request("secret", { type: "auth.secret.request", accountId, field }, commandId, timeoutMs, field === "totp" ? "code" : field);
    },
    /** #36: a code from the bridge's SMS source. */
    smsCode(commandId: string, since: number, timeout: number): Promise<string> {
      return request("secret", { type: "auth.code.request", source: "sms", since, timeout }, commandId, timeout + 10_000, "code");
    },
    /** Handles bridge→ext auth messages. Returns true when the message was ours. */
    onMessage(msg: any): boolean {
      if (msg?.type !== "auth.accounts.result" && msg?.type !== "secret") return false;
      const w = waiting.get(msg.id);
      if (!w) return true; // late or unknown: drop (and never keep the value)
      if ((msg.type === "secret") !== (w.kind === "secret") || (msg.commandId !== undefined && msg.commandId !== w.commandId) || (w.field && msg.field !== w.field)) return true;
      waiting.delete(msg.id);
      ct(w.timer);
      if (msg.type === "auth.accounts.result") {
        if (msg.ok) w.resolve(msg as AuthAccountsResult);
        else w.reject(wireErr(msg.error, "The bridge could not list accounts"));
        return true;
      }
      if (msg.ok && typeof msg.value === "string") w.resolve(msg.value);
      else w.reject(wireErr(msg.error, "The bridge could not provide the secret"));
      return true;
    },
    /** Kill switch / disconnect: fail everything pending. */
    rejectAll(e: Error) {
      for (const [id, w] of waiting) {
        ct(w.timer);
        waiting.delete(id);
        w.reject(e);
      }
    },
    pendingCount: () => waiting.size,
  };
}

export type AuthChannel = ReturnType<typeof createAuthChannel>;
