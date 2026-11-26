// Download attribution and read scoping (#11, D31). Pure: fed chrome.downloads
// items and CDP "download began in tab T" notes; no chrome.* here.
import { TabAgentError } from "@tabagent/protocol";

export interface DlItem {
  id: number;
  url: string;
  finalUrl?: string;
  filename: string;
  state: string;
  mime?: string;
  bytesReceived?: number;
  totalBytes?: number;
  error?: string;
  startTime?: string;
}

export interface DlRecord extends DlItem {
  sessionId?: string;
  tabId?: number;
  createdAt: number;
}

/** Wire shape (D14 `downloads`); filename and url are page-derived. */
export function wireDownload(d: DlRecord) {
  return { id: d.id, filename: d.filename, url: d.finalUrl || d.url, state: d.state, ...(d.mime ? { mime: d.mime } : {}), ...(d.totalBytes != null && d.totalBytes >= 0 ? { bytes: d.totalBytes } : {}), ...(d.error ? { error: d.error } : {}) };
}

const MATCH_WINDOW_MS = 30_000;
const done = (d: DlRecord) => d.state === "complete" || d.state === "interrupted";

interface Note {
  tabId: number;
  url: string;
  ts: number;
  sessionId?: string;
  used: boolean;
}

type Waiter = { sessionId: string; id?: number; after?: number; resolve: (d: DlRecord | null) => void; timer: ReturnType<typeof setTimeout> };

export class DownloadTracker {
  private byId = new Map<number, DlRecord>();
  private notes: Note[] = [];
  private reported = new Map<string, Set<number>>();
  private waiters = new Set<Waiter>();

  constructor(private ownerOf: (tabId: number) => string | undefined) {}

  /** A tab (debugger: Page.downloadWillBegin) started a download of `url`. */
  noteTabDownload(tabId: number, url: string, now = Date.now()) {
    const note: Note = { tabId, url, ts: now, sessionId: this.ownerOf(tabId), used: false };
    this.notes = this.notes.filter((n) => now - n.ts < MATCH_WINDOW_MS);
    const pending = [...this.byId.values()].find((d) => d.tabId == null && !d.sessionId && (d.url === url || d.finalUrl === url) && Math.abs(d.createdAt - now) <= MATCH_WINDOW_MS);
    if (pending) {
      note.used = true;
      this.attribute(pending, note);
    }
    this.notes.push(note);
  }

  private attribute(d: DlRecord, n: Note) {
    d.tabId = n.tabId;
    d.sessionId = n.sessionId;
    if (d.sessionId && done(d)) this.notify(d);
  }

  onCreated(item: DlItem, now = Date.now()) {
    const d: DlRecord = { ...item, createdAt: now };
    this.byId.set(d.id, d);
    const n = this.notes.find((x) => !x.used && (x.url === d.url || x.url === d.finalUrl) && Math.abs(now - x.ts) <= MATCH_WINDOW_MS);
    if (n) {
      n.used = true;
      this.attribute(d, n);
    }
  }

  onChanged(delta: Partial<DlItem> & { id: number }) {
    const d = this.byId.get(delta.id);
    if (!d) return;
    const wasDone = done(d);
    for (const [k, v] of Object.entries(delta)) if (v !== undefined) (d as any)[k] = v;
    if (!wasDone && done(d) && d.sessionId) this.notify(d);
  }

  private notify(d: DlRecord) {
    for (const w of [...this.waiters]) {
      if (w.sessionId === d.sessionId && (w.id == null || w.id === d.id) && (w.after == null || d.createdAt >= w.after)) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(d);
      }
    }
  }

  get(id: number): DlRecord | undefined {
    return this.byId.get(id);
  }

  list(sessionId: string): DlRecord[] {
    return [...this.byId.values()].filter((d) => d.sessionId === sessionId);
  }

  since(sessionId: string, ts: number): DlRecord[] {
    return this.list(sessionId).filter((d) => d.createdAt >= ts);
  }

  /** Next completed download of the session (or of `id`), or null on timeout. */
  waitNext(sessionId: string, timeoutMs: number, id?: number): Promise<DlRecord | null> {
    if (id != null) {
      const d = this.byId.get(id);
      if (!d || d.sessionId !== sessionId) return Promise.resolve(null);
      if (done(d)) return Promise.resolve(d);
    }
    return new Promise((resolve) => {
      const w: Waiter = {
        sessionId,
        id,
        resolve,
        timer: setTimeout(() => {
          if (this.waiters.delete(w)) resolve(null);
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  /** A completed download attributed to this session after a workflow run began. */
  waitAfter(sessionId: string, after: number, timeoutMs: number): Promise<DlRecord | null> {
    const existing = this.list(sessionId).find((d) => d.createdAt >= after && d.state === "complete");
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const w: Waiter = {
        sessionId,
        after,
        resolve,
        timer: setTimeout(() => {
          if (this.waiters.delete(w)) resolve(null);
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  markReported(sessionId: string, ids: number[]) {
    let s = this.reported.get(sessionId);
    if (!s) this.reported.set(sessionId, (s = new Set()));
    for (const id of ids) if (this.byId.get(id)?.sessionId === sessionId) s.add(id);
  }

  /** downloads.read scope: the session's own download, already reported to it, complete. */
  readable(sessionId: string, id: number): DlRecord {
    const d = this.byId.get(id);
    if (!d || d.sessionId !== sessionId || !this.reported.get(sessionId)?.has(id)) {
      throw new TabAgentError("NOT_FOUND", `Download ${id} is not one of this session's downloads`, "Use downloads.list or downloads.wait to get ids.");
    }
    if (d.state !== "complete") throw new TabAgentError("BAD_REQUEST", `Download ${id} is ${d.state}`, "Call downloads.wait first.");
    return d;
  }

  forgetSession(sessionId: string) {
    this.reported.delete(sessionId);
  }
}
