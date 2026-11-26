// TabAgent service worker: wires the bridge client, the command router, the
// permission gate, the kill switch, the badge and the UI API together.
// Decisions live in pure modules (policy, prompts, router, audit, badge, bridgeClient).
import { getTool, PROTOCOL_VERSION, TabAgentError, validateParams, type SessionMeta } from "@tabagent/protocol";
import { authTaint, credentialGuard } from "./authTaint";
import { authTaintReady } from "./authTaintStore";
import { badgeState, BADGE } from "./badge";
import { createBridgeClient, type Status, type WsLike } from "./bridgeClient";
import { onFilesResolved, rejectAllFiles, setFilesSender } from "./bridgeFiles";
import { onAuthBridgeMessage, onHandoffBridgeMessage, setAuthSender } from "./auth"; // M6 auth (registers auth.* handlers)
import { onCaptchaBridgeMessage, setCaptchaSender } from "./captcha"; // #61 (registers captcha.solve + autoCaptcha)
import { allCdpTabs, detachAll, peekCdpTab } from "./cdp";
import { disposeDrivers, driverFor } from "./driver";
import { getDownload } from "./downloads";
import { extraHandlers, fireKilled } from "./handlerRegistry";
import { broadcast, feedAll, feedPush } from "./feed";
import { answerPrompt, authorize, clearGrants, holdApproval, onPrompt, pendingPrompts, prompts } from "./permissions";
import type { PromptInfo } from "./prompts";
import { createRouter } from "./router";
import { attachTarget, sessionHandlers } from "./sessionTools";
import { endAllHandoffs, endHandoff, endSession, getSession, listHandoffs, listSessions, onSessionsChanged, resolveTab, restoreSessions, type Session } from "./sessions";
import { getSettings, isPaused, updateSettings, type Settings } from "./settings";
import { migrateSettings, settingsAuditEvents } from "./settingsModel";
import { handlers } from "./tools";
import { captureAgentStep, discardAllCaptures, discardCapture, listActiveCaptures, listWorkflows, parameterizeWorkflowStep, recordAgent, recordManual, recordManualNavigation, removeWorkflowStep, reviewWorkflow, runDueSchedules, startCapture, stopCapture } from "./workflows";

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
    refreshBadge();
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
setAuthSender((m) => bridge.send(m));
setCaptchaSender((m) => bridge.send(m));

function sendEvent(event: string, data: Record<string, unknown> = {}) {
  bridge.send({ type: "event", event, data });
}

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
    case "auth.accounts.result":
    case "secret":
      onAuthBridgeMessage(msg);
      break;
    case "captcha.token":
    case "captcha.vision.answer":
      onCaptchaBridgeMessage(msg);
      break;
    case "handoff.opened":
    case "handoff.frame":
    case "handoff.input":
    case "handoff.end":
      onHandoffBridgeMessage(msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// Router (#3): validate -> paused -> resolve tab -> authorize -> handler -> envelope
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
  isPaused,
  getSession: (m) => getSession(m as SessionMeta),
  resolveTab: (s, id) => resolveTab(s, id),
  tabUrl,
  attachTarget: (m, id) => attachTarget(m as SessionMeta, id),
  downloadUrl: (id, sid) => {
    const d = getDownload(id);
    return d && d.sessionId === sid ? d.url : undefined;
  },
  authorize: (r) => authorize({ meta: r.meta, url: r.url, level: r.level, sensitive: r.sensitive, tool: r.action ? `${r.tool} ${r.action}` : r.tool, summary: r.summary, reasons: r.reasons, tabId: r.tabId }),
  holdApproval,
  // DA1 (review H1): credential reads on a tab TabAgent typed a secret into, and results carrying one.
  guard: async (r) => {
    await authTaintReady; // restored from storage.session after a worker restart (D11)
    credentialGuard(authTaint, r);
  },
  leaks: (text) => authTaint.leaks(text),
  handler: (name) => (extraHandlers[name] ?? sessionHandlers[name] ?? (handlers as Record<string, any>)[name]) as any,
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
  feed: (e) => feedPush(e),
  onInflight: () => refreshBadge(),
  captureWorkflowStep: captureAgentStep,
  recordWorkflowStep: recordAgent,
});

