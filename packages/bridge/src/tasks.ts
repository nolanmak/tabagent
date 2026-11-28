// #158 Timed tasks. Two parts:
//  - TaskLog: a reducer from audit lines (task.* events and records carrying taskId) to task summaries.
//    The bridge feeds it every line it writes; `tabagent tasks` feeds it the log files. One source of truth.
//  - TaskTracker: decides which task a session's call belongs to (explicit task.start, or an implicit task
//    split on idle time), and writes the task.* events. It never edits the log, only appends.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { redactText, TabAgentError, TASK_LIMITS, type TaskCall, type TaskOutcome, type TaskSummary } from "@tabagent/protocol";

/** A parsed audit.jsonl line: a tool record or an event. */
export interface AuditLine {
  ts?: string;
  event?: string;
  data?: Record<string, unknown>;
  caller?: string;
  session?: string;
  tool?: string;
  action?: string;
  origin?: string | null;
  outcome?: string;
  errorCode?: string;
  durationMs?: number;
  taskId?: string;
}

const ms = (iso: unknown, fallback = 0): number => {
  const n = typeof iso === "number" ? iso : Date.parse(String(iso));
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const OUTCOMES: readonly string[] = ["success", "failed", "abandoned", "unknown"];
const outcomeOf = (v: unknown): TaskOutcome => (OUTCOMES.includes(String(v)) ? (v as TaskOutcome) : "unknown");

export class TaskLog {
  private tasks = new Map<string, TaskSummary>();
  constructor(readonly max: number = TASK_LIMITS.tasks) {}

  /** Apply one audit line. Returns the task it changed, if any. */
  apply(l: AuditLine): TaskSummary | undefined {
    if (!l || typeof l !== "object") return;
    if (l.event) {
      const d = (l.data ?? {}) as Record<string, unknown>;
      const id = str(d.taskId);
      if (!id) return;
      switch (l.event) {
        case "task.started": {
          const at = ms(d.startedAt, ms(l.ts));
          const t: TaskSummary = {
            taskId: id,
            ...(str(d.session) ?? l.session ? { session: str(d.session) ?? l.session } : {}),
            ...(l.caller ? { caller: l.caller } : {}),
            goal: str(d.goal) ?? null,
            explicit: d.explicit === true,
            startedAt: at,
            outcome: null,
            callCount: 0,
            browserMs: 0,
            origins: [],
            lastAt: at,
            calls: [],
          };
          this.tasks.delete(id);
          this.tasks.set(id, t);
          this.evict();
          return t;
        }
        case "task.ended": {
          const t = this.tasks.get(id);
          if (!t) return;
          t.endedAt = ms(d.endedAt, ms(l.ts));
          t.durationMs = Math.max(0, t.endedAt - t.startedAt);
          t.outcome = outcomeOf(d.outcome);
          const note = str(d.note);
          if (note) t.note = note;
          return t;
        }
        case "task.labeled": {
          const t = this.tasks.get(id);
          if (!t) return;
          t.outcome = outcomeOf(d.outcome);
          t.labeled = true;
          return t;
        }
      }
      return;
    }
    if (!l.taskId || !l.tool) return;
    const end = ms(l.ts);
    const dur = typeof l.durationMs === "number" && l.durationMs >= 0 ? l.durationMs : undefined;
    let t = this.tasks.get(l.taskId);
    if (!t) {
      // Its task.started is in an older (rotated) file: keep the calls under an untitled task.
      t = { taskId: l.taskId, ...(l.session ? { session: l.session } : {}), ...(l.caller ? { caller: l.caller } : {}), goal: null, explicit: false, startedAt: end - (dur ?? 0), outcome: null, callCount: 0, browserMs: 0, origins: [], lastAt: end, calls: [] };
      this.tasks.set(l.taskId, t);
      this.evict();
    }
    const call: TaskCall = {
      ts: end - (dur ?? 0),
      tool: l.tool,
      ...(l.action ? { action: l.action } : {}),
      origin: l.origin ?? null,
      outcome: l.outcome === "error" || l.outcome === "denied" ? l.outcome : "ok",
      ...(l.errorCode ? { errorCode: l.errorCode } : {}),
      ...(dur !== undefined ? { durationMs: dur } : {}),
    };
    if (t.calls.length < TASK_LIMITS.calls) t.calls.push(call);
    t.callCount++;
    t.browserMs += dur ?? 0;
    t.lastAt = Math.max(t.lastAt, end);
    if (call.origin && !t.origins.includes(call.origin)) t.origins.push(call.origin);
    return t;
  }

  get(id: string): TaskSummary | undefined {
    return this.tasks.get(id);
  }

  /** Newest first. */
  list(limit = this.max): TaskSummary[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  openTasks(): TaskSummary[] {
    return [...this.tasks.values()].filter((t) => t.outcome === null && t.endedAt === undefined);
  }

  /** Drop the oldest ended tasks past `max` (open ones only when nothing else is left). */
  private evict() {
    while (this.tasks.size > this.max) {
      let victim: string | undefined;
      for (const [id, t] of this.tasks) if (t.endedAt !== undefined) { victim = id; break; }
      victim ??= this.tasks.keys().next().value;
      if (victim === undefined) return;
      this.tasks.delete(victim);
    }
  }
}

/** Parse JSONL text into lines, skipping anything malformed. */
export function parseAuditText(text: string): AuditLine[] {
  const out: AuditLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") out.push(v);
    } catch {
      /* torn or foreign line */
    }
  }
  return out;
}

