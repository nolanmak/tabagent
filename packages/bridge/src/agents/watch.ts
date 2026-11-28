// Live chat entries (#151, spec §7a): while a chat page is open, the bridge polls that agent's transcript
// and pushes appended entries as `agent.entries`. Polling (stat every AGENT_WATCH_POLL_MS) rather than
// fs.watch, because it behaves the same on every platform and notices a replaced file. A truncated or
// replaced transcript, or a session that moved to a new transcript, is pushed as `reset`.
import { statSync } from "node:fs";
import { AGENT_WATCH_MAX, AGENT_WATCH_POLL_MS, type AgentEntries } from "@tabagent/protocol";
import { lineBoundary, readAppended } from "./transcript";

/** The transcript path for a listed agent, or null (not listed, no transcript, or not Claude). */
export type ResolveTranscript = (agentId: string) => Promise<string | null>;

export interface WatchOpts {
  resolve: ResolveTranscript;
  pollMs?: number;
  /** How often the path is resolved again (a `/clear` moves the session to a new transcript). */
  resolveMs?: number;
  max?: number;
}

interface Watch {
  agentId: string;
  send: (m: AgentEntries) => void;
  path: string | null;
  ino: number;
  offset: number;
  skipping: boolean;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
  lastResolve: number;
  stopped: boolean;
}

function stat(path: string): { ino: number; size: number } | null {
  try {
    const s = statSync(path);
    return s.isFile() ? { ino: s.ino, size: s.size } : null;
  } catch {
    return null;
  }
}

export class TranscriptWatchers {
  private watches = new Map<string, Watch>();
  private pollMs: number;
  private resolveMs: number;
  private max: number;

  constructor(private o: WatchOpts) {
    this.pollMs = o.pollMs ?? AGENT_WATCH_POLL_MS;
    this.resolveMs = o.resolveMs ?? 5_000;
    this.max = o.max ?? AGENT_WATCH_MAX;
  }

  get size(): number {
    return this.watches.size;
  }

  has(agentId: string): boolean {
    return this.watches.has(agentId);
  }

  /** Start pushing for this agent (again a no-op when already watched). False when over the cap. */
  async watch(agentId: string, send: (m: AgentEntries) => void): Promise<boolean> {
    const cur = this.watches.get(agentId);
    if (cur) {
      cur.send = send;
      return true;
    }
    if (this.watches.size >= this.max) return false;
    const w: Watch = { agentId, send, path: null, ino: 0, offset: 0, skipping: false, timer: undefined as never, busy: false, lastResolve: Date.now(), stopped: false };
    this.watches.set(agentId, w);
    w.path = await this.o.resolve(agentId).catch(() => null);
    if (w.stopped) return true;
    await this.startAt(w, w.path);
    if (w.stopped) return true;
    w.timer = setInterval(() => void this.tick(w), this.pollMs);
    w.timer.unref?.();
    return true;
  }

  unwatch(agentId: string) {
    const w = this.watches.get(agentId);
    if (!w) return;
    w.stopped = true;
    clearInterval(w.timer);
    this.watches.delete(agentId);
  }

  stopAll() {
    for (const id of [...this.watches.keys()]) this.unwatch(id);
  }

  /** Begin at the end of the last complete line, so only lines written from now on are pushed. */
  private async startAt(w: Watch, path: string | null) {
    w.path = path;
    w.skipping = false;
    const st = path ? stat(path) : null;
    w.ino = st?.ino ?? 0;
    w.offset = st && path ? await lineBoundary(path, st.size).catch(() => st.size) : 0;
  }

  /** One poll now (tests; the timer does the same). */
  async poll(agentId: string): Promise<void> {
    const w = this.watches.get(agentId);
    if (w) await this.tick(w);
  }

  private async tick(w: Watch): Promise<void> {
    if (w.busy || w.stopped) return;
    w.busy = true;
    try {
      await this.pollOnce(w);
    } finally {
      w.busy = false;
    }
  }

  private async pollOnce(w: Watch) {
    if (Date.now() - w.lastResolve >= this.resolveMs || !w.path) {
      w.lastResolve = Date.now();
      const path = await this.o.resolve(w.agentId).catch(() => null);
      if (w.stopped) return;
      if (path !== w.path) {
        // A new transcript (or the first one to appear): the page reloads history from it.
        await this.startAt(w, path);
        if (path) w.send({ type: "agent.entries", agentId: w.agentId, entries: [], reset: true });
        return;
      }
    }
    if (!w.path) return;
    const st = stat(w.path);
    if (!st) return;
    if (st.ino !== w.ino || st.size < w.offset) {
      // Replaced or truncated in place.
      w.ino = st.ino;
      w.offset = 0;
      w.skipping = false;
      w.offset = await lineBoundary(w.path, st.size).catch(() => st.size);
      if (!w.stopped) w.send({ type: "agent.entries", agentId: w.agentId, entries: [], reset: true });
      return;
    }
    if (st.size === w.offset) return;
    const r = await readAppended(w.path, w.offset, st.size, w.skipping).catch(() => null);
    if (!r || w.stopped) return;
    w.offset = r.next;
    w.skipping = r.skipping;
    if (r.entries.length) w.send({ type: "agent.entries", agentId: w.agentId, entries: r.entries });
  }
}
