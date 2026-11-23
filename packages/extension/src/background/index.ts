// TabAgent service worker: wires the bridge client, the command router, the
// permission gate and the pairing screen together.
// Decisions live in pure modules (policy, router, audit, bridgeClient).
import { getTool, PROTOCOL_VERSION, validateParams, type SessionMeta } from "@tabagent/protocol";
import { createBridgeClient, type Status, type WsLike } from "./bridgeClient";
import { navHandlers } from "./handlers/nav";
import { authorize } from "./permissions";
import { createRouter } from "./router";
import { sessionHandlers } from "./sessionTools";
import { endSession, getSession, listSessions, resolveTab, restoreSessions, type Session } from "./sessions";
import { getSettings, updateSettings } from "./settings";

const VERSION = chrome.runtime.getManifest().version;

// ---------------------------------------------------------------------------
// Bridge connection (D4, D5, D11)
// ---------------------------------------------------------------------------
const bridge = createBridgeClient({
  makeSocket: (url) => new WebSocket(url) as unknown as WsLike,
  loadConfig: async () => {
    const s = await getSettings();
    return { port: s.port, secret: s.secret };
  },
  saveSecret: async (secret) => {
    await updateSettings({ secret });
  },
  onMessage: (m) => onBridgeMessage(m),
  protocolVersion: PROTOCOL_VERSION,
  extensionVersion: VERSION,
  extensionId: chrome.runtime.id,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

function onBridgeMessage(msg: any) {
  switch (msg?.type) {
    case "command":
      router.handle(msg).then((env) => bridge.send(env));
      break;
    case "session.closed":
      endSession(msg.sessionId).catch(() => {});
      break;
  }
}

// ---------------------------------------------------------------------------
// Router (#3): validate -> resolve tab -> authorize -> handler -> envelope
// ---------------------------------------------------------------------------
async function tabUrl(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return t.pendingUrl || t.url || "";
}

const handlers: Record<string, any> = { ...sessionHandlers, ...navHandlers };

export const router = createRouter<Session>({
  getTool: (n) => getTool(n) as any,
  validate: (t, p) => validateParams(t as any, p),
  getSession: (m) => getSession(m as SessionMeta),
  resolveTab: (s, id) => resolveTab(s, id),
  tabUrl,
  authorize: (r) => authorize({ meta: r.meta, url: r.url, level: r.level, sensitive: r.sensitive, tool: r.action ? `${r.tool} ${r.action}` : r.tool, tabId: r.tabId }),
  handler: (name) => handlers[name],
});

// ---------------------------------------------------------------------------
// Pairing screen API. Only our own extension pages may call it.
// ---------------------------------------------------------------------------
async function uiState() {
  const s = await getSettings();
  return { status: bridge.status(), error: bridge.lastError(), paired: !!s.secret, port: s.port, version: VERSION, extensionId: chrome.runtime.id };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  (async () => {
    switch (msg?.type) {
      case "ui.state":
        return uiState();
      case "ui.pair":
        if (msg.port) await updateSettings({ port: Number(msg.port) });
        await bridge.pair(String(msg.code ?? ""));
        return { ok: true };
    }
    return { error: "unknown message" };
  })().then(reply, (e) => reply({ error: String((e as Error)?.message ?? e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle (D11): alarm-driven reconnect every 30s; ping every 20s once welcomed.
// ---------------------------------------------------------------------------
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create("tabagent-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tabagent-reconnect") bridge.tick();
});
chrome.runtime.onStartup.addListener(() => bridge.connect());
chrome.runtime.onInstalled.addListener(() => bridge.connect());

(async () => {
  await restoreSessions();
  await getSettings();
  bridge.connect();
})();

// Exposed for e2e tests via serviceWorker.evaluate.
(globalThis as any).__tabagent = {
  getSettings,
  updateSettings,
  connect: () => bridge.connect(),
  status: () => bridge.status(),
  listSessions,
};
export type { Status };
