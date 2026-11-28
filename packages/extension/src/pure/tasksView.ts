// #158 Side panel Tasks section: plain data in, HTML strings out. A task row shows the goal, caller, start time,
// total duration (live while open), call count, sites and outcome; opening it shows the call timeline with each
// call's duration and the gap before it, so browser time reads apart from agent thinking time.
import type { TaskCall, TaskSummary } from "@tabagent/protocol";
import { esc } from "./html";

/** "450ms", "4.2s", "38s", "1m 7s", "2h 5m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${(Math.floor(s * 10) / 10).toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const hostOf = (origin: string | null | undefined): string => {
  if (!origin) return "";
  try {
    return new URL(origin).hostname || origin;
  } catch {
    return origin;
  }
};

export type TaskBadge = "running" | "success" | "failed" | "abandoned" | "unlabeled";
const BADGE_TEXT: Record<TaskBadge, string> = { running: "Running", success: "✓ Done", failed: "✗ Failed", abandoned: "Abandoned", unlabeled: "Unlabeled" };

export interface TaskRowView {
  taskId: string;
  title: string;
  caller: string;
  startedAt: number;
  /** Wall-clock duration; for an open task, up to `now`. */
  durationMs: number;
  browserMs: number;
  /** Time between calls (agent thinking, user prompts). */
  betweenMs: number;
  callCount: number;
  sites: string[];
  badge: TaskBadge;
  running: boolean;
  /** Ended without a known outcome: offer ✓ / ✗. */
  canLabel: boolean;
  note?: string;
}

export function taskRowView(t: TaskSummary, now: number): TaskRowView {
  const running = t.outcome === null && t.endedAt === undefined;
  const durationMs = running ? Math.max(0, now - t.startedAt) : (t.durationMs ?? Math.max(0, (t.endedAt ?? t.lastAt) - t.startedAt));
  const sites = t.origins.map(hostOf).filter(Boolean);
  const badge: TaskBadge = running ? "running" : t.outcome === "success" || t.outcome === "failed" || t.outcome === "abandoned" ? t.outcome : "unlabeled";
  return {
    taskId: t.taskId,
    title: t.goal ?? `Untitled task${sites[0] ? ` · ${sites[0]}` : ""}`,
    caller: t.caller ?? "",
    startedAt: t.startedAt,
    durationMs,
    browserMs: t.browserMs,
    betweenMs: Math.max(0, durationMs - t.browserMs),
    callCount: t.callCount,
    sites,
    badge,
    running,
    canLabel: !running && badge === "unlabeled",
    ...(t.note ? { note: t.note } : {}),
  };
}

export interface TimelineRow {
  tool: string;
  site: string;
  outcome: TaskCall["outcome"];
  errorCode?: string;
  durationMs?: number;
  /** Gap since the previous call ended (or since the task started, for the first call). */
  gapMs: number;
  /** Offset from the task's start. */
  atMs: number;
}

export function timelineRows(t: TaskSummary): TimelineRow[] {
  let prevEnd = t.startedAt;
  return t.calls.map((c) => {
    const row: TimelineRow = {
      tool: c.action ? `${c.tool} ${c.action}` : c.tool,
      site: hostOf(c.origin),
      outcome: c.outcome,
      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
      ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
      gapMs: Math.max(0, c.ts - prevEnd),
      atMs: Math.max(0, c.ts - t.startedAt),
    };
    prevEnd = Math.max(prevEnd, c.ts + (c.durationMs ?? 0));
    return row;
  });
}

const clock = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** One task's list item; `open` adds the summary row and call timeline. */
export function taskItemHtml(t: TaskSummary, now: number, open: boolean): string {
  const v = taskRowView(t, now);
  const meta = [v.caller, `started ${clock(v.startedAt)}`, `${v.callCount} call${v.callCount === 1 ? "" : "s"}`, v.sites.slice(0, 3).join(", ")].filter(Boolean).map(esc).join(" · ");
  const dur = `<span class="task-dur${v.running ? " live" : ""}"${v.running ? ` data-started="${Number(v.startedAt)}"` : ""}>${esc(formatDuration(v.durationMs))}</span>`;
  const label = v.canLabel
    ? `<span class="task-label"><button data-task-label="success" data-task="${esc(v.taskId)}" title="It worked" aria-label="Mark task as done">✓</button><button data-task-label="failed" data-task="${esc(v.taskId)}" title="It did not work" aria-label="Mark task as failed">✗</button></span>`
    : "";
  let body = "";
  if (open) {
    const rows = timelineRows(t)
      .map(
        (r) =>
          `<li><span class="tl-at mono">+${esc(formatDuration(r.atMs))}</span><span class="tl-tool mono">${esc(r.tool)}</span><span class="tl-site muted">${esc(r.site)}</span><span class="tl-status ${esc(r.outcome)}">${esc(r.outcome)}${r.errorCode ? ` ${esc(r.errorCode)}` : ""}</span><span class="tl-dur">${r.durationMs !== undefined ? esc(formatDuration(r.durationMs)) : "—"}</span><span class="tl-gap muted" title="Time since the previous call">${r.gapMs >= 1000 ? `+${esc(formatDuration(r.gapMs))} wait` : ""}</span></li>`,
      )
      .join("");
    // The list sends calls only for the opened task, so they can be on their way.
    const loading = !t.calls.length && t.callCount > 0;
    const more = !loading && t.callCount > t.calls.length ? `<li class="muted small">…and ${t.callCount - t.calls.length} more calls</li>` : "";
    body = `<div class="task-detail"><p class="task-split small">In the browser ${esc(formatDuration(v.browserMs))} · between calls ${esc(formatDuration(v.betweenMs))} · total ${esc(formatDuration(v.durationMs))}</p>${v.note ? `<p class="muted small">${esc(v.note)}</p>` : ""}<ol class="task-timeline">${rows || (loading ? '<li class="empty">Loading calls…</li>' : '<li class="empty">No calls.</li>')}${more}</ol></div>`;
  }
  return `<li class="task${open ? " open" : ""}" data-task-id="${esc(v.taskId)}"><div class="task-row"><button class="task-toggle" data-task-toggle="${esc(v.taskId)}" aria-expanded="${open}"><span class="task-title">${esc(v.title)}</span><span class="task-meta muted small">${meta}</span></button>${dur}<span class="task-badge ${v.badge}">${esc(BADGE_TEXT[v.badge])}</span>${label}</div>${body}</li>`;
}

export function tasksHtml(tasks: TaskSummary[], now: number, openId: string | null): string {
  return tasks.map((t) => taskItemHtml(t, now, t.taskId === openId)).join("") || `<li class="empty">No tasks yet. Calls an agent makes are grouped into tasks here.</li>`;
}

/** Count badge and short summary while the section is closed. */
export function tasksSummary(tasks: TaskSummary[]): { count: string; meta: string } {
  const running = tasks.filter((t) => t.outcome === null && t.endedAt === undefined).length;
  const toLabel = tasks.filter((t) => t.endedAt !== undefined && (t.outcome === "unknown" || t.outcome === null)).length;
  return { count: tasks.length ? String(tasks.length) : "", meta: running ? `${running} running` : toLabel ? `${toLabel} to label` : "" };
}

/** Re-render the running timers each second without re-listing. */
export function liveDurationText(startedAt: number, now: number): string {
  return formatDuration(Math.max(0, now - startedAt));
}