/** Build a TaskLog from audit files, oldest first (audit.jsonl.N ... .1, audit.jsonl). Missing files are skipped. */
export function taskLogFromFiles(paths: string[], max = Number.MAX_SAFE_INTEGER): TaskLog {
  const log = new TaskLog(max);
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let text = "";
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const l of parseAuditText(text)) log.apply(l);
  }
  return log;
}

/** The live log and its rotations, oldest first. */
export function auditFiles(path: string, keep = 5): string[] {
  const out: string[] = [];
  for (let i = keep - 1; i >= 1; i--) out.push(`${path}.${i}`);
  out.push(path);
  return out;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
export interface TaskWho {
  caller: string;
  session?: string;
}

export interface TrackerOpts {
  log: TaskLog;
  /** Writes a task.* event; the writer feeds the line back into `log`. */
  event: (name: string, data: Record<string, unknown>, who?: TaskWho) => void;
  now?: () => number;
  /** Idle gap that ends an implicit task (read on every check, so a config reload applies). */
  idleMs?: () => number;
  explicitIdleMs?: () => number;
  newId?: () => string;
}

const newTaskId = () => "t-" + randomBytes(6).toString("hex");

export class TaskTracker {
  /** session id -> open task id */
  private open = new Map<string, string>();
  private now: () => number;
  private idleMs: () => number;
  private explicitIdleMs: () => number;
  private newId: () => string;

  constructor(private o: TrackerOpts) {
    this.now = o.now ?? Date.now;
    this.idleMs = o.idleMs ?? (() => TASK_LIMITS.idleMs);
    this.explicitIdleMs = o.explicitIdleMs ?? (() => TASK_LIMITS.explicitIdleMs);
    this.newId = o.newId ?? newTaskId;
  }

  get log(): TaskLog {
    return this.o.log;
  }

  /** The open task of a session, if any. */
  openTask(session: string): TaskSummary | undefined {
    const id = this.open.get(session);
    return id ? this.o.log.get(id) : undefined;
  }

  /**
   * The task id to stamp on a tool record about to be written for `who`. Opens an implicit task when the
   * session has none, and splits off a new one when the open task has gone idle. No session: no task.
   */
  stamp(who: TaskWho, rec: { tool?: unknown; durationMs?: unknown }): string | undefined {
    if (!who.session || typeof rec.tool !== "string" || rec.tool.startsWith("task.")) return;
    const now = this.now();
    const dur = typeof rec.durationMs === "number" && rec.durationMs >= 0 ? rec.durationMs : 0;
    const cur = this.openTask(who.session);
    // Idle is measured from the end of the last call to the start of this one.
    if (cur && this.idleExpired(cur, now - dur)) this.close(who.session, cur, cur.explicit ? "abandoned" : "unknown", cur.lastAt);
    const still = this.openTask(who.session);
    if (still) return still.taskId;
    return this.begin(who, null, false, now - dur);
  }

  /** task.start: end whatever is open (implicit -> unknown, explicit -> abandoned) and open an explicit task. */
  start(who: TaskWho, goal: string): { taskId: string } {
    if (!who.session) throw new TabAgentError("BAD_REQUEST", "task.start needs a session");
    const cur = this.openTask(who.session);
    const now = this.now();
    if (cur) this.close(who.session, cur, cur.explicit ? "abandoned" : "unknown", cur.callCount ? cur.lastAt : now);
    const g = redactText(goal, TASK_LIMITS.goal);
    if (!g) throw new TabAgentError("BAD_REQUEST", "task.start needs a goal");
    return { taskId: this.begin(who, g, true, now) };
  }

  /** task.end: close the session's open task (or the named one, which must be it). */
  end(who: TaskWho, p: { outcome: TaskOutcome; taskId?: string; note?: string }): { taskId: string; durationMs: number; callCount: number } {
    const cur = who.session ? this.openTask(who.session) : undefined;
    if (!cur || (p.taskId && p.taskId !== cur.taskId)) {
      throw new TabAgentError("NOT_FOUND", p.taskId ? `No open task ${p.taskId} in this session` : "This session has no open task", "Call task.start first.");
    }
    const t = this.close(who.session!, cur, p.outcome, this.now(), p.note);
    return { taskId: t.taskId, durationMs: t.durationMs ?? 0, callCount: t.callCount };
  }

  /** Side panel ✓/✗ on an ended task. */
  label(taskId: string, outcome: "success" | "failed"): "ok" | "NOT_FOUND" | "BAD_REQUEST" {
    const t = this.o.log.get(taskId);
    if (!t) return "NOT_FOUND";
    if (t.endedAt === undefined) return "BAD_REQUEST";
    this.o.event("task.labeled", { taskId, outcome }, { caller: "user", ...(t.session ? { session: t.session } : {}) });
    return "ok";
  }

  sessionEnded(session: string) {
    const cur = this.openTask(session);
    if (cur) this.close(session, cur, cur.explicit ? "abandoned" : "unknown", cur.callCount ? cur.lastAt : this.now());
  }

  /** Close tasks that have gone idle, so the panel shows them ended without waiting for the next call. */
  sweep(now = this.now()) {
    for (const [session, id] of [...this.open]) {
      const t = this.o.log.get(id);
      if (!t) this.open.delete(session);
      else if (this.idleExpired(t, now)) this.close(session, t, t.explicit ? "abandoned" : "unknown", t.lastAt);
    }
  }

  /** At startup: tasks a previous bridge run left open can never get more calls. End them at their last call. */
  recover() {
    for (const t of this.o.log.openTasks()) {
      this.o.event("task.ended", this.endData(t, t.explicit ? "abandoned" : "unknown", t.lastAt), { caller: "bridge", ...(t.session ? { session: t.session } : {}) });
    }
  }

  private idleExpired(t: TaskSummary, at: number): boolean {
    return at - t.lastAt > (t.explicit ? Math.max(this.explicitIdleMs(), this.idleMs()) : this.idleMs());
  }

  private begin(who: TaskWho, goal: string | null, explicit: boolean, at: number): string {
    const taskId = this.newId();
    this.open.set(who.session!, taskId);
    this.o.event("task.started", { taskId, session: who.session, goal, explicit, startedAt: new Date(at).toISOString() }, who);
    return taskId;
  }

  private close(session: string, t: TaskSummary, outcome: TaskOutcome, at: number, note?: string): TaskSummary {
    if (this.open.get(session) === t.taskId) this.open.delete(session);
    this.o.event("task.ended", this.endData(t, outcome, Math.max(at, t.startedAt), note), { caller: t.caller ?? "bridge", session });
    return this.o.log.get(t.taskId) ?? t;
  }

  private endData(t: TaskSummary, outcome: TaskOutcome, at: number, note?: string): Record<string, unknown> {
    const n = note ? redactText(note, TASK_LIMITS.note) : "";
    return {
      taskId: t.taskId,
      outcome,
      startedAt: new Date(t.startedAt).toISOString(),
      endedAt: new Date(at).toISOString(),
      durationMs: Math.max(0, at - t.startedAt),
      callCount: t.callCount,
      browserMs: t.browserMs,
      ...(n ? { note: n } : {}),
    };
  }
}
