// Chat page history (#151, spec §7a). Claude Code writes each session's conversation to
// `<projects>/<cwd slug>/<sessionId>.jsonl`, one JSON record per line. Only `user` and `assistant` records
// become entries; everything else (titles, attachments, api-request blobs, system lines, sidechains) is
// skipped. The normalisation is pure; the byte-offset readers at the bottom are the thin file adapter.
//
// Transcripts can be hundreds of MB, so history is read backwards from the end in chunks, and the
// pagination cursor is the byte offset of the oldest line already returned.
import { open } from "node:fs/promises";
import { AGENT_HISTORY_LIMITS, type AgentEntry } from "@tabagent/protocol";
import { MESSAGE_HEADER } from "./compose";

/** Lines longer than this are skipped unparsed (pasted images, huge tool output). */
export const TRANSCRIPT_LINE_MAX = 2 * 1024 * 1024;
/** One read when scanning backwards. */
export const HISTORY_CHUNK = 256 * 1024;
/** Most bytes one history page scans before it returns what it has (with `hasMore`). */
export const HISTORY_SCAN_MAX = 48 * 1024 * 1024;
/** Most bytes one watcher poll reads. The rest is read on the next poll. */
export const APPEND_READ_MAX = 4 * 1024 * 1024;

const TRUNCATED = "\n… (truncated)";

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + TRUNCATED : s;
}

/** Drop control characters other than tab and newline. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n");
}

// ---------------------------------------------------------------------------
// Normalisation (pure)
// ---------------------------------------------------------------------------

/** User text Claude Code adds itself (hooks, background task notices, local command output). Never shown. */
const SYSTEM_TAGS = /^\s*<(task-notification|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|system-reminder|command-message|user-prompt-submit-hook|artifact-content-authored-by-others)[\s>]/;

/** The prompt part of a composed TabAgent message (compose.ts): the header, the prompt, then an optional page paragraph. */
export function tabAgentPrompt(composed: string): string | null {
  const s = composed.replace(/^\s+/, "");
  if (!s.startsWith(MESSAGE_HEADER)) return null;
  let body = s.slice(MESSAGE_HEADER.length).replace(/^\n/, "");
  // The page paragraph starts with one of compose.ts's two intros after a blank line; take the last one.
  const re = /\n\n(The user was looking at this page \(you do not have browser access to it\):|Browser tab \d+ is now in your TabAgent tab group \(use tabId \d+\)\.)\n/g;
  let cut = -1;
  for (let m = re.exec(body); m; m = re.exec(body)) cut = m.index;
  if (cut >= 0) body = body.slice(0, cut);
  return body.replace(/\s+$/, "");
}

/** `<channel source="tabagent" …>…</channel>` as Claude Code records a channel push; null for other servers. */
function channelBody(s: string): string | null {
  const m = /^\s*<channel\b([^>]*)>\n?([\s\S]*?)\n?<\/channel>\s*$/.exec(s);
  if (!m) return null;
  return m[2];
}

/** Text the user typed, or null when it is Claude Code's own (system tags, meta lines). Slash commands keep their name. */
function typedText(s: string): string | null {
  if (SYSTEM_TAGS.test(s)) return null;
  const cmd = /<command-name>([^<]{1,200})<\/command-name>/.exec(s);
  if (cmd) {
    const args = /<command-args>([\s\S]{0,4000}?)<\/command-args>/.exec(s)?.[1]?.trim();
    const name = cmd[1].trim();
    return (name.startsWith("/") ? name : `/${name}`) + (args ? ` ${args}` : "");
  }
  const bash = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(s);
  if (bash) return `! ${bash[1].trim()}`;
  return s;
}

