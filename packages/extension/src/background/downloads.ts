// Attribute downloads to the session whose action most likely started them.
export interface DlInfo {
  id: number;
  url: string;
  filename: string;
  mime: string;
  state: string;
  bytes: number;
  totalBytes: number;
  error?: string;
  sessionId?: string;
  startTime: string;
}

const byId = new Map<number, DlInfo>();
let lastAction: { sessionId: string; ts: number } | null = null;
const waiters = new Set<{ pred: (d: DlInfo) => boolean; resolve: (d: DlInfo) => void }>();

export function noteAction(sessionId: string) {
  lastAction = { sessionId, ts: Date.now() };
}

function toInfo(d: chrome.downloads.DownloadItem, prev?: DlInfo): DlInfo {
  return {
    id: d.id,
    url: d.finalUrl || d.url,
    filename: d.filename,
    mime: d.mime,
    state: d.state,
    bytes: d.bytesReceived,
    totalBytes: d.totalBytes,
    error: d.error,
    sessionId: prev?.sessionId,
    startTime: d.startTime,
  };
}

chrome.downloads.onCreated.addListener((d) => {
  const info = toInfo(d);
  if (lastAction && Date.now() - lastAction.ts < 30_000) info.sessionId = lastAction.sessionId;
  byId.set(d.id, info);
  notify(info);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const [d] = await chrome.downloads.search({ id: delta.id });
  if (!d) return;
  const info = toInfo(d, byId.get(d.id));
  byId.set(d.id, info);
  notify(info);
});

function notify(d: DlInfo) {
  for (const w of [...waiters]) {
    if (w.pred(d)) {
      waiters.delete(w);
      w.resolve(d);
    }
  }
}

export function sessionDownloads(sessionId: string): DlInfo[] {
  return [...byId.values()].filter((d) => d.sessionId === sessionId);
}

export function getDownload(id: number) {
  return byId.get(id);
}

export function downloadsSince(sessionId: string, ts: number): DlInfo[] {
  return sessionDownloads(sessionId).filter((d) => Date.parse(d.startTime) >= ts - 1000);
}

export function waitDownload(sessionId: string, id: number | undefined, timeoutMs: number): Promise<DlInfo | null> {
  const done = (d: DlInfo) => d.state === "complete" || d.state === "interrupted";
  if (id != null) {
    const d = byId.get(id);
    if (d && done(d)) return Promise.resolve(d);
  } else {
    // most recent pending download for this session, else the next one
    const pend = sessionDownloads(sessionId).filter((d) => !done(d));
    if (!pend.length) {
      const recent = sessionDownloads(sessionId).filter((d) => done(d) && Date.now() - Date.parse(d.startTime) < 5000);
      if (recent.length) return Promise.resolve(recent[recent.length - 1]);
    }
  }
  return new Promise((resolve) => {
    const w = { pred: (d: DlInfo) => (id != null ? d.id === id : d.sessionId === sessionId) && done(d), resolve };
    waiters.add(w);
    setTimeout(() => {
      if (waiters.delete(w)) resolve(null);
    }, timeoutMs);
  });
}
