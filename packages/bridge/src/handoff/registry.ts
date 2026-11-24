// #61 Part B: one-time links for remote handoffs.
//
// Each handoff gets an opaque id (128 bits) and a URL token (256 bits). Only SHA-256 hashes are kept.
// The URL token is claimed once, by the first browser that runs the page script; that browser gets a
// fresh cookie secret (also only kept hashed) and the URL token stops working. Everything about an
// entry ends at once when it is revoked: when the handoff ends in the extension, when its auth.handoff
// command is no longer in flight, at its expiry, on the kill switch, on disconnect and on bridge stop.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface HandoffEntry {
  id: string;
  commandId: string;
  /** Extension socket the handoff was opened on; frames and input go back over it only. */
  ws: unknown;
  origin: string;
  reason: string;
  sessionLabel: string;
  createdAt: number;
  expiresAt: number;
  claimed: boolean;
  tokenHash: Buffer;
  cookieHash: Buffer | null;
}

export interface CreateInfo {
  commandId: string;
  ws: unknown;
  origin: string;
  reason: string;
  sessionLabel: string;
  ttlMs: number;
}

export interface RegistryOpts {
  now?: () => number;
  /** False when the entry's command is gone: the entry is revoked on lookup. */
  alive?: (e: HandoffEntry) => boolean;
  /** Called with the number of entries after every create/revoke. */
  onChange?: (size: number) => void;
  onRevoke?: (e: HandoffEntry) => void;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const same = (a: Buffer | null, s: string) => !!a && typeof s === "string" && s.length > 0 && s.length < 200 && timingSafeEqual(a, sha(s));

export class HandoffRegistry {
  private entries = new Map<string, HandoffEntry>();
  private now: () => number;
  constructor(private o: RegistryOpts = {}) {
    this.now = o.now ?? Date.now;
  }

  get size() {
    return this.entries.size;
  }

  create(info: CreateInfo): { entry: HandoffEntry; token: string } {
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const entry: HandoffEntry = {
      id,
      commandId: info.commandId,
      ws: info.ws,
      origin: info.origin,
      reason: info.reason,
      sessionLabel: info.sessionLabel,
      createdAt: now,
      expiresAt: now + info.ttlMs,
      claimed: false,
      tokenHash: sha(token),
      cookieHash: null,
    };
    this.entries.set(id, entry);
    this.o.onChange?.(this.entries.size);
    return { entry, token };
  }

  /** The live entry, or undefined (revoking it when it expired or its command ended). */
  get(id: string): HandoffEntry | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (this.now() > e.expiresAt || (this.o.alive && !this.o.alive(e))) {
      this.revoke(id);
      return undefined;
    }
    return e;
  }

  byCommand(commandId: string): HandoffEntry | undefined {
    for (const e of this.entries.values()) if (e.commandId === commandId) return e;
    return undefined;
  }

  /** The URL token is valid only for its own handoff and only until claimed. */
  checkToken(id: string, token: string): HandoffEntry | null {
    const e = this.get(id);
    return e && !e.claimed && same(e.tokenHash, token) ? e : null;
  }

  /** One-time: swap the URL token for a cookie secret. Null when invalid or already claimed. */
  claim(id: string, token: string): string | null {
    const e = this.checkToken(id, token);
    if (!e) return null;
    const cookie = randomBytes(32).toString("base64url");
    e.claimed = true;
    e.cookieHash = sha(cookie);
    return cookie;
  }

  checkCookie(id: string, cookie: string): HandoffEntry | null {
    const e = this.get(id);
    return e && same(e.cookieHash, cookie) ? e : null;
  }

  revoke(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    e.cookieHash = null;
    e.claimed = true;
    this.o.onRevoke?.(e);
    this.o.onChange?.(this.entries.size);
    return true;
  }

  revokeWhere(pred: (e: HandoffEntry) => boolean): number {
    let n = 0;
    for (const e of [...this.entries.values()]) if (pred(e) && this.revoke(e.id)) n++;
    return n;
  }

  revokeAll(): number {
    return this.revokeWhere(() => true);
  }

  /** Drop entries whose command ended or that expired (no lookups needed). */
  sweep(): void {
    for (const id of [...this.entries.keys()]) this.get(id);
  }
}
