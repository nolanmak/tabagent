// D20 audit writer. The extension builds the record (params already redacted); the bridge only
// adds caller + ts and appends. Raw params and result bodies never reach this file.
import { appendFileSync, chmodSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { AuditRecordSchema, type AuditRecord, type ErrorCode } from "@tabagent/protocol";

export interface AuditOpts {
  maxBytes?: number;
  /** Files kept in total, including the live one. */
  keep?: number;
  now?: () => Date;
}

export interface Caller {
  /** Session label (token name, clientInfo.name or "local"). */
  caller: string;
  session?: string;
}

export class AuditWriter {
  readonly maxBytes: number;
  readonly keep: number;
  private now: () => Date;
  constructor(
    readonly path: string,
    o: AuditOpts = {},
  ) {
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.keep = o.keep ?? 5;
    this.now = o.now ?? (() => new Date());
  }

  /** Append the extension's record verbatim plus caller and ts. Invalid records are reduced to a minimal one. */
  record(rec: unknown, who: Caller): void {
    const r = AuditRecordSchema.safeParse(rec);
    if (!r.success) {
      const tool = typeof (rec as { tool?: unknown })?.tool === "string" ? (rec as { tool: string }).tool : "unknown";
      this.minimal(tool, "error", who, "INTERNAL", "malformed audit record from extension");
      return;
    }
    const a: AuditRecord = r.data;
    this.write({ ts: this.now().toISOString(), caller: who.caller, ...(who.session ? { session: who.session } : {}), ...a });
  }

  /** Bridge-built record for calls that never reached the extension (or a legacy extension). No params. */
  minimal(tool: string, outcome: "ok" | "error" | "denied", who: Caller, errorCode?: ErrorCode, note?: string): void {
    this.write({
      ts: this.now().toISOString(),
      caller: who.caller,
      ...(who.session ? { session: who.session } : {}),
      tool,
      origin: null,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      source: "bridge",
      ...(note ? { note } : {}),
    });
  }

  /** prompt, decision, killed, resumed, session.ended (D20), settings.changed (YOLO / devAllowSensitive toggles). */
  event(event: string, data: Record<string, unknown> | undefined, who?: Caller): void {
    this.write({ ts: this.now().toISOString(), event, ...(who ? { caller: who.caller } : {}), ...(data ? { data } : {}) });
  }

  private write(obj: Record<string, unknown>) {
    const line = JSON.stringify(obj) + "\n";
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.path, line, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      /* audit is best effort; never fail a command because the disk is full */
    }
  }

  private rotateIfNeeded(incoming: number) {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size + incoming <= this.maxBytes) return;
    // audit.jsonl -> .1 -> .2 ... ; the oldest beyond `keep` is dropped.
    const last = this.keep - 1;
    if (last < 1) {
      rmSync(this.path, { force: true });
      return;
    }
    rmSync(`${this.path}.${last}`, { force: true });
    for (let i = last - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    renameSync(this.path, `${this.path}.1`);
  }
}
