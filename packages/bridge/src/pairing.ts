// D4 pairing code: one-time, 30-minute TTL, 5 wrong attempts invalidate it. Clock is injectable.
import { PAIR_MAX_ATTEMPTS, TIMEOUTS } from "@tabagent/protocol";
import { newPairCode } from "./config";

export type PairCheck = "ok" | "wrong" | "expired" | "invalidated";

export class Pairing {
  code: string | null = null;
  expires = 0;
  private wrong = 0;
  constructor(private now: () => number = Date.now) {
    this.mint();
  }

  mint(): string {
    this.code = newPairCode();
    this.expires = this.now() + TIMEOUTS.pairCode;
    this.wrong = 0;
    return this.code;
  }

  /** Current code if still usable (for `tabagent status`). */
  current(): string | null {
    return this.code && this.now() < this.expires ? this.code : null;
  }

  static normalise(c: string): string {
    return c.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  }

  check(attempt: string): PairCheck {
    if (!this.code) return "invalidated";
    if (this.now() >= this.expires) {
      this.code = null;
      return "expired";
    }
    if (Pairing.normalise(attempt) === Pairing.normalise(this.code)) {
      this.code = null; // single use
      return "ok";
    }
    this.wrong++;
    if (this.wrong >= PAIR_MAX_ATTEMPTS) {
      this.code = null;
      return "invalidated";
    }
    return "wrong";
  }
}
