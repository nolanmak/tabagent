// Pure rules for agent discovery (spec AD3, AD10, §5): ids, vendor status maps, record parsing, merge.
// The process and socket I/O lives in discovery-service.ts and codex.ts.
import type { Agent, AgentStatus } from "@tabagent/protocol";
import { chooseRoute } from "./route";

/** An agent before linking and routing are known. `sessionId` (Claude) finds the transcript title; never on the wire. */
export type AgentBase = Omit<Agent, "linked" | "canDriveTab" | "delivery"> & { sessionId?: string };

export type ParsedAgentId = { vendor: "claude"; pid: number; startedAt: number } | { vendor: "codex"; threadId: string };

/** AD3: pid plus start time, because pids get reused and two live pids can share a sessionId. */
export function claudeAgentId(pid: number, startedAt: number): string {
  return `claude:${pid}:${startedAt}`;
}

/** AD3: the app-server `Thread.id` (UUIDv7). */
export function codexAgentId(threadId: string): string {
  return `codex:${threadId}`;
}

export function parseAgentId(id: string): ParsedAgentId | null {
  const c = /^claude:(\d+):(\d+)$/.exec(id);
  if (c) return { vendor: "claude", pid: Number(c[1]), startedAt: Number(c[2]) };
  const x = /^codex:(.+)$/.exec(id);
  if (x) return { vendor: "codex", threadId: x[1] };
  return null;
}

type Status = { status: AgentStatus; statusLabel?: string };

const CLAUDE_BUSY = new Set(["busy", "running", "working", "active"]);
const CLAUDE_IDLE = new Set(["idle"]);
const CLAUDE_DONE = new Set(["done", "completed", "finished", "stopped"]);
const CLAUDE_ERROR = new Set(["error", "failed"]);

/** Interactive sessions report `status` (busy/idle); background ones report `state` (running/done/...). */
export function claudeStatus(rec: { status?: unknown; state?: unknown }): Status {
  const raw = typeof rec.status === "string" ? rec.status : typeof rec.state === "string" ? rec.state : "";
  if (!raw || CLAUDE_IDLE.has(raw)) return { status: "idle" };
  if (raw === "busy" || raw === "running") return { status: "busy" };
  if (raw === "error") return { status: "error" };
  if (CLAUDE_ERROR.has(raw)) return { status: "error", statusLabel: raw };
  if (CLAUDE_DONE.has(raw)) return { status: "idle", statusLabel: raw };
  if (CLAUDE_BUSY.has(raw)) return { status: "busy", statusLabel: raw };
  return { status: "busy", statusLabel: raw };
}

/**
 * `claude agents --json` prints a JSON array of interactive and background sessions. Records without a
 * numeric pid and startedAt have no stable id (AD3) and are skipped. Throws when the output is not an array.
 */
export function parseClaudeAgents(stdout: string): AgentBase[] {
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data)) throw new Error("claude agents --json did not print an array");
  const out: AgentBase[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const { pid, startedAt } = rec;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (typeof startedAt !== "number" || !Number.isInteger(startedAt) || startedAt < 0) continue;
    out.push({
      id: claudeAgentId(pid, startedAt),
      vendor: "claude",
      name: typeof rec.name === "string" && rec.name ? rec.name : null,
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
      startedAt,
      pid,
      ...claudeStatus(rec),
      ...(typeof rec.sessionId === "string" && rec.sessionId ? { sessionId: rec.sessionId } : {}),
    });
  }
  return out;
}

/** AD10 status map. null = not listed (notLoaded, or no status at all). */
export function codexStatus(st: unknown): Status | null {
  const s = st && typeof st === "object" ? (st as { type?: unknown; activeFlags?: unknown }) : null;
  const type = typeof s?.type === "string" ? s.type : null;
  if (!type || type === "notLoaded") return null;
  if (type === "idle") return { status: "idle" };
  if (type === "systemError") return { status: "error", statusLabel: "systemError" };
  if (type === "active") {
    const flags = Array.isArray(s!.activeFlags) ? s!.activeFlags.filter((f): f is string => typeof f === "string") : [];
    return flags.length ? { status: "busy", statusLabel: flags.join(", ") } : { status: "busy" };
  }
  return { status: "busy", statusLabel: type };
}

/** One app-server Thread (from thread/read) to an agent; null when it is not listed. */
export function codexThreadToAgent(thread: unknown): AgentBase | null {
  if (!thread || typeof thread !== "object") return null;
  const t = thread as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return null;
  const st = codexStatus(t.status);
  if (!st) return null;
  return {
    id: codexAgentId(t.id),
    vendor: "codex",
    name: typeof t.name === "string" && t.name ? t.name : null,
    ...(typeof t.name === "string" && t.name ? { title: t.name } : {}),
    cwd: typeof t.cwd === "string" ? t.cwd : "",
    // createdAt is Unix seconds.
    startedAt: typeof t.createdAt === "number" ? t.createdAt * 1000 : 0,
    ...st,
  };
}

/** AD4: the live inbox stream an agent is linked through, as discovery needs it. */
export interface AgentLink {
  /** Glossary canDriveTab: the linked session's profile has page_* / act_* tools. */
  canDriveTab: boolean;
  /** AD9: the proxy reported `x-tabagent-channels: 1`. */
  channels: boolean;
}
export type LinkOf = (a: AgentBase) => AgentLink | null;

/** An agent with its link (null: not linked) and the route the bridge would pick now (AD6). */
export function toAgent(a: AgentBase, link: AgentLink | null = null): Agent {
  const { sessionId: _sessionId, ...rest } = a;
  const linked = !!link;
  // #137: the title falls back to the vendor name.
  const title = rest.title ?? rest.name ?? undefined;
  return { ...rest, ...(title ? { title } : {}), linked, canDriveTab: linked && link.canDriveTab, delivery: chooseRoute({ vendor: a.vendor, status: a.status, linked, channels: link?.channels }) };
}

/** Merge per-source lists: unique ids, newest first (stable for ties). `linkOf` marks linked agents. */
export function mergeAgents(lists: AgentBase[][], linkOf: LinkOf = () => null): Agent[] {
  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const list of lists)
    for (const a of list) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(toAgent(a, linkOf(a)));
    }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