/** `mcp__server__tool` reads as `tool`; built-in names stay as they are. */
export function toolDisplayName(name: unknown): string {
  if (typeof name !== "string" || !name) return "tool";
  const short = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
  return clip(clean(short), AGENT_HISTORY_LIMITS.toolName);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The one thing worth showing about a tool call's input: the command, the file, the pattern, the URL… */
export function toolInputSummary(name: unknown, input: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const n = typeof name === "string" ? name : "";
  let s: string | undefined;
  if (n === "Bash") s = str(i.command);
  else if (n === "Read" || n === "Write" || n === "Edit" || n === "MultiEdit") s = str(i.file_path);
  else if (n === "NotebookEdit") s = str(i.notebook_path);
  else if (n === "Grep") s = [str(i.pattern), str(i.path)].filter(Boolean).join(" in ") || undefined;
  else if (n === "Glob") s = str(i.pattern);
  else if (n === "WebFetch") s = str(i.url);
  else if (n === "WebSearch") s = str(i.query);
  else if (n === "Task" || n === "Agent") s = str(i.description) ?? str(i.prompt);
  else if (n === "TodoWrite" && Array.isArray(i.todos)) s = `${i.todos.length} todo${i.todos.length === 1 ? "" : "s"}`;
  if (s === undefined) s = Object.values(i).find((v): v is string => typeof v === "string" && !!v.trim());
  if (s === undefined) {
    try {
      s = Object.keys(i).length ? JSON.stringify(i) : "";
    } catch {
      s = "";
    }
  }
  return clip(clean(s), AGENT_HISTORY_LIMITS.toolSummary);
}

/** tool_result content (a string or a list of blocks) as plain text. Images become `[image]`. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as { type?: unknown; text?: unknown };
    if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    else if (blk.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

type Rec = Record<string, unknown>;

function timestamp(rec: Rec): number {
  const t = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * One transcript record as zero or more entries. `key` identifies the line when the record has no uuid
 * (its byte offset). Pure.
 */
export function normalizeRecord(rec: unknown, key: string): AgentEntry[] {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return [];
  const r = rec as Rec;
  if (r.type !== "user" && r.type !== "assistant") return [];
  if (r.isSidechain === true || r.isCompactSummary === true) return [];
  const msg = r.message && typeof r.message === "object" ? (r.message as Rec) : null;
  if (!msg) return [];
  const base = typeof r.uuid === "string" && r.uuid && r.uuid.length <= 150 ? r.uuid : key;
  const ts = timestamp(r);
  const out: AgentEntry[] = [];
  const push = (e: Omit<AgentEntry, "uuid" | "ts">) => out.push({ uuid: out.length ? `${base}:${out.length}` : base, ts, ...e });
  const text = (role: "user" | "assistant", s: string, fromTabAgent?: boolean) => {
    const t = clean(s).replace(/^\n+|\s+$/g, "");
    if (t) push({ role, text: clip(t, AGENT_HISTORY_LIMITS.text), ...(fromTabAgent ? { fromTabAgent: true } : {}) });
  };
  const content = msg.content;

  if (r.type === "user") {
    const origin = r.origin && typeof r.origin === "object" ? (r.origin as Rec) : null;
    if (typeof content === "string") {
      // A channel push (AD9) is recorded as a meta user line; only TabAgent's own are shown, as the user's.
      if (origin?.kind === "channel") {
        const body = channelBody(content);
        const prompt = body == null ? null : tabAgentPrompt(body);
        if (prompt != null) text("user", prompt, true);
        return out;
      }
      if (r.isMeta === true) return [];
      const t = typedText(content);
      if (t != null) text("user", t);
      return out;
    }
    if (!Array.isArray(content) || r.isMeta === true) return out;
    const typed: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const blk = b as Rec;
      if (blk.type === "text" && typeof blk.text === "string") {
        if (/^\[Request interrupted by user/.test(blk.text)) push({ role: "tool", tool: { name: "Interrupted", summary: "" } });
        else {
          const t = typedText(blk.text);
          if (t != null) typed.push(t);
        }
      } else if (blk.type === "image") typed.push("[image]");
      else if (blk.type === "tool_result") {
        const id = typeof blk.tool_use_id === "string" ? blk.tool_use_id.slice(0, 200) : undefined;
        let body = resultText(blk.content);
        // AD8 piggyback: the held message rides as the first block of a tool result.
        const first = Array.isArray(blk.content) ? resultText([blk.content[0]]) : body;
        const prompt = tabAgentPrompt(first);
        if (prompt != null) {
          text("user", prompt, true);
          body = Array.isArray(blk.content) ? resultText(blk.content.slice(1)) : body.slice(body.indexOf(prompt) + prompt.length);
        }
        push({ role: "tool", tool: { name: "result", summary: clip(clean(body).trim(), AGENT_HISTORY_LIMITS.toolSummary), ...(id ? { id } : {}), result: true, ...(blk.is_error === true ? { error: true } : {}) } });
      }
    }
    if (typed.length) text("user", typed.join("\n"));
    return out;
  }

  // assistant
  if (typeof content === "string") {
    text("assistant", content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) text("assistant", pending.join("\n\n"));
    pending = [];
  };
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Rec;
    if (blk.type === "text" && typeof blk.text === "string") pending.push(blk.text);
    else if (blk.type === "tool_use") {
      flush();
      const id = typeof blk.id === "string" ? blk.id.slice(0, 200) : undefined;
      push({ role: "tool", tool: { name: toolDisplayName(blk.name), summary: toolInputSummary(blk.name, blk.input), ...(id ? { id } : {}) } });
    }
    // thinking / redacted_thinking: never shown.
  }
  flush();
  return out;
}

/** Cheap pre-check so the big non-message lines (api-request blobs, snapshots) are never parsed. */
const MAYBE_MESSAGE = /"type":\s*"(user|assistant)"/;

/** One raw line (bytes) at `offset` as entries; malformed, oversized and non-message lines give none. */
export function normalizeLine(line: Buffer | string, offset: number): AgentEntry[] {
  if (line.length === 0 || line.length > TRANSCRIPT_LINE_MAX) return [];
  const s = typeof line === "string" ? line : line.toString("utf8");
  if (!MAYBE_MESSAGE.test(s)) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(s);
  } catch {
    return [];
  }
  return normalizeRecord(rec, `o${offset}`);
}

