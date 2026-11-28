// #108: the bridge's copy of the extension's pending prompts, replaced on every `prompts.sync`. It is a
// view for `tabagent approve` and the phone page; the extension alone decides and applies answers.
import type { MirroredPrompt, PromptsSync } from "@tabagent/protocol";

const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 200;

export class PendingPrompts {
  private prompts = new Map<string, MirroredPrompt>();
  private recent = new Map<string, number>();
  enabled = false;

  constructor(private now: () => number = Date.now) {}

  get size() {
    return this.list().length;
  }

  sync(m: PromptsSync): { added: string[]; removed: string[] } {
    const next = new Map<string, MirroredPrompt>();
    this.enabled = m.enabled;
    if (m.enabled) for (const p of m.prompts) next.set(p.promptId, structuredClone(p));
    const added = [...next.keys()].filter((id) => !this.prompts.has(id));
    const removed = [...this.prompts.keys()].filter((id) => !next.has(id));
    const t = this.now();
    for (const id of removed) this.recent.set(id, t);
    this.prompts = next;
    this.prune();
    return { added, removed };
  }

  /** The extension went away: its prompts are no longer answerable here. `enabled` is kept until it says otherwise. */
  clear() {
    this.prompts = new Map();
  }

  list(): MirroredPrompt[] {
    const t = this.now();
    return [...this.prompts.values()].filter((p) => t < p.expires).map((p) => structuredClone(p));
  }

  get(id: string): MirroredPrompt | undefined {
    const p = this.prompts.get(id);
    return p && this.now() < p.expires ? structuredClone(p) : undefined;
  }

  /** Still listed but past its expiry. */
  expired(id: string): boolean {
    const p = this.prompts.get(id);
    return !!p && this.now() >= p.expires;
  }

  /** Was pending a moment ago (answered, timed out or dropped since). */
  recentlyResolved(id: string): boolean {
    this.prune();
    return this.recent.has(id);
  }

  private prune() {
    const t = this.now();
    for (const [id, at] of this.recent) if (t - at > RECENT_MS) this.recent.delete(id);
    while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value!);
  }
}
