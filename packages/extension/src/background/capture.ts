// Per-tab capture state fed by CDP events: network/console ring buffers (D35),
// the dialog state machine (D28) and download notes (D31). Thin adapter over ../pure.
import { Capture } from "../pure/capture";
import { authTaint } from "./authTaint";
import { DialogState, type BeforeUnloadPolicy } from "../pure/dialogs";
import { tracker } from "./downloads";
import { getSettings } from "./settings";

interface TabState {
  capture: Capture;
  dialogs: DialogState;
}

const tabs = new Map<number, TabState>();
type DialogSender = (tabId: number, accept: boolean, promptText: string | undefined, sessionId: string | undefined) => Promise<void>;
let sendDialog: DialogSender = async () => {};

/** cdp.ts registers how to answer a dialog (Page.handleJavaScriptDialog). */
export function setDialogSender(fn: DialogSender) {
  sendDialog = fn;
}

let beforeUnload: BeforeUnloadPolicy = "accept";
function readPolicy(s: Record<string, unknown>): BeforeUnloadPolicy {
  const v = s.beforeUnload;
  if (v === "accept" || v === "dismiss" || v === "ask-agent") return v;
  return s.autoAcceptBeforeUnload === false ? "ask-agent" : "accept";
}
getSettings()
  .then((s) => (beforeUnload = readPolicy(s as unknown as Record<string, unknown>)))
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings?.newValue) beforeUnload = readPolicy(changes.settings.newValue as Record<string, unknown>);
});

export function tabState(tabId: number): TabState {
  let t = tabs.get(tabId);
  if (!t) {
    t = {
      capture: new Capture(),
      dialogs: new DialogState({ beforeUnload: () => beforeUnload, send: (accept, text, sid) => sendDialog(tabId, accept, text, sid) }),
    };
    tabs.set(tabId, t);
  }
  return t;
}

export function peekTabState(tabId: number): TabState | undefined {
  return tabs.get(tabId);
}

/** Called for every CDP event of an attached tab (all sessions, incl. OOPIFs). */
export function onCdpEvent(tabId: number, method: string, p: any, sessionId?: string) {
  const t = tabState(tabId);
  switch (method) {
    case "Page.javascriptDialogOpening":
      t.dialogs.onOpening(p, sessionId);
      return;
    case "Page.javascriptDialogClosed":
      t.dialogs.onClosed();
      return;
    case "Page.downloadWillBegin":
    case "Browser.downloadWillBegin":
      if (p?.url) tracker.noteTabDownload(tabId, p.url);
      return;
  }
  // DA1 (review H1): a main-frame commit moves the tab off the document TabAgent typed into.
  if (method === "Page.frameNavigated" && !sessionId && !p?.frame?.parentId) authTaint.navigated(tabId, { bfcache: p?.type === "BackForwardCacheRestore" });
  // #17: only the top-level target is captured until cross-origin frames land (#19).
  if (sessionId && method.startsWith("Network.")) return;
  t.capture.onEvent(method, p, sessionId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.get(tabId)?.capture.clear();
  tabs.delete(tabId);
});
