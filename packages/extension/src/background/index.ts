// TabAgent service worker: wires the bridge client, the command router, the
// permission gate (D17 interim) and the pairing screen API together.
// Decisions live in pure modules (policy, router, audit, bridgeClient).
import { getTool, PROTOCOL_VERSION, validateParams, type SessionMeta } from "@tabagent/protocol";
import { createBridgeClient, type Status, type WsLike } from "./bridgeClient";
import { onFilesResolved, setFilesSender } from "./bridgeFiles";
import { allCdpTabs } from "./cdp";
import { driverFor } from "./driver";
import { getDownload } from "./downloads";
import { broadcast } from "./feed";
import { authorize } from "./permissions";
import { createRouter } from "./router";
import { attachTarget, sessionHandlers } from "./sessionTools";
import { endSession, getSession, listSessions, resolveTab, restoreSessions, type Session } from "./sessions";
import { getSettings, updateSettings } from "./settings";
import { handlers } from "./tools";

const VERSION = chrome.runtime.getManifest().version;
const FEATURES = ["files.resolve"];

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
  onStatus: (status, error) => {
    broadcast({ type: "status", status, error });
  },
  protocolVersion: PROTOCOL_VERSION,
  extensionVersion: VERSION,
  extensionId: chrome.runtime.id,
  features: FEATURES,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
setFilesSender((m) => bridge.send(m));

function onBridgeMessage(msg: any) {
  switch (msg?.type) {
    case "command":
      router.handle(msg).then((env) => bridge.send(env));
      break;
    case "session.closed":
      endSession(msg.sessionId).catch(() => {});
      break;
    case "files.resolved":
      onFilesResolved(msg);
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

const SENSITIVE_NAME = /pass(word|code)?|card|cc-?num|cvv|cvc|csc|security.?code|ssn|social.?sec|iban|routing|account.?num/i;

async function refIsSensitive(tabId: number, url: string, ref: string): Promise<boolean> {
  const drv = await driverFor(tabId, url);
  const inf = (await Promise.race([drv.call("info", [], { ref }), new Promise((r) => setTimeout(() => r(null), 800))])) as { type?: string; name?: string; inputType?: string } | null;
  if (!inf) return true; // unknown: mask
  return inf.type === "password" || inf.inputType === "password" || SENSITIVE_NAME.test(inf.name ?? "");
}

export const router = createRouter<Session>({
  getTool: (n) => getTool(n) as any,
  validate: (t, p) => validateParams(t as any, p),
  // The kill switch (D12) arrives with the side panel (#14).
  isPaused: () => false,
  getSession: (m) => getSession(m as SessionMeta),
  resolveTab: (s, id) => resolveTab(s, id),
  tabUrl,
  attachTarget: (m, id) => attachTarget(m as SessionMeta, id),
  downloadUrl: (id, sid) => {
    const d = getDownload(id);
    return d && d.sessionId === sid ? d.url : undefined;
  },
  authorize: (r) => authorize({ meta: r.meta, url: r.url, level: r.level, sensitive: r.sensitive, tool: r.action ? `${r.tool} ${r.action}` : r.tool, summary: r.summary, reasons: r.reasons, tabId: r.tabId }),
  handler: (name) => (sessionHandlers[name] ?? (handlers as Record<string, any>)[name]) as any,
  sensitivePaths: async (tool, p, tabId, url) => {
    if (tabId == null) return [];
    const out: string[] = [];
    if ((tool === "act.type" || tool === "act.fill") && typeof p.ref === "string") {
      if (await refIsSensitive(tabId, url, p.ref)) out.push(tool === "act.type" ? "text" : "value");
    }
    if (tool === "form.fill" && p.fields && typeof p.fields === "object") {
      for (const k of Object.keys(p.fields)) if (/^e\d+$/.test(k) && (await refIsSensitive(tabId, url, k))) out.push(`fields.${k}`);
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// UI API (pairing screen). Only our own extension pages may call it.
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
      case "ui.unpair":
        await updateSettings({ secret: null });
        bridge.disconnect("unpaired");
        return { ok: true };
      case "ui.reconnect":
        await bridge.reconnect();
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
  features: FEATURES,
  listSessions,
  endSession,
  inflight: () => router.inflightCount(),
  debugTabs: async () => Promise.all(allCdpTabs().map(async (t) => ({ tabId: t.tabId, attached: t.attached, children: [...t.children.entries()], inflight: [...t.inflight.keys()].map((k) => [k, t.network.get(k)?.url, t.network.get(k)?.resourceType]), frames: t.attached ? await t.frames().catch((e) => String(e)) : null }))),
  attachedTabs: () => allCdpTabs().filter((t) => t.attached).map((t) => t.tabId),
};
export type { Status };
