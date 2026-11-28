// Remote Control (#151). A Claude Code session started with `--remote-control` records its
// `bridgeSessionId` in `~/.claude/sessions/<pid>.json`; `https://claude.ai/code/<bridgeSessionId>` is Claude's
// own browser UI for that live session. Only `<pid>.json` is read, and only its pid, startedAt and
// bridgeSessionId fields are used: never the `.key` files or the messaging socket (out of scope, #151).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { remoteControlUrl } from "@tabagent/protocol";

/** Session records are a few hundred bytes; anything bigger is not one. */
const RECORD_MAX = 64 * 1024;
const CACHE_MAX = 500;

/** $TABAGENT_CLAUDE_SESSIONS_DIR (tests), else $CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions. */
export function defaultClaudeSessionsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.TABAGENT_CLAUDE_SESSIONS_DIR) return env.TABAGENT_CLAUDE_SESSIONS_DIR;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, "sessions");
  return join(home, ".claude", "sessions");
}

/**
 * The Remote Control URL in one session record, or null. The record must be for this pid and, when it says,
 * this start time: a reused pid's stale record never lends its URL to another session. Pure.
 */
export function parseSessionRecord(text: string, pid: number, startedAt: number): string | null {
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;
  const r = rec as { pid?: unknown; startedAt?: unknown; bridgeSessionId?: unknown };
  if (r.pid !== undefined && r.pid !== pid) return null;
  if (typeof r.startedAt === "number" && r.startedAt !== startedAt) return null;
  return remoteControlUrl(r.bridgeSessionId);
}

/** Remote Control URLs per session, re-read only when the record's size or mtime changes. */
export class RemoteControlReader {
  readonly sessionsDir: string;
  private cache = new Map<string, { size: number; mtimeMs: number; url: string | null }>();

  constructor(o: { sessionsDir?: string } = {}) {
    this.sessionsDir = o.sessionsDir ?? defaultClaudeSessionsDir();
  }

  urlFor(pid: number | undefined, startedAt: number): string | null {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
    const path = join(this.sessionsDir, `${pid}.json`);
    let st;
    try {
      st = statSync(path);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > RECORD_MAX) return null;
    const key = `${path}\n${startedAt}`;
    const hit = this.cache.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.url;
    let url: string | null = null;
    try {
      url = parseSessionRecord(readFileSync(path, "utf8"), pid, startedAt);
    } catch {
      url = null;
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, url });
    return url;
  }
}
