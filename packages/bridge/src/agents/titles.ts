// Readable Claude session titles (#137, spec §5). Claude Code writes each session's transcript to
// `<projects>/<cwd slug>/<sessionId>.jsonl` and repeats title entries in it:
//   {"type":"ai-title","aiTitle":"Pending user input check","sessionId":"…"}
//   {"type":"custom-title","customTitle":"my rename","sessionId":"…"}   (the user renamed the session)
// Only the last 256 KB of the file is read, and only title entries are parsed; message content is never
// used. The parsing rules are pure; the file reads are the thin adapter at the bottom.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bounded tail read. Claude repeats title entries through the transcript, so the tail normally has one. */
export const TITLE_TAIL_BYTES = 256 * 1024;
/** Longest title shown; longer ones are cut with an ellipsis. */
export const TITLE_MAX = 200;
/** Title entries are short; longer lines are message content and are skipped without parsing. */
const TITLE_LINE_MAX = 4096;
const SLUG_MAX = 200;

export interface TranscriptTitles {
  customTitle?: string;
  aiTitle?: string;
}

/**
 * Claude Code's project folder name for a cwd: every non-alphanumeric character becomes `-` (verified in
 * claude 2.1.x). Claude appends a hash to slugs over 200 characters; transcriptPath() then finds the file
 * by session id instead.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Session ids become a file name, so only plain ids are accepted (no separators, no traversal). */
export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(id);
}

function cleanTitle(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + "…" : s;
}

/**
 * The last `custom-title` and last `ai-title` in a transcript tail. `partial`: the tail started mid-file,
 * so its first line is a fragment and is dropped. Only lines whose parsed `type` is a title type count, so
 * a title quoted inside message content is never picked up.
 */
export function parseTranscriptTitles(tail: string, o: { partial?: boolean } = {}): TranscriptTitles {
  const lines = tail.split("\n");
  if (o.partial) lines.shift();
  const out: TranscriptTitles = {};
  for (const line of lines) {
    if (line.length > TITLE_LINE_MAX || !line.includes("-title")) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    const r = rec as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
    if (r.type === "custom-title") {
      const t = cleanTitle(r.customTitle);
      if (t) out.customTitle = t;
    } else if (r.type === "ai-title") {
      const t = cleanTitle(r.aiTitle);
      if (t) out.aiTitle = t;
    }
  }
  return out;
}

/** #137: the user's rename, else Claude's generated title, else the vendor name, else null. */
export function pickTitle(t: TranscriptTitles, name: string | null): string | null {
  return cleanTitle(t.customTitle) ?? cleanTitle(t.aiTitle) ?? cleanTitle(name) ?? null;
}

/** $TABAGENT_CLAUDE_PROJECTS_DIR (tests), else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.TABAGENT_CLAUDE_PROJECTS_DIR) return env.TABAGENT_CLAUDE_PROJECTS_DIR;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, "projects");
  return join(home, ".claude", "projects");
}

// ---------------------------------------------------------------------------
// File adapter
// ---------------------------------------------------------------------------

/** The last `maxBytes` of a file; `partial` when the file is longer. null when it cannot be read. */
export function readTail(path: string, maxBytes: number): { text: string; partial: boolean } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    return { text: buf.subarray(0, n).toString("utf8"), partial: size > len };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The transcript for a session: by cwd slug first, then any project folder holding `<sessionId>.jsonl`. */
export function transcriptPath(projectsDir: string, cwd: string, sessionId: string): string | null {
  if (!validSessionId(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  const slug = claudeProjectSlug(cwd);
  if (slug.length <= SLUG_MAX) {
    const direct = join(projectsDir, slug, file);
    if (isFile(direct)) return direct;
  }
  if (!existsSync(projectsDir)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, file);
    if (isFile(p)) return p;
  }
  return null;
}

const CACHE_MAX = 500;

/**
 * Titles per session, re-read only when the transcript's size or mtime changes. Discovery runs every 5 s
 * while the panel is open and transcripts can be hundreds of MB, so both the path lookup and the tail
 * read are cached.
 */
export class TitleReader {
  readonly projectsDir: string;
  private paths = new Map<string, string>();
  private titlesByPath = new Map<string, { size: number; mtimeMs: number; titles: TranscriptTitles }>();

  constructor(o: { projectsDir?: string } = {}) {
    this.projectsDir = o.projectsDir ?? defaultClaudeProjectsDir();
  }

  titles(cwd: string, sessionId: string | undefined): TranscriptTitles {
    if (!validSessionId(sessionId)) return {};
    const key = `${sessionId}\n${cwd}`;
    let path = this.paths.get(key);
    if (!path || !isFile(path)) {
      path = transcriptPath(this.projectsDir, cwd, sessionId) ?? undefined;
      if (!path) return {};
      if (this.paths.size >= CACHE_MAX) this.paths.clear();
      this.paths.set(key, path);
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      return {};
    }
    const hit = this.titlesByPath.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.titles;
    const tail = readTail(path, TITLE_TAIL_BYTES);
    const titles = tail ? parseTranscriptTitles(tail.text, { partial: tail.partial }) : {};
    if (this.titlesByPath.size >= CACHE_MAX) this.titlesByPath.clear();
    this.titlesByPath.set(path, { size: st.size, mtimeMs: st.mtimeMs, titles });
    return titles;
  }
}
