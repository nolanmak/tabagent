// Bitwarden provider through the `bw` CLI (#37; its decisions win over #33's Bitwarden lines).
//
// - TabAgent has its own CLI state: BITWARDENCLI_APPDATA_DIR=<TABAGENT_HOME>/bitwarden.
// - The session key lives only in this object's memory. It arrives through the admin route from
//   `tabagent bitwarden unlock` (the user types the master password into `bw` directly), and is dropped
//   on idle (30 min since the last secret fetch), the hard cap (8 h), kill, lock and daemon exit. Every
//   drop also runs `bw lock` so the key is dead, not just forgotten.
// - Every call: `--nointeraction --response`, stdin closed, BW_SESSION only in that child's env, one at
//   a time, 15s timeout. Results are classified from the --response envelope and `bw status` only.
// - `bw list items` prints whole items (passwords, TOTP seeds). The output is parsed and immediately
//   projected into a strict metadata record; the raw text is dropped. Secrets for a fill are fetched
//   only after consent with `bw get`.
import { z } from "zod";
import {
  accountId,
  itemOnDomain,
  LOCAL_ID_RE,
  maskAccount,
  TabAgentError,
  URI_MATCH_TYPES,
  uriMatchFromBitwarden,
  type AuthAccount,
  type ProviderStatus,
  type TotpState,
} from "@tabagent/protocol";
import { CliMissing, CLI_TIMEOUT_MS, nodeRunner, SerialQueue, versionAtLeast, type Runner } from "./exec";
import type { KeyStore } from "./keychain";
import type { BridgeProvider, SecretRequestField } from "./provider";

/**
 * Earliest `bw` assumed to support `--nointeraction`, `--response` and to emit `fido2Credentials` on
 * items. Provisional (#37 †): confirm when real fixtures are recorded.
 */
export const MIN_BW_VERSION = "2024.2.0";
export const SYNC_EVERY_MS = 30 * 60_000;
export const MISS_SYNC_EVERY_MS = 5 * 60_000;

export const BW_HINTS = {
  missing: "Bitwarden CLI not found: ask the user to install it (`brew install bitwarden-cli`) and run `tabagent bitwarden enable`.",
  "old-version": `Bitwarden CLI is too old: ask the user to update it to ${MIN_BW_VERSION} or later.`,
  "logged-out": "Bitwarden is logged out: ask the user to run `tabagent bitwarden login`, then `tabagent bitwarden unlock`.",
  locked: "Bitwarden is locked: ask the user to run `tabagent bitwarden unlock`.",
  disabled: "Bitwarden is off: the user can turn it on with `tabagent bitwarden enable`.",
} as const;

/** The only things kept from an item. Strict: any extra key is a bug. */
export const BwMetaSchema = z.strictObject({
  id: z.string().regex(LOCAL_ID_RE),
  accountMasked: z.string(),
  uris: z.array(z.strictObject({ uri: z.string(), match: z.enum(URI_MATCH_TYPES).nullable() })),
  hasTotp: z.boolean(),
  passkeyOnly: z.boolean(),
  reprompt: z.boolean(),
  deleted: z.boolean(),
});
export type BwMeta = z.infer<typeof BwMetaSchema>;
export const BW_META_KEYS = ["id", "accountMasked", "uris", "hasTotp", "passkeyOnly", "reprompt", "deleted"].sort();

/** Project one raw `bw list items` item. Reads only the fields named here; the rest is never copied. */
export function projectItem(raw: unknown): BwMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  if (it.type !== 1 || typeof it.id !== "string" || !LOCAL_ID_RE.test(it.id)) return null;
  const login = (it.login && typeof it.login === "object" ? it.login : {}) as Record<string, unknown>;
  const uris = (Array.isArray(login.uris) ? login.uris : [])
    .slice(0, 50)
    .map((u) => (u && typeof u === "object" ? (u as Record<string, unknown>) : {}))
    .filter((u) => typeof u.uri === "string" && u.uri.length <= 2048)
    .map((u) => ({ uri: u.uri as string, match: uriMatchFromBitwarden(typeof u.match === "number" ? u.match : null) }));
  const hasPassword = typeof login.password === "string" && login.password.length > 0;
  const passkeys = Array.isArray(login.fido2Credentials) && login.fido2Credentials.length > 0;
  return BwMetaSchema.parse({
    id: it.id,
    accountMasked: maskAccount(typeof login.username === "string" ? login.username : ""),
    uris,
    hasTotp: typeof login.totp === "string" && login.totp.length > 0,
    passkeyOnly: passkeys && !hasPassword,
    reprompt: it.reprompt === 1,
    deleted: it.deletedDate !== null && it.deletedDate !== undefined,
  });
}

