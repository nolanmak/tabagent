// chrome.downloads adapter. Attribution (D31) is by the tab that started the
// download (CDP Page.downloadWillBegin), mapped to that tab's owning session,
// never by "whoever acted last". Decisions live in ../pure/dlattr.
import { DownloadTracker, wireDownload, type DlItem } from "../pure/dlattr";
import { ownerOf } from "./sessions";

export const tracker = new DownloadTracker((tabId) => ownerOf(tabId) ?? undefined);

function toItem(d: chrome.downloads.DownloadItem): DlItem {
  return { id: d.id, url: d.url, finalUrl: d.finalUrl, filename: d.filename, state: d.state, mime: d.mime, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, error: d.error, startTime: d.startTime };
}

chrome.downloads.onCreated.addListener((d) => tracker.onCreated(toItem(d)));

chrome.downloads.onChanged.addListener(async (delta) => {
  const [d] = await chrome.downloads.search({ id: delta.id });
  if (d) tracker.onChanged(toItem(d));
});

/** Downloads of this session that started at/after `ts`, as reported on the wire (and marked reported). */
export function downloadsSince(sessionId: string, ts: number) {
  const list = tracker.since(sessionId, ts - 1000);
  tracker.markReported(sessionId, list.map((d) => d.id));
  return list.map(wireDownload);
}

export function getDownload(id: number) {
  return tracker.get(id);
}

/** Wait for a download created by this session after a workflow run started. */
export async function downloadAfter(sessionId: string, after: number, timeoutMs: number) {
  const item = await tracker.waitAfter(sessionId, after, timeoutMs);
  return item ? wireDownload(item) : undefined;
}

/** Kept for older callers; attribution no longer depends on the last action. */
export function noteAction(_sessionId: string) {}
