// TabAgent service worker: bridge connection, command router, kill switch, UI API.
import { getTool, TabAgentError, validateParams, type BridgeToExt, type Command, type ExtToBridge, type Result } from "@tabagent/protocol";
import { allCdpTabs, detachAll } from "./cdp";
import { broadcast, feedAll, feedEnd, feedStart, summarize } from "./feed";
import { answerPrompt, denyAllPrompts, pendingPrompts } from "./permissions";
import { endAllSessions, endSession, getSession, listSessions, restoreSessions, updateBadge } from "./sessions";
import { getSettings, updateSettings, type Settings } from "./settings";
import { handlers } from "./tools";

const VERSION = chrome.runtime.getManifest().version;

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------
type Status = "unpaired" | "connecting" | "connected" | "disconnected" | "pair-failed";
let ws: WebSocket | null = null;
let status: Status = "disconnected";
let lastError = "";
let pairCode: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;

function setStatus(s: Status, err = "") {
  status = s;
  lastError = err;
  broadcast({ type: "status", status, error: lastError });
  chrome.action.setTitle({ title: `TabAgent: ${s}${err ? ` (${err})` : ""}` }).catch(() => {});
}

function send(msg: ExtToBridge) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const s = await getSettings();
  if (!s.secret && !pairCode) {
    setStatus("unpaired");
    return;
  }
  setStatus("connecting");
  let sock: WebSocket;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${s.port}/ext`);
  } catch (e) {
    setStatus("disconnected", String(e));
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    send({ type: "hello", secret: s.secret ?? undefined, pairCode: pairCode ?? undefined, version: VERSION, extensionId: chrome.runtime.id });
  };
  sock.onmessage = (ev) => onBridgeMessage(String(ev.data));
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (status !== "pair-failed" && status !== "unpaired") setStatus("disconnected", ev.reason || "");
    scheduleReconnect();
  };
  sock.onerror = () => {
    /* onclose follows */
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (status === "pair-failed" || status === "unpaired") return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 10_000);
}

async function onBridgeMessage(raw: string) {
  let msg: BridgeToExt;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      backoff = 500;
      if (msg.secret) {
        await updateSettings({ secret: msg.secret });
        pairCode = null;
      }
      setStatus("connected");
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: "ping" }), 20_000);
      break;
    case "error":
      if (msg.error.code === "UNAUTHORIZED") {
        pairCode = null;
        const s = await getSettings();
        if (s.secret && /secret/i.test(msg.error.message)) await updateSettings({ secret: null });
        setStatus("pair-failed", msg.error.message);
        ws?.close();
      }
      break;
    case "command":
      handleCommand(msg).then(send);
      break;
    case "session.closed":
      endSession(msg.sessionId).catch(() => {});
      break;
    case "pong":
      break;
  }
}

// ---------------------------------------------------------------------------
// Command router
// ---------------------------------------------------------------------------
async function handleCommand(cmd: Command): Promise<Result> {
  const tool = getTool(cmd.tool);
  if (!tool) return { type: "result", id: cmd.id, ok: false, error: { code: "NOT_FOUND", message: `Unknown tool ${cmd.tool}` } };
  const entry = feedStart({ session: cmd.session.id, label: cmd.session.label, tool: tool.name, summary: summarize((cmd.params ?? {}) as Record<string, unknown>) });
  try {
    const s = await getSettings();
    if (s.paused) throw new TabAgentError("PERMISSION_DENIED", "The user stopped all agents with the TabAgent kill switch", "Ask the user to press Resume in the TabAgent side panel.");
    const params = validateParams(tool, cmd.params);
    const sess = await getSession(cmd.session);
    const h = handlers[tool.name];
    if (!h) throw new TabAgentError("NOT_FOUND", `No handler for ${tool.name}`);
    const result = await h({ s: sess, meta: cmd.session, p: params, tool });
    feedEnd(entry, { status: "ok" });
    return { type: "result", id: cmd.id, ok: true, result };
  } catch (e) {
    const err = e instanceof TabAgentError ? e.toJSON() : { code: "INTERNAL" as const, message: String((e as Error)?.message ?? e) };
    feedEnd(entry, { status: err.code === "PERMISSION_DENIED" ? "denied" : "error", error: err.message });
    return { type: "result", id: cmd.id, ok: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
async function kill() {
  await updateSettings({ paused: true });
  denyAllPrompts();
  await endAllSessions();
  await detachAll();
  send({ type: "event", event: "killed", data: {} });
  broadcast({ type: "paused", paused: true });
  chrome.action.setBadgeText({ text: "⏸" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => {});
}

async function resume() {
  await updateSettings({ paused: false });
  updateBadge();
  broadcast({ type: "paused", paused: false });
}

chrome.commands.onCommand.addListener((c) => {
  if (c === "kill-switch") kill();
});

// ---------------------------------------------------------------------------
// UI API (side panel + prompt window)
// ---------------------------------------------------------------------------
const UI_KEYS: (keyof Settings)[] = ["policies", "sensitiveAllowed", "defaultPolicy", "denylist", "liteSites", "forceLite", "showOverlay", "onSessionEnd", "autoAcceptBeforeUnload"];

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only our own extension pages may drive the UI API.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  (async () => {
    switch (msg?.type) {
      case "ui.state": {
        const s = await getSettings();
        const { secret, ...rest } = s;
        return { status, error: lastError, paired: !!secret, settings: rest, sessions: listSessions(), prompts: pendingPrompts(), feed: feedAll(), version: VERSION, extensionId: chrome.runtime.id };
      }
      case "ui.pair": {
        pairCode = String(msg.code ?? "").trim().toUpperCase();
        if (msg.port) await updateSettings({ port: Number(msg.port) });
        ws?.close();
        ws = null;
        backoff = 500;
        setStatus("connecting");
        connect();
        return { ok: true };
      }
      case "ui.unpair":
        await updateSettings({ secret: null });
        ws?.close();
        setStatus("unpaired");
        return { ok: true };
      case "ui.reconnect":
        backoff = 500;
        if (status === "pair-failed") setStatus("disconnected");
        connect();
        return { ok: true };
      case "ui.kill":
        await kill();
        return { ok: true };
      case "ui.resume":
        await resume();
        return { ok: true };
      case "ui.endSession":
        await endSession(msg.id);
        send({ type: "event", event: "session.ended", data: { sessionId: msg.id } });
        return { ok: true };
      case "ui.answer":
        return { ok: answerPrompt(msg.id, msg.answer) };
      case "ui.prompt.get":
        return pendingPrompts().find((p) => p.id === msg.id) ?? null;
      case "ui.settings": {
        const patch: Partial<Settings> = {};
        for (const k of UI_KEYS) if (k in (msg.patch ?? {})) (patch as any)[k] = msg.patch[k];
        const s = await updateSettings(patch);
        const { secret, ...rest } = s;
        return { ok: true, settings: rest };
      }
    }
    return { error: "unknown message" };
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create("tabagent-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tabagent-keepalive") connect();
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

(async () => {
  await restoreSessions();
  const s = await getSettings();
  if (s.paused) {
    chrome.action.setBadgeText({ text: "⏸" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => {});
  } else updateBadge();
  connect();
})();

// Exposed for e2e tests via serviceWorker.evaluate.
(globalThis as any).__tabagent = { getSettings, updateSettings, connect, kill, resume, status: () => status, pendingPrompts, answerPrompt, listSessions, debugTabs: async () => Promise.all(allCdpTabs().map(async (t) => ({ tabId: t.tabId, attached: t.attached, children: [...t.children.entries()], inflight: [...t.inflight.keys()].map((k) => [k, t.network.get(k)?.url, t.network.get(k)?.resourceType]), frames: t.attached ? await t.frames().catch((e) => String(e)) : null }))), attachedTabs: () => allCdpTabs().filter((t) => t.attached).map((t) => t.tabId) };