// ---------------------------------------------------------------------------
// Badge (D40)
// ---------------------------------------------------------------------------
let lastBadge = "";
async function refreshBadge() {
  const yolo = await getSettings().then((s) => !!s.yolo, () => false);
  const st = badgeState({ connected: bridge.connected(), paused: await isPaused().catch(() => false), pendingPrompts: prompts.size, inflight: router?.inflightCount?.() ?? 0, yolo });
  if (st === lastBadge) return;
  lastBadge = st;
  const b = BADGE[st];
  chrome.action.setBadgeText({ text: b.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
  chrome.action.setTitle({ title: b.title }).catch(() => {});
}
onSessionsChanged(() => refreshBadge());

// Review M1: YOLO / devAllowSensitive toggles are audited and the badge follows, whatever wrote them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = migrateSettings(changes.settings.oldValue as Record<string, unknown> | undefined);
  const after = migrateSettings(changes.settings.newValue as Record<string, unknown> | undefined);
  for (const e of settingsAuditEvents(before, after)) sendEvent(e.event, e.data);
  refreshBadge();
});

// ---------------------------------------------------------------------------
// Prompt delivery (D19): badge "!", notification, informational in-tab banner.
// Answers come only from extension pages (side panel / prompt.html).
// ---------------------------------------------------------------------------
const BANNER_ID = "tabagent-approval-banner";

function showBanner(tabId: number, text: string) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (id: string, msg: string) => {
        if (document.getElementById(id)) return;
        const d = document.createElement("div");
        d.id = id;
        d.setAttribute("data-tabagent-overlay", "");
        d.setAttribute("aria-hidden", "true");
        d.textContent = msg;
        d.style.cssText = "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#d97706;color:#fff;font:600 13px system-ui,sans-serif;padding:6px 14px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.25)";
        (document.body ?? document.documentElement).appendChild(d);
      },
      args: [BANNER_ID, text],
    })
    .catch(() => {});
}

function hideBanner(tabId: number) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (id: string) => document.getElementById(id)?.remove(),
      args: [BANNER_ID],
    })
    .catch(() => {});
}

function promptEventData(p: PromptInfo) {
  return {
    promptId: p.promptId,
    sessionId: p.sessionId,
    sessionLabel: p.sessionLabel,
    kind: p.kind,
    origin: p.origin,
    level: p.level,
    category: p.sensitive?.category,
    tool: p.tool,
    // Policy changes are audited with their exact canonical diff and stated reason.
    ...(p.sensitive?.category === "p" ? { summary: p.summary } : {}),
  };
}

