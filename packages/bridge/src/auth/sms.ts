// #36 SMS / iMessage code source (macOS, bridge). Reads ~/Library/Messages/chat.db READ-ONLY and
// returns one code. Message text, senders and chat ids never leave this module: only extractCode's
// output does, and the audit record says `source: "sms"` and the outcome.
//
// OA3 (checked on macOS 26.3, 2026-11-23, aggregate counts only):
// - Most bodies are only in `attributedBody` (`text` NULL in ~74% of recent rows); decodeAttributedBody
//   recovers them (matched `text` on 11,770/11,770 rows that have both).
// - chat.db is in WAL mode and Messages keeps recent rows in chat.db-wal. A plain read-only open
//   (`mode=ro`) sees them; `immutable=1` does not (it missed the newest rows). So: mode=ro, never immutable,
//   never copy the file.
// - `message.date` is nanoseconds since 2001-01-01 and overflows a JS number; we divide in SQL.
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODE_MAX_AGE_MS, pollCode, TabAgentError, type CodeMessage, type CodeSourceStatus } from "@tabagent/protocol";
import { decodeAttributedBody } from "./attributed-body";

export const APPLE_EPOCH_MS = 978_307_200_000;

export const SMS_HINTS = {
  fda: "System Settings > Privacy & Security > Full Disk Access: turn on the app that starts the bridge (Terminal, iTerm, your IDE or the agent app), then quit and reopen that app.",
  forwarding: "For SMS (green bubbles), on the iPhone: Settings > Apps > Messages > Text Message Forwarding > turn on this Mac.",
  disabled: "The SMS code source is off. The user can turn it on with `tabagent config auth.sms on`.",
  unsupported: "SMS codes are read from Messages on macOS only.",
} as const;

export function defaultChatDb(): string {
  return join(homedir(), "Library", "Messages", "chat.db");
}

export interface Db {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}
export type DbOpener = (path: string) => Promise<Db>;

/** Read-only open: node:sqlite (Node 22.5+), else better-sqlite3 if installed. */
export const openReadOnly: DbOpener = async (path) => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro`, { readOnly: true });
    return { all: (sql, ...p) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[], close: () => db.close() };
  } catch (e) {
    if (!isMissingModule(e)) throw e;
  }
  try {
    const mod = (await import(/* optional */ "better-sqlite3" as string)) as { default: new (p: string, o: object) => { prepare(s: string): { all(...a: unknown[]): unknown[] }; close(): void } };
    const db = new mod.default(path, { readonly: true, fileMustExist: true });
    return { all: (sql, ...p) => db.prepare(sql).all(...p) as Record<string, unknown>[], close: () => db.close() };
  } catch {
    throw new TabAgentError("UNSUPPORTED", "No SQLite driver: use Node 22.5 or later (node:sqlite) or install better-sqlite3");
  }
};
function isMissingModule(e: unknown): boolean {
  const c = (e as { code?: string })?.code;
  return c === "ERR_UNKNOWN_BUILTIN_MODULE" || c === "ERR_MODULE_NOT_FOUND" || c === "MODULE_NOT_FOUND";
}

export interface SmsOpts {
  enabled: () => boolean;
  /** Injectable in tests only. */
  dbPath?: string;
  platform?: NodeJS.Platform;
  open?: DbOpener;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  interval?: number;
}

const QUERY = `SELECT ROWID AS id, text, attributedBody AS body, date / 1000000 AS dms
  FROM message
  WHERE is_from_me = 0 AND date > ?
  ORDER BY date DESC
  LIMIT 20`;

export class SmsSource {
  /** Row ids whose code was handed out: a code is used once. */
  private used = new Set<string>();
  constructor(private o: SmsOpts) {}

  get path() {
    return this.o.dbPath ?? defaultChatDb();
  }

  /** Never opens the file when disabled or off macOS. */
  status(): CodeSourceStatus {
    if ((this.o.platform ?? process.platform) !== "darwin") return { name: "sms", state: "unsupported", hint: SMS_HINTS.unsupported };
    if (!this.o.enabled()) return { name: "sms", state: "disabled", hint: SMS_HINTS.disabled };
    if (!existsSync(this.path)) return { name: "sms", state: "missing", hint: `${SMS_HINTS.fda} ${SMS_HINTS.forwarding}` };
    try {
      closeSync(openSync(this.path, constants.O_RDONLY));
    } catch {
      return { name: "sms", state: "unreadable", hint: SMS_HINTS.fda };
    }
    return { name: "sms", state: "available", hint: SMS_HINTS.forwarding };
  }

  private refuse(st: CodeSourceStatus): never {
    if (st.state === "unsupported") throw new TabAgentError("UNSUPPORTED", "SMS codes are only available on macOS", st.hint);
    if (st.state === "disabled") throw new TabAgentError("PERMISSION_DENIED", "The SMS code source is off", st.hint);
    if (st.state === "missing") throw new TabAgentError("NOT_FOUND", "The Messages database was not found", st.hint);
    throw new TabAgentError("NOT_FOUND", "The Messages database is not readable", st.hint);
  }

  /** One code received after `since` (epoch ms), polling until `timeout`. */
  async fetch(o: { since: number; timeout: number; signal?: AbortSignal }): Promise<string> {
    const st = this.status();
    if (st.state !== "available") this.refuse(st);
    const now = this.o.now ?? Date.now;
    let db: Db;
    try {
      db = await (this.o.open ?? openReadOnly)(this.path);
    } catch (e) {
      if (e instanceof TabAgentError) throw e;
      throw new TabAgentError("NOT_FOUND", "The Messages database is not readable", SMS_HINTS.fda);
    }
    try {
      const read = (): CodeMessage[] => {
        const floor = Math.max(o.since, now() - CODE_MAX_AGE_MS);
        const ns = BigInt(Math.max(0, Math.floor(floor - APPLE_EPOCH_MS))) * 1_000_000n;
        return db.all(QUERY, ns).map((r) => ({
          id: String(r.id),
          date: Number(r.dms) + APPLE_EPOCH_MS,
          text: typeof r.text === "string" && r.text ? r.text : (decodeAttributedBody(r.body as Uint8Array | null) ?? ""),
        }));
      };
      const r = await pollCode(read, { since: o.since, timeout: o.timeout, used: this.used, now, sleep: this.o.sleep, interval: this.o.interval ?? 2000, signal: o.signal });
      if (r.messageId) this.used.add(r.messageId);
      return r.code;
    } finally {
      db.close();
    }
  }
}
