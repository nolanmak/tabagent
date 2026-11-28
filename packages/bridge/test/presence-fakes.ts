// Test-only presence providers. They exist only under test/ and are never bundled: the production
// daemon picks its provider from the platform alone (see approvals-presence.test.ts).
import { createHmac } from "node:crypto";
import type { PresenceProvider, PresenceRequest, PresenceResult } from "../src/approvals/presence";

export type FakeBehavior = "ok" | "cancel" | "forge" | "unavailable" | "hang";

export interface FakePresence extends PresenceProvider {
  calls: PresenceRequest[];
  /** Proofs handed back to the bridge (for replay tests). */
  macs: string[];
  behavior: FakeBehavior;
  /** Resolve a "hang" call. */
  release?: () => void;
}

/** Simulates the Swift helper: on "ok" it MACs the challenge message with the key the bridge gave it. */
export function fakePresence(behavior: FakeBehavior = "ok"): FakePresence {
  const f: FakePresence = {
    kind: "macos-localauthentication",
    calls: [],
    macs: [],
    behavior,
    async prove(r: PresenceRequest): Promise<PresenceResult> {
      f.calls.push(r);
      const b = f.behavior;
      if (b === "hang") await new Promise<void>((res) => (f.release = res));
      if (b === "ok" || b === "hang") {
        const mac = createHmac("sha256", r.key).update(r.message).digest("base64");
        f.macs.push(mac);
        return { ok: true, mac };
      }
      if (b === "forge") return { ok: true, mac: createHmac("sha256", "not-the-key").update(r.message).digest("base64") };
      if (b === "unavailable") return { ok: false, error: "unavailable", detail: "no biometrics or password set" };
      return { ok: false, error: "cancelled" };
    },
  };
  return f;
}
