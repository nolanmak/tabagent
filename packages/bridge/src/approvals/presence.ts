// #108: proof of the user's presence before the bridge relays an answer to a permission prompt.
//
// The bridge itself runs the presence check: it issues a single-use challenge bound to one purpose and
// one binding (`<promptId>|<answer>`, or the phone-link request), hands the challenge message and a fresh
// random key to the provider, and accepts the result only as an HMAC of that message with that key. On
// macOS the provider is a small Swift helper that computes the HMAC only after LocalAuthentication
// (`deviceOwnerAuthentication`: Touch ID or the login password) succeeds. The key lives in bridge memory
// and on the helper's stdin pipe; it is never written anywhere, never accepted from a client, and is
// used up by the first verification attempt.
//
// What this does and does not prove is spelled out in docs/SECURITY.md (#108).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MacPresence } from "./presence-mac";

export type PresencePurpose = "answer" | "phone-link";

export interface PresenceRequest {
  /** Shown in the Touch ID / password dialog. */
  reason: string;
  /** The exact string to MAC on success. */
  message: string;
  /** Fresh 256-bit key for this challenge only. */
  key: Buffer;
  timeoutMs: number;
}

export type PresenceResult = { ok: true; mac: string } | { ok: false; error: "cancelled" | "failed" | "unavailable" | "timeout"; detail?: string };

export interface PresenceProvider {
  readonly kind: "macos-localauthentication" | "unsupported";
  prove(r: PresenceRequest): Promise<PresenceResult>;
}

export interface PresenceProof {
  challengeId: string;
  mac: string;
}

export type VerifyFailure = "missing" | "malformed" | "unknown" | "expired" | "replayed" | "mismatch" | "bad_mac";

interface Challenge {
  purpose: PresencePurpose;
  binding: string;
  message: string;
  key: Buffer;
  expiresAt: number;
  used: boolean;
}

export const PRESENCE_TTL_MS = 90_000;
const FORGET_AFTER_MS = 5 * 60_000;

export function presenceMessage(challengeId: string, nonce: string, purpose: PresencePurpose, binding: string): string {
  return `tabagent-presence-v1|${challengeId}|${nonce}|${purpose}|${binding}`;
}

export class PresenceGate {
  private challenges = new Map<string, Challenge>();
  private now: () => number;
  private ttlMs: number;

  constructor(o: { now?: () => number; ttlMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? PRESENCE_TTL_MS;
  }

  get size() {
    return this.challenges.size;
  }

  issue(purpose: PresencePurpose, binding: string): { challengeId: string; message: string; key: Buffer } {
    this.forget();
    const challengeId = randomBytes(16).toString("hex");
    const message = presenceMessage(challengeId, randomBytes(16).toString("base64url"), purpose, binding);
    const key = randomBytes(32);
    this.challenges.set(challengeId, { purpose, binding, message, key, expiresAt: this.now() + this.ttlMs, used: false });
    return { challengeId, message, key };
  }

  /** One attempt per challenge: whatever the result, the challenge is used up. */
  verify(proof: unknown, purpose: PresencePurpose, binding: string): { ok: true } | { ok: false; reason: VerifyFailure } {
    if (proof == null) return { ok: false, reason: "missing" };
    const p = proof as Partial<PresenceProof>;
    if (typeof proof !== "object" || typeof p.challengeId !== "string" || typeof p.mac !== "string" || !p.challengeId || !p.mac || p.mac.length > 200) return { ok: false, reason: "malformed" };
    const c = this.challenges.get(p.challengeId);
    if (!c) return { ok: false, reason: "unknown" };
    if (c.used) return { ok: false, reason: "replayed" };
    c.used = true;
    if (this.now() > c.expiresAt) return { ok: false, reason: "expired" };
    if (c.purpose !== purpose || c.binding !== binding) return { ok: false, reason: "mismatch" };
    const want = createHmac("sha256", c.key).update(c.message).digest();
    const got = Buffer.from(p.mac, "base64");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_mac" };
    return { ok: true };
  }

  private forget() {
    const now = this.now();
    for (const [id, c] of this.challenges) if (now - c.expiresAt > FORGET_AFTER_MS) this.challenges.delete(id);
  }
}

/** Linux, Windows and anything else: no LocalAuthentication, so no presence, so no outside CLI approvals. */
export class UnsupportedPresence implements PresenceProvider {
  readonly kind = "unsupported" as const;
  async prove(_r?: PresenceRequest): Promise<PresenceResult> {
    return { ok: false, error: "unavailable", detail: "TabAgent can check your presence only on macOS (Touch ID or your login password)" };
  }
}

/**
 * The production provider, chosen by platform alone. Deliberately takes no environment variable, flag
 * or config: nothing outside the process can swap in a provider that skips the check. Tests inject a
 * fake through the Daemon constructor, which no CLI command, config key or env var reaches.
 */
export function defaultPresenceProvider(platform: NodeJS.Platform = process.platform): PresenceProvider {
  return platform === "darwin" ? new MacPresence() : new UnsupportedPresence();
}