interface Envelope {
  success: boolean;
  data?: unknown;
}
function envelope(stdout: string): Envelope {
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j === "object" && typeof j.success === "boolean") return j as Envelope;
  } catch {
    /* fall through */
  }
  throw new TabAgentError("INTERNAL", "Unreadable output from the Bitwarden CLI");
}

export type BwRawStatus = "unauthenticated" | "locked" | "unlocked";

export interface BitwardenOpts {
  bin?: string;
  dataDir: string;
  runner?: Runner;
  now?: () => number;
  enabled: () => boolean;
  idleLockMs?: number;
  maxUnlockMs?: number;
  /** Opt-in: keep the session key across bridge restarts (`auth.bitwarden.rememberUnlock`). */
  remember?: () => boolean;
  keyStore?: KeyStore;
  /** For tests: the wait between restore retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Audit hook for unlock/lock events (never carries key material). */
  event?: (event: string, data: Record<string, unknown>) => void;
}

const RESTORE_TRIES = 3;

export class BitwardenProvider implements BridgeProvider {
  readonly name = "bitwarden" as const;
  private key: string | null = null;
  private unlockedAt = 0;
  private lastFetch = 0;
  private lastSync = 0;
  private lastMissSync = -Infinity;
  private unknownSynced = false;
  private cache = new Map<string, BwMeta>();
  private totp: TotpState = "unknown";
  private queue = new SerialQueue();
  private runner: Runner;
  private now: () => number;
  readonly idleLockMs: number;
  readonly maxUnlockMs: number;

  constructor(private o: BitwardenOpts) {
    this.runner = o.runner ?? nodeRunner();
    this.now = o.now ?? Date.now;
    this.idleLockMs = o.idleLockMs ?? 30 * 60_000;
    this.maxUnlockMs = o.maxUnlockMs ?? 8 * 3_600_000;
  }

  get bin() {
    return this.o.bin ?? "bw";
  }
  get unlocked() {
    return this.key !== null;
  }
  /** For tests: the metadata cache (never secrets). */
  cachedItems(): BwMeta[] {
    return [...this.cache.values()];
  }

  private lockedError() {
    return new TabAgentError("NOT_FOUND", "Bitwarden is locked", BW_HINTS.locked);
  }

  private bw(args: string[], withKey: boolean) {
    const key = withKey ? this.key : null;
    if (withKey && !key) return Promise.reject(this.lockedError());
    return this.queue.run(() =>
      this.runner.run(this.bin, [...args, "--nointeraction", "--response"], {
        timeoutMs: CLI_TIMEOUT_MS,
        env: { BITWARDENCLI_APPDATA_DIR: this.o.dataDir, ...(key ? { BW_SESSION: key } : {}) },
      }),
    );
  }

  private get remembering() {
    return !!this.o.keyStore && !!this.o.remember?.();
  }

