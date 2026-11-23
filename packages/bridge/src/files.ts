// D31 local file rules. The bridge is the enforcement point for paths (D1).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { TabAgentError } from "@tabagent/protocol";
import { MAX_READ_BYTES } from "./config";

function expandHome(p: string) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function inside(real: string, root: string) {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Validate upload paths: each must be an existing regular file whose realpath is inside a realpath'd
 * upload dir, so symlinks and `..` can't escape. Relative paths resolve against the first upload dir.
 * Returns the canonical paths (what DOM.setFileInputFiles receives).
 */
export function resolveUploads(paths: string[], uploadDirs: string[]): string[] {
  const roots = uploadDirs.map(expandHome).filter((d) => existsSync(d)).map((d) => realpathSync(d));
  const base = uploadDirs[0] ? expandHome(uploadDirs[0]) : process.cwd();
  const allowed = uploadDirs.join(", ") || "(none configured)";
  return paths.map((p) => {
    const raw = expandHome(p);
    const abs = isAbsolute(raw) ? raw : resolve(base, raw);
    if (!existsSync(abs)) throw new TabAgentError("NOT_FOUND", `Upload file not found: ${p}`);
    const real = realpathSync(abs);
    if (!roots.some((r) => inside(real, r))) {
      throw new TabAgentError("PERMISSION_DENIED", `Uploads are limited to: ${allowed}`, "Move the file into an upload dir, or run: tabagent config add-upload-dir <dir>");
    }
    if (!statSync(real).isFile()) throw new TabAgentError("BAD_REQUEST", `Not a file: ${p}`);
    return real;
  });
}

function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export interface DownloadContent {
  filename: string;
  name: string;
  size: number;
  encoding: "utf8" | "base64";
  text?: string;
  data?: string;
}

/** Read a completed download: > maxBytes is TOO_LARGE; UTF-8 text as text, anything else base64. */
export function readDownload(path: string, maxBytes = MAX_READ_BYTES): DownloadContent {
  if (!existsSync(path)) throw new TabAgentError("NOT_FOUND", "The downloaded file no longer exists on disk");
  const st = statSync(path);
  if (!st.isFile()) throw new TabAgentError("NOT_FOUND", "The download is not a regular file");
  const limit = Math.min(maxBytes, MAX_READ_BYTES);
  if (st.size > limit) throw new TabAgentError("TOO_LARGE", `Download is ${st.size} bytes; downloads.read returns at most ${limit} bytes`);
  const buf = readFileSync(path);
  const common = { filename: path, name: basename(path), size: st.size };
  return isUtf8Text(buf) ? { ...common, encoding: "utf8", text: buf.toString("utf8") } : { ...common, encoding: "base64", data: buf.toString("base64") };
}

/** D31: downloads.read only reads files the extension reported to *that* session. */
export class SessionDownloads {
  private bySession = new Map<string, Map<number, string>>();

  note(sessionId: string, items: unknown) {
    if (!Array.isArray(items)) return;
    for (const d of items) this.noteOne(sessionId, d);
  }

  noteOne(sessionId: string, d: unknown) {
    const x = d as { id?: unknown; filename?: unknown };
    if (typeof x?.id !== "number" || typeof x.filename !== "string" || !x.filename) return;
    let m = this.bySession.get(sessionId);
    if (!m) this.bySession.set(sessionId, (m = new Map()));
    m.set(x.id, x.filename);
  }

  /** The path recorded for (session, id), or NOT_FOUND. A differing path from the extension is refused. */
  check(sessionId: string, id: number, path: string): string {
    const known = this.bySession.get(sessionId)?.get(id);
    if (!known || known !== path) throw new TabAgentError("NOT_FOUND", `No download ${id} in this session`, "Use downloads.list or downloads.wait to see this session's downloads.");
    return known;
  }

  drop(sessionId: string) {
    this.bySession.delete(sessionId);
  }
}