onPrompt((ev) => {
  const p = ev.info;
  if (ev.type === "added") {
    sendEvent("prompt", promptEventData(p));
    chrome.notifications
      ?.create(`prompt:${p.promptId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: "TabAgent needs your approval",
        message: `${p.sessionLabel}: ${p.kind === "site" ? `${p.level} access to ${p.origin}` : p.summary}`.slice(0, 200),
        requireInteraction: true,
        priority: 2,
      })
      .catch(() => {});
    if (p.tabId != null) showBanner(p.tabId, "TabAgent is waiting for your approval. Open the TabAgent side panel (toolbar icon) to answer.");
    void popPromptWindowIfHidden(p.promptId);
  } else {
    sendEvent("decision", { ...promptEventData(p), answer: ev.outcome });
    chrome.notifications?.clear(`prompt:${p.promptId}`).catch(() => {});
    void closePromptWindows(p.promptId);
    if (p.tabId != null && !prompts.list().some((x) => x.tabId === p.tabId)) hideBanner(p.tabId);
  }
  refreshBadge();
});

/**
 * Notifications are often blocked at the OS level (macOS ships Chrome's off), and a new tab
 * has no page for the banner, so the badge alone is easy to miss and the agent times out.
 * When no TabAgent page that can answer (side panel or prompt window) is open, pop the
 * prompt window so the request is in front of the user.
 */
async function popPromptWindowIfHidden(promptId: string) {
  try {
    const ctxs = await chrome.runtime.getContexts({});
    const answering = ctxs.some((c) => /\/(sidepanel|prompt)\.html/.test(c.documentUrl ?? ""));
    if (answering) return;
    await chrome.windows.create({ url: chrome.runtime.getURL(`prompt.html?id=${promptId}`), type: "popup", width: 460, height: 440, focused: true });
  } catch {
    /* best effort: badge + notification still stand */
  }
}

/** A settled prompt's window is stale; close it so it neither lingers nor masks the next prompt. */
async function closePromptWindows(promptId: string) {
  try {
    const ctxs = await chrome.runtime.getContexts({});
    for (const c of ctxs) {
      if (c.windowId >= 0 && (c.documentUrl ?? "").includes(`/prompt.html?id=${promptId}`)) await chrome.windows.remove(c.windowId).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

chrome.notifications?.onClicked.addListener((nid) => {
  if (!nid.startsWith("prompt:")) return;
  const id = nid.slice("prompt:".length);
  chrome.windows
    .getLastFocused()
    .then((w) => (w?.id != null ? chrome.sidePanel.open({ windowId: w.id }) : Promise.reject()))
    .catch(() => chrome.windows.create({ url: chrome.runtime.getURL(`prompt.html?id=${id}`), type: "popup", width: 460, height: 440, focused: true }))
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// Kill switch (D12)
// ---------------------------------------------------------------------------
async function kill() {
  await updateSettings({ paused: true });
  router.abortAll();
  prompts.dropAll("killed");
  rejectAllFiles(new TabAgentError("KILLED", "The user stopped all agents with the TabAgent kill switch"));
  fireKilled();
  await discardAllCaptures();
  endAllHandoffs();
  for (const t of allCdpTabs()) disposeDrivers(t.tabId);
  await detachAll();
  await clearGrants();
  sendEvent("killed");
  broadcast({ type: "paused", paused: true });
  refreshBadge();
}

async function resume() {
  await updateSettings({ paused: false });
  sendEvent("resumed");
  broadcast({ type: "paused", paused: false });
  refreshBadge();
}

chrome.commands.onCommand.addListener((c) => {
  if (c === "kill-switch") kill();
});
chrome.tabs.onRemoved.addListener((tabId) => void discardCapture(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && change.url) recordManualNavigation(tabId, change.url);
});

// ---------------------------------------------------------------------------
// UI API (side panel + prompt window). Only our own extension pages may call it.
// ---------------------------------------------------------------------------
const UI_KEYS = ["sites", "denylist", "devAllowSensitive", "yolo", "onSessionEnd", "beforeUnload", "showOverlay", "forceLite", "liteSites"] as const;

function publicSettings(s: Settings) {
  const { secret: _s, autoAcceptBeforeUnload: _a, sensitiveAllowed: _x, ...rest } = s;
  return rest;
}

function stoppedTabs() {
  return allCdpTabs()
    .filter((t) => t.userDetached)
    .map((t) => t.tabId);
}

async function uiState() {
  const s = await getSettings();
  const workflowTabs = (await chrome.tabs.query({})).filter((tab) => tab.id != null && /^https?:/i.test(tab.pendingUrl || tab.url || "")).map((tab) => ({ id: tab.id!, title: tab.title || tab.url || `Tab ${tab.id}`, url: tab.pendingUrl || tab.url || "" }));
  return { status: bridge.status(), error: bridge.lastError(), paired: !!s.secret, settings: publicSettings(s), sessions: listSessions(), prompts: pendingPrompts(), feed: feedAll(), workflows: await listWorkflows(), activeCaptures: listActiveCaptures(), workflowTabs, stoppedTabs: stoppedTabs(), handoffs: listHandoffs(), version: VERSION, extensionId: chrome.runtime.id };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const manualEvent = msg?.type === "workflow.manual_event" && sender.id === chrome.runtime.id && sender.tab?.id != null;
  if (!manualEvent && (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))) return false;
  (async () => {
    if (manualEvent) {
      recordManual(sender.tab!.id!, msg.event);
      return { ok: true };
    }
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
      case "ui.kill":
        await kill();
        return { ok: true };
      case "ui.resume":
        await resume();
        return { ok: true };
      case "ui.endSession":
        await endSession(msg.id);
        sendEvent("session.ended", { sessionId: msg.id });
        return { ok: true };
      case "ui.answer":
        return { ok: answerPrompt(msg.promptId ?? msg.id, msg.answer) };
      case "ui.prompt.get":
        return pendingPrompts().find((p) => p.promptId === msg.id) ?? null;
      case "ui.handoff":
        return { ok: endHandoff(Number(msg.tabId), msg.result === "done" ? "done" : "cancel") };
      case "ui.resumeTab": {
        const t = peekCdpTab(Number(msg.tabId));
        if (t) t.userDetached = false;
        broadcast({ type: "stoppedTabs", tabs: stoppedTabs() });
        return { ok: !!t };
      }
      case "ui.settings": {
        const patch: Record<string, unknown> = {};
        for (const k of UI_KEYS) if (msg.patch && k in msg.patch) patch[k] = msg.patch[k];
        const s = await updateSettings(patch);
        return { ok: true, settings: publicSettings(s) };
      }
      case "ui.workflow.list":
        return { workflows: await listWorkflows() };
      case "ui.workflow.review":
        return { workflow: await reviewWorkflow(String(msg.id), msg.approve === true, typeof msg.dedupeKey === "string" ? msg.dedupeKey : undefined, typeof msg.urlIncludes === "string" ? msg.urlIncludes : undefined) };
      case "ui.workflow.remove_step":
        return { workflow: await removeWorkflowStep(String(msg.id), Number(msg.index)) };
      case "ui.workflow.parameterize_step":
        return { workflow: await parameterizeWorkflowStep(String(msg.id), Number(msg.index)) };
      case "ui.workflow.manual_start": {
        const tabId = Number(msg.tabId);
        const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined;
        if (!tab?.id || !/^https?:/i.test(tab.pendingUrl || tab.url || "")) throw new Error("Select a normal web tab before starting manual capture");
        await startCapture(tab.id, "manual", "Manual browser task");
        return { capture: { tabId: tab.id, source: "manual" } };
      }
      case "ui.workflow.manual_stop": {
        const capture = listActiveCaptures().find((entry) => entry.source === "manual");
        if (!capture) throw new Error("No manual capture is active");
        return { recipe: await stopCapture(capture.tabId) };
      }
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
  if (a.name === "tabagent-workflows") {
    void runDueSchedules(new Date(), bridge.connected()).then((runs) => {
      for (const run of runs) sendEvent("workflow.run", { runId: run.id, recipeId: run.recipeId, state: run.state, reason: run.reason ?? "" });
    });
  }
});
chrome.runtime.onStartup.addListener(() => bridge.connect());
chrome.runtime.onInstalled.addListener(() => bridge.connect());

(async () => {
  await restoreSessions();
  await getSettings();
  refreshBadge();
  bridge.connect();
})();

// Exposed for e2e tests via serviceWorker.evaluate.
(globalThis as any).__tabagent = {
  getSettings,
  updateSettings,
  connect: () => bridge.connect(),
  kill,
  resume,
  status: () => bridge.status(),
  features: FEATURES,
  pendingPrompts,
  answerPrompt,
  listSessions,
  feed: feedAll,
  inflight: () => router.inflightCount(),
  badge: async () => ({ text: await chrome.action.getBadgeText({}), state: lastBadge }),
  stoppedTabs,
  debugTabs: async () => Promise.all(allCdpTabs().map(async (t) => ({ tabId: t.tabId, attached: t.attached, children: [...t.children.entries()], inflight: [...t.inflight.keys()].map((k) => [k, t.network.get(k)?.url, t.network.get(k)?.resourceType]), frames: t.attached ? await t.frames().catch((e) => String(e)) : null }))),
  attachedTabs: () => allCdpTabs().filter((t) => t.attached).map((t) => t.tabId),
  runDueSchedules,
};
export type { Status };