  /**
   * #37 startup: forget any inherited BW_SESSION and make sure TabAgent's CLI state is locked,
   * unless the user opted into rememberUnlock and the saved key still unlocks the vault.
   */
  async startup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    delete env.BW_SESSION;
    if (!this.o.enabled()) return;
    if (this.remembering) {
      const saved = await this.o.keyStore!.load().catch(() => null);
      if (saved) {
        // A slow or failed `bw status` is not a rejection: retry, and only discard the key when
        // Bitwarden says locked/unauthenticated. On repeated errors keep it (no `bw lock`, which would
        // invalidate it) and stay locked; the next start tries again.
        const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let state: BwRawStatus | "error" = "error";
        for (let i = 0; i < RESTORE_TRIES && state === "error"; i++) {
          if (i > 0) await sleep(1000 * i);
          state = await this.rawStatus(saved).catch(() => "error" as const);
        }
        if (state === "unlocked") {
          this.key = saved;
          this.unlockedAt = this.lastFetch = this.now();
          this.o.event?.("bitwarden.unlocked", { restored: true });
          await this.sync().catch(() => {});
          return;
        }
        if (state === "error") {
          this.o.event?.("bitwarden.restore_failed", {});
          return;
        }
      }
    }
    await this.o.keyStore?.clear().catch(() => {});
    await this.bw(["lock"], false).catch(() => {});
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.bw(["--version"], false);
      const m = r.stdout.match(/\d+\.\d+\.\d+/);
      return r.code === 0 && m ? m[0] : null;
    } catch (e) {
      if (e instanceof CliMissing) return null;
      throw e;
    }
  }

  /** `bw status` → state, from the envelope only. With the held key when we have one. */
  async rawStatus(key: string | null = this.key): Promise<BwRawStatus> {
    const r = await this.queue.run(() =>
      this.runner.run(this.bin, ["status", "--nointeraction", "--response"], {
        timeoutMs: CLI_TIMEOUT_MS,
        env: { BITWARDENCLI_APPDATA_DIR: this.o.dataDir, ...(key ? { BW_SESSION: key } : {}) },
      }),
    );
    const env = envelope(r.stdout);
    const s = (env.data as { template?: { status?: unknown } } | undefined)?.template?.status;
    if (s === "unauthenticated" || s === "locked" || s === "unlocked") return s;
    throw new TabAgentError("INTERNAL", "Unreadable output from the Bitwarden CLI");
  }

  async status(): Promise<ProviderStatus> {
    if (!this.o.enabled()) return { name: this.name, state: "disabled", hint: BW_HINTS.disabled };
    await this.tick();
    if (this.key) return { name: this.name, state: "unlocked", totp: this.totp };
    const v = await this.version();
    if (!v) return { name: this.name, state: "missing", hint: BW_HINTS.missing };
    if (!versionAtLeast(v, MIN_BW_VERSION)) return { name: this.name, state: "old-version", hint: BW_HINTS["old-version"] };
    const s = await this.rawStatus(null).catch(() => "locked" as const);
    return s === "unauthenticated" ? { name: this.name, state: "logged-out", hint: BW_HINTS["logged-out"] } : { name: this.name, state: "locked", hint: BW_HINTS.locked };
  }

  /** Admin route: accept a session key from `tabagent bitwarden unlock`, after checking it with `bw status`. */
  async setSession(key: string): Promise<void> {
    if (!this.o.enabled()) throw new TabAgentError("PERMISSION_DENIED", "The Bitwarden provider is not enabled", BW_HINTS.disabled);
    if (!/^[A-Za-z0-9+/=_-]{16,512}$/.test(key)) throw new TabAgentError("BAD_REQUEST", "That is not a Bitwarden session key");
    const s = await this.rawStatus(key);
    if (s !== "unlocked") throw new TabAgentError("BAD_REQUEST", "Bitwarden rejected that session key");
    if (this.key) await this.drop("replaced");
    this.key = key;
    this.unlockedAt = this.lastFetch = this.now();
    this.totp = "unknown";
    this.unknownSynced = false;
    this.o.event?.("bitwarden.unlocked", {});
    if (this.remembering) await this.o.keyStore!.save(key).catch(() => {});
    await this.sync().catch(() => {});
  }

  /** Drop the key and kill it with `bw lock`. Queued calls fail NOT_FOUND with the locked hint. */
  async drop(reason: string): Promise<void> {
    const had = this.key !== null;
    this.key = null;
    this.cache.clear();
    this.totp = "unknown";
    this.queue.drop(() => this.lockedError());
    // rememberUnlock: a bridge exit keeps the saved key valid (no `bw lock`) so the next start can
    // restore it. Every other reason (lock, kill, idle, cap, rejected) forgets it for good.
    if (reason === "daemon-exit" && this.remembering) return;
    if (had) this.o.event?.("bitwarden.locked", { reason });
    await this.o.keyStore?.clear().catch(() => {});
    if (had || reason === "lock") await this.bw(["lock"], false).catch(() => {});
  }

  /** Lifetime checks (idle, hard cap) and the 30-minute sync. Called on every use and by a timer. */
  async tick(): Promise<void> {
    if (!this.key) return;
    const now = this.now();
    if (now - this.unlockedAt >= this.maxUnlockMs) return this.drop("max-unlock");
    if (now - this.lastFetch >= this.idleLockMs) return this.drop("idle");
    if (now - this.lastSync >= SYNC_EVERY_MS) await this.sync().catch(() => {});
  }

  /** Session rejected mid-call → drop, answer as locked, no retry loop. */
  private async checkSession(): Promise<void> {
    const s = await this.rawStatus().catch(() => "locked" as const);
    if (s !== "unlocked") {
      await this.drop("session-rejected");
      throw this.lockedError();
    }
  }

  async sync(): Promise<void> {
    if (!this.key) throw this.lockedError();
    // `bw list` only reads the CLI's local copy; pull from the server first so logins added or
    // imported after `tabagent bitwarden login` show up. Offline or a failed pull: list what we have.
    await this.bw(["sync"], true).catch(() => null);
    const r = await this.bw(["list", "items"], true);
    let env: Envelope;
    try {
      env = envelope(r.stdout);
    } catch (e) {
      await this.checkSession();
      throw e;
    }
    if (!env.success) {
      await this.checkSession();
      throw new TabAgentError("INTERNAL", "The Bitwarden CLI could not list items");
    }
    const list = (env.data as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(list)) throw new TabAgentError("INTERNAL", "Unreadable output from the Bitwarden CLI");
    const next = new Map<string, BwMeta>();
    for (const raw of list) {
      const m = projectItem(raw);
      if (m && !m.deleted) next.set(m.id, m);
    }
    this.cache = next;
    this.lastSync = this.now();
  }

  private candidates(origin: string): BwMeta[] {
    return [...this.cache.values()].filter((m) => !m.deleted && itemOnDomain(m.uris, origin));
  }

  async find(origin: string): Promise<AuthAccount[]> {
    if (!this.o.enabled()) return [];
    await this.tick();
    if (!this.key) {
      const st = await this.status();
      throw new TabAgentError("NOT_FOUND", `Bitwarden is ${st.state}`, st.hint);
    }
    let c = this.candidates(origin);
    if (c.length === 0 && this.now() - this.lastMissSync >= MISS_SYNC_EVERY_MS) {
      this.lastMissSync = this.now();
      await this.sync().catch(() => {});
      c = this.candidates(origin);
    }
    return c.map((m) => ({
      id: accountId(this.name, m.id),
      provider: this.name,
      accountMasked: m.accountMasked,
      hasTotp: m.hasTotp,
      passkeyOnly: m.passkeyOnly,
      reprompt: m.reprompt,
      uris: m.uris,
    }));
  }

  /** auth.login said `next: unknown` with the form still there: maybe the password changed; sync once. */
  noteLoginUnknown(): void {
    if (!this.key || this.unknownSynced) return;
    this.unknownSynced = true;
    void this.sync().catch(() => {});
  }

  get totpState(): TotpState {
    return this.totp;
  }

  async secret(localId: string, field: SecretRequestField): Promise<string> {
    await this.tick();
    if (!this.key) throw this.lockedError();
    const m = this.cache.get(localId);
    if (!m) throw new TabAgentError("NOT_FOUND", "No such Bitwarden item for this site");
    if (m.passkeyOnly || m.reprompt) throw new TabAgentError("PERMISSION_DENIED", "This Bitwarden item needs the user (passkey or master-password re-prompt)", "Use auth.handoff.");
    if (field === "totp" && !m.hasTotp) throw new TabAgentError("NOT_FOUND", "This Bitwarden item has no TOTP");
    if (field === "totp" && this.totp === "plan-required") throw new TabAgentError("NOT_FOUND", "Bitwarden TOTP needs a Premium plan");
    const r = await this.bw(["get", field, localId], true);
    let env: Envelope;
    try {
      env = envelope(r.stdout);
    } catch (e) {
      await this.checkSession();
      throw e;
    }
    const value = (env.data as { data?: unknown } | undefined)?.data;
    if (env.success && typeof value === "string" && value.length > 0) {
      this.lastFetch = this.now(); // only secret fetches reset the idle timer
      if (field === "totp") this.totp = "available";
      return value;
    }
    await this.checkSession();
    if (field === "totp") {
      // Unlocked, item has a TOTP, and `get totp` still failed: the account can't generate codes (†).
      this.totp = "plan-required";
      throw new TabAgentError("NOT_FOUND", "Bitwarden TOTP needs a Premium plan");
    }
    throw new TabAgentError("NOT_FOUND", `Could not read the ${field} from Bitwarden`);
  }
}
