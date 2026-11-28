// AD8 piggyback hold queue: up to 3 messages per linked session, FIFO, in memory only, 30 min TTL.
// A daemon restart loses them (stop() clears the timers without reporting).
import { PIGGYBACK_LIMITS } from "@tabagent/protocol";

export interface HeldMessage {
  requestId: string;
  /** The composed text, starting with the `[TabAgent: message ...]` header. */
  text: string;
}

export interface HoldOpts<T> {
  max?: number;
  ttlMs?: number;
  now?: () => number;
  onExpire: (m: T, reason: string) => void;
}

interface Slot<T> {
  m: T;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

export class HoldQueue<T extends HeldMessage> {
  readonly max: number;
  readonly ttlMs: number;
  private now: () => number;
  private q = new Map<string, Slot<T>[]>();
  /** Original deadlines, so a restored message keeps its TTL. */
  private deadlines = new WeakMap<T, number>();

  constructor(private o: HoldOpts<T>) {
    this.max = o.max ?? PIGGYBACK_LIMITS.maxHeld;
    this.ttlMs = o.ttlMs ?? PIGGYBACK_LIMITS.ttlMs;
    this.now = o.now ?? Date.now;
  }

  private get ttlText() {
    const t = this.ttlMs >= 60_000 ? `${Math.round(this.ttlMs / 60_000)} min` : `${Math.round(this.ttlMs / 1000)} s`;
    return `Not delivered within ${t} (no successful tool call from the agent)`;
  }

  private slot(key: string, m: T, deadline: number): Slot<T> {
    const timer = setTimeout(() => this.expireOne(key, m), Math.max(0, deadline - this.now()));
    timer.unref?.();
    return { m, deadline, timer };
  }

  private expireOne(key: string, m: T) {
    const list = this.q.get(key);
    const i = list?.findIndex((s) => s.m === m) ?? -1;
    if (!list || i < 0) return;
    clearTimeout(list[i].timer);
    list.splice(i, 1);
    if (!list.length) this.q.delete(key);
    this.o.onExpire(m, this.ttlText);
  }

  count(key: string): number {
    return this.q.get(key)?.length ?? 0;
  }

  /** "full" when the session already holds `max` messages (the send fails with QUEUE_FULL). */
  hold(key: string, m: T): "held" | "full" {
    const list = this.q.get(key) ?? [];
    if (list.length >= this.max) return "full";
    const deadline = this.now() + this.ttlMs;
    this.deadlines.set(m, deadline);
    list.push(this.slot(key, m, deadline));
    this.q.set(key, list);
    return "held";
  }

  /** Hand out everything held for the session, oldest first. Anything past its TTL expires instead. */
  take(key: string): T[] {
    const list = this.q.get(key);
    if (!list) return [];
    this.q.delete(key);
    const now = this.now();
    const out: T[] = [];
    for (const s of list) {
      clearTimeout(s.timer);
      if (now >= s.deadline) this.o.onExpire(s.m, this.ttlText);
      else out.push(s.m);
    }
    return out;
  }

  /** Put taken messages back at the front (the response carrying them was never written). Deadlines are kept. */
  restore(key: string, ms: T[]) {
    const now = this.now();
    const back: Slot<T>[] = [];
    for (const m of ms) {
      const deadline = this.deadlines.get(m) ?? now + this.ttlMs;
      if (now >= deadline) this.o.onExpire(m, this.ttlText);
      else back.push(this.slot(key, m, deadline));
    }
    if (!back.length) return;
    this.q.set(key, [...back, ...(this.q.get(key) ?? [])]);
  }

  /** Expire everything held for the session (session end, stream gone, replaced by spawn). */
  drop(key: string, reason: string) {
    const list = this.q.get(key);
    if (!list) return;
    this.q.delete(key);
    for (const s of list) {
      clearTimeout(s.timer);
      this.o.onExpire(s.m, reason);
    }
  }

  stop() {
    for (const list of this.q.values()) for (const s of list) clearTimeout(s.timer);
    this.q.clear();
  }
}