/** Cursor <-> byte offset. Anything else is rejected. */
export function parseCursor(c: string | undefined): number | null | undefined {
  if (c === undefined) return undefined;
  return /^\d{1,15}$/.test(c) ? Number(c) : null;
}

// ---------------------------------------------------------------------------
// File adapter: byte-offset readers
// ---------------------------------------------------------------------------

export interface HistoryPage {
  /** Oldest first. */
  entries: AgentEntry[];
  hasMore: boolean;
  /** Byte offset of the oldest line returned: the cursor for the next older page. */
  before: number;
}

/**
 * Up to about `limit` entries from the lines ending before byte `before` (default: the end of the file),
 * reading backwards. A line is never split across pages, so a page may hold a few more than `limit`.
 */
export async function readHistoryPage(path: string, o: { before?: number; limit: number; chunk?: number; scanMax?: number }): Promise<HistoryPage> {
  const chunk = o.chunk ?? HISTORY_CHUNK;
  const scanMax = o.scanMax ?? HISTORY_SCAN_MAX;
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    let pos = Math.min(o.before ?? size, size);
    // Lines found so far, newest first; each is that line's entries in order.
    const lines: AgentEntry[][] = [];
    let count = 0;
    let earliest = pos;
    let carry: Buffer = Buffer.alloc(0);
    let oversize = false;
    let scanned = 0;
    const take = (buf: Buffer, offset: number) => {
      earliest = offset;
      if (oversize) {
        oversize = false;
        return;
      }
      const e = normalizeLine(buf, offset);
      if (e.length) {
        lines.push(e);
        count += e.length;
      }
    };
    while (pos > 0 && count < o.limit && scanned < scanMax) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      scanned += bytesRead;
      const data = carry.length ? Buffer.concat([buf.subarray(0, bytesRead), carry]) : buf.subarray(0, bytesRead);
      let end = data.length;
      for (let i = data.length - 1; i >= 0 && count < o.limit; i--) {
        if (data[i] !== 0x0a) continue;
        take(data.subarray(i + 1, end), start + i + 1);
        end = i;
      }
      pos = start;
      carry = data.subarray(0, end);
      if (count >= o.limit) break;
      if (carry.length > TRANSCRIPT_LINE_MAX) {
        // The rest of a giant line: drop the bytes, and skip the line when its start is found.
        carry = Buffer.alloc(0);
        oversize = true;
      }
      if (pos === 0 && (carry.length || oversize)) {
        take(carry, 0);
        carry = Buffer.alloc(0);
      }
    }
    // Stopped mid-line (scan budget): the next page resumes at the start of the unfinished bytes.
    if (count < o.limit && pos > 0) earliest = pos + carry.length;
    const entries = lines.reverse().flat();
    return { entries, hasMore: earliest > 0, before: earliest };
  } finally {
    await fh.close();
  }
}

/** The offset just past the last complete line at or before `size`: where a watcher starts reading. */
export async function lineBoundary(path: string, size: number, chunk = HISTORY_CHUNK): Promise<number> {
  const fh = await open(path, "r");
  try {
    size = Math.min(size, (await fh.stat()).size);
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const i = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (i >= 0) return start + i + 1;
      pos = start;
      if (size - pos > TRANSCRIPT_LINE_MAX) return size;
    }
    return 0;
  } finally {
    await fh.close();
  }
}

export interface Appended {
  entries: AgentEntry[];
  /** The next offset to read from (just past the last complete line read). */
  next: number;
  /** A line longer than the read budget is still being skipped. */
  skipping: boolean;
}

/**
 * Complete lines appended between `from` and `size`. A trailing partial line (still being written) is left
 * for the next call. `skipping`: the previous call was inside an oversized line, so bytes up to the next
 * newline are dropped.
 */
export async function readAppended(path: string, from: number, size: number, skipping = false, max = APPEND_READ_MAX): Promise<Appended> {
  if (size <= from) return { entries: [], next: from, skipping };
  const fh = await open(path, "r");
  try {
    const len = Math.min(size - from, max);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    const data = buf.subarray(0, bytesRead);
    const last = data.lastIndexOf(0x0a);
    if (last < 0) {
      // No complete line yet. A full budget with no newline is one giant line: skip it.
      if (bytesRead >= max) return { entries: [], next: from + bytesRead, skipping: true };
      return { entries: [], next: from, skipping };
    }
    const entries: AgentEntry[] = [];
    let start = 0;
    let skip = skipping;
    for (let i = 0; i <= last; i++) {
      if (data[i] !== 0x0a) continue;
      if (!skip) entries.push(...normalizeLine(data.subarray(start, i), from + start));
      skip = false;
      start = i + 1;
    }
    return { entries, next: from + last + 1, skipping: false };
  } finally {
    await fh.close();
  }
}
