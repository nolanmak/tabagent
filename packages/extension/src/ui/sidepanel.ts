// Side panel (#14): pairing, kill switch, prompts, stopped tabs, sessions, agents (#90),
// activity feed (audit records only) and settings. A view over worker state.
import { answerLabel, type Agent, type AgentSources, type PromptAnswer, type TaskSummary } from "@tabagent/protocol";
import { authEnabled, type StoredPolicy } from "../background/policy";
import { AGENTS_REFRESH_MS, agentFeedLineHtml, agentFeedReducer, agentListHtml, agentRowView, buildAgentSend, composerState, sendTarget, shareableTab, shareTabLabel, sourcesNotes, type AgentFeedAction, type AgentFeedEntry, type SharedTab } from "../pure/agents";
import { markFocus, restoreFocus } from "../pure/focusKeep";
import { isHomeFolder } from "../pure/chat";
import { esc } from "../pure/html";
import { sessionRowHtml, type SessionView } from "../pure/sessionsView";
import { intentOutcome, parseIntent, RECENT_AGENTS_KEY, reconcileSelection, sanitizeRecent, selectionView, SEND_INTENT_KEY, updateRecent, type HeldSelection, type SendIntent } from "../pure/sendIntent";
import { formatRemaining } from "../pure/modeChange";
import { nextOpen, sectionSummaries, type SectionId } from "../pure/panelSections";
import { filterSites } from "../pure/siteFilter";
import { liveDurationText, tasksHtml, tasksSummary } from "../pure/tasksView";
import { workflowStepDetail } from "../pure/workflow";
import { alwaysLabel, authAutoActive, hasCodesAlways, revokeAlways, setAuthAuto, setCodesAlways, setSignIn } from "../pure/siteAuth";
import { AUTH_AUTO_WARNING, applyLevel, authBlockedReason } from "../pure/siteLevel";
import { promptView } from "../pure/promptView";
import { feedReducer, promptReducer, summarizeParams, type FeedEntry, type PromptView } from "./reducers";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;
let state: any = null;
/** Sites search text (#117); kept here so it survives the re-render after every settings change. */
let siteQuery = "";

const CATS = ["a", "b", "c", "d", "e"] as const;
const CAT_LABEL: Record<string, string> = { a: "forms", b: "clicks", c: "JS", d: "creds", e: "files" };

function renderStatus() {
  const st = state.settings.paused ? "paused" : state.status;
  const el = $("status");
  el.textContent =
    st === "connected" ? "Connected" : st === "paused" ? "Stopped" : st === "unpaired" ? "Not paired" : st === "pair-failed" ? "Pairing failed" : st === "version-mismatch" ? "Update needed" : st === "connecting" ? "Connecting…" : "Bridge offline";
  el.className = "conn-status " + st;
  $("pairBox").hidden = state.paired && state.status !== "pair-failed";
  const err = $("pairErr");
  err.hidden = !state.error || (state.status !== "pair-failed" && state.status !== "version-mismatch");
  err.textContent = state.error ?? "";
  ($("pairPort") as HTMLInputElement).placeholder = String(state.settings.port);
  $("killBtn").hidden = !!state.settings.paused;
  $("resumeBtn").hidden = !state.settings.paused;
  $("killNote").textContent = state.settings.paused ? "All agents are stopped. Every command returns KILLED until you resume." : "Shortcut: Alt+Shift+K";
  $("pausedBanner").hidden = !state.settings.paused;
  const until = Number(state.authRestartLockedUntil ?? 0);
  $("restartLock").hidden = !(until > Date.now());
  if (until > Date.now()) $("restartLockText").textContent = `TabAgent restarted during a sign-in, so agents can't type passwords or codes until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
}

function promptHtml(p: any) {
  // #108: the same strings and answers the CLI and the phone page show (pure/promptView).
  const v = promptView(p);
  const btn = (a: string) => `<button data-a="${a}" data-id="${esc(v.promptId)}"${a === "once" ? ' class="primary"' : ""}>${esc(answerLabel(a as PromptAnswer, v.alwaysLabel))}</button>`;
  const left = Math.max(0, Math.round((v.expires - Date.now()) / 1000));
  return `<li class="prompt-item" data-prompt-id="${esc(v.promptId)}">
    <div class="ptitle">${esc(v.title)}</div>
    <div class="muted small pdetail">${esc(v.detail)}</div>
    <div class="muted small psummary">${esc(v.summary)}</div>
    <ul class="preasons reasons">${v.reasons.map((r: string) => `<li>${esc(r)}</li>`).join("")}</ul>
    <div class="pmeta">Tool: <span class="mono">${esc(v.tool)}</span> · <span class="countdown" data-expires="${Number(v.expires)}">${left}s</span></div>
    <div class="actions">${v.answers.map(btn).join("")}</div>
  </li>`;
}

function renderPrompts() {
  $("promptsBox").hidden = !state.prompts.length;
  $("prompts").innerHTML = state.prompts.map(promptHtml).join("");
  $("promptsCount").textContent = state.prompts.length > 1 ? String(state.prompts.length) : "";
}

function renderStopped() {
  const tabs: number[] = state.stoppedTabs ?? [];
  $("stoppedBox").hidden = !tabs.length;
  $("stopped").innerHTML = tabs.map((t) => `<li><span>Tab ${t}</span><button class="sm" data-resume-tab="${t}">Resume</button></li>`).join("");
}

function renderHandoffs() {
  const list: any[] = state.handoffs ?? [];
  $("handoffBox").hidden = !list.length;
  $("handoffs").innerHTML = list
    .map((h) => `<li data-handoff-tab="${Number(h.tabId)}"><span><b>${esc(h.sessionLabel)}</b> · ${esc(h.origin)}<br><span class="muted small">${esc(h.reason)}</span></span><span class="actions"><button data-handoff="cancel" data-tab="${Number(h.tabId)}">Cancel</button> <button data-handoff="done" data-tab="${Number(h.tabId)}" class="primary">Done</button></span></li>`)
    .join("");
  window.dispatchEvent(new CustomEvent("tabagent:handoffs", { detail: list }));
}

function renderSessions() {
  const ul = $("sessions");
  if (!state.sessions.length) {
    ul.innerHTML = `<li class="empty-row">No sessions.</li>`;
  } else ul.innerHTML = (state.sessions as SessionView[]).map(sessionRowHtml).join("");
  renderSections();
}

let sessionsNoticeTimer: ReturnType<typeof setTimeout> | undefined;
/** A short-lived message under the Sessions list, e.g. "Tab closed" (#133). */
function sessionsNotice(text: string) {
  const el = $("sessionsNotice");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(sessionsNoticeTimer);
  sessionsNoticeTimer = setTimeout(() => (el.hidden = true), 4000);
}

function feedLine(e: FeedEntry) {
  const t = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const tool = e.action ? `${e.tool} ${e.action}` : e.tool;
  const detail = [e.origin ?? "", summarizeParams(e.params)].filter(Boolean).join(" ");
  return `<li data-feed-id="${e.id}"><span class="f-time">${esc(t)}</span><span class="f-main"><b>${esc(e.label)}</b> <span class="f-tool">${esc(tool)}</span>${detail ? `<span class="f-detail" title="${esc(detail)}">${esc(detail)}</span>` : ""}</span><span class="f-status ${esc(e.status)}">${esc(e.status)}${e.errorCode ? ` ${esc(e.errorCode)}` : ""}${e.ms != null ? `<span class="ms">${e.ms}ms</span>` : ""}</span></li>`;
}

function renderFeed() {
  $("feed").innerHTML = state.feed.slice().reverse().map(feedLine).join("") || `<li class="empty">Nothing yet.</li>`;
  renderSections();
}

// ---------------------------------------------------------------------------
// Collapsible sections (#156): closed by default, opened on their own when they need attention, and kept the
// way the user left them. Counts and a short summary show while closed. Decisions in ../pure/panelSections.
// ---------------------------------------------------------------------------
const SECTIONS: Exclude<SectionId, "settings">[] = ["sessions", "activity", "workflows"];
const touchedSections = new Set<string>();

function renderSections() {
  if (!state) return;
  const sum = sectionSummaries({
    sessions: state.sessions ?? [],
    feed: state.feed ?? [],
    workflows: state.workflows ?? [],
    capturing: (state.activeCaptures ?? []).some((c: any) => c.source === "manual"),
  });
  for (const id of SECTIONS) {
    const box = $(`${id}Box`) as HTMLDetailsElement;
    const open = nextOpen(box.open, sum[id].attention, touchedSections.has(id));
    if (box.open !== open) box.open = open;
    $(`${id}Count`).textContent = sum[id].count;
    $(`${id}Meta`).textContent = sum[id].meta;
  }
}

// ---------------------------------------------------------------------------
// Agents (#90, spec §7): list, composer and send feed. The decisions live in ../pure/agents.
// ---------------------------------------------------------------------------
let agents: Agent[] = [];
let agentSources: AgentSources | undefined;
let agentsLoaded = false;
let agentsError = "";
let agentsInFlight = false;
let selectedAgentId: string | null = null;
let agentNotice = "";
let agentSending = false;
let agentSendFeed: AgentFeedEntry[] = [];
/** #137: the "N other sessions" disclosure is open. */
let agentsOtherOpen = false;
/** The active tab as it would be shared; re-read at Send time. */
let activeTab: SharedTab | null = null;
/** The active tab's id, shareable or not; undefined until first read. */
let activeTabId: number | null | undefined;
/** #92: a context-menu intent waiting for the agent list, and the selection it brought. */
let pendingIntent: SendIntent | null = null;
let heldSelection: HeldSelection | null = null;
let selectionDropped = false;

const agentsVisible = () => !!state?.agentsSupported;
const agentPrompt = () => $("agentPrompt") as HTMLTextAreaElement;
const shareTab = () => ($("agentShareTab") as HTMLInputElement).checked;
const selectionBox = () => $("agentSelection") as HTMLInputElement;
/** The selection that would be sent: held, ticked and with the tab shared (AD12). */
const outgoingSelection = () => (heldSelection && selectionBox().checked && shareTab() ? heldSelection.text : null);

function selectedAgentView() {
  const a = agents.find((x) => x.id === selectedAgentId);
  return a ? agentRowView(a, Date.now()) : null;
}

/** Set innerHTML only when it changed, so the 5 s refresh does not swallow a click mid-press. */
function setHtml(el: HTMLElement, html: string) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

/** The list markup last written; the live list also holds the moved composer, so innerHTML can't be compared. */
let lastAgentsHtml = "";

function renderAgentList() {
  const now = Date.now();
  const html = !agentsLoaded
    ? `<li class="empty">Looking for agents…</li>`
    : agentsError
      ? `<li class="err small">${esc(agentsError)}</li>`
      : agentListHtml(agents.map((a) => agentRowView(a, now)), selectedAgentId, agentsOtherOpen) || `<li class="empty">No agents running. Start Claude Code or Codex on this computer.</li>`;
  $("agentsCount").textContent = agentsLoaded && !agentsError && agents.length ? String(agents.length) : "";
  if (html !== lastAgentsHtml) {
    // #151: the Quick send composer sits inside the list; park it (keeping its text) while the rows are rebuilt.
    const focused = document.activeElement as HTMLTextAreaElement | null;
    const keepFocus = focused && $("agentComposer").contains(focused) ? { el: focused, start: focused.selectionStart, end: focused.selectionEnd } : null;
    // #159: a row (or its Quick send button) that had keyboard focus gets it back after the rebuild.
    const rowFocus = markFocus($("agents"), "data-agent-id", focused);
    $("composerPark").append($("agentComposer"));
    $("agents").innerHTML = html;
    lastAgentsHtml = html;
    placeComposer();
    restoreFocus($("agents"), "data-agent-id", rowFocus);
    if (keepFocus && $("agentComposer").isConnected && !$("composerPark").contains(keepFocus.el)) {
      keepFocus.el.focus();
      if (keepFocus.start != null && "setSelectionRange" in keepFocus.el) keepFocus.el.setSelectionRange(keepFocus.start, keepFocus.end ?? keepFocus.start);
    }
  } else placeComposer();
  const notes = sourcesNotes(agentSources);
  $("agentSources").hidden = !notes.length;
  $("agentSources").textContent = notes.join(" · ");
  $("agentNotice").hidden = !agentNotice || !!selectedAgentId;
  $("agentNotice").textContent = agentNotice;
}

/** #151: Quick send opens the composer directly under its row, never at the bottom of the list. */
function placeComposer() {
  const comp = $("agentComposer");
  const row = selectedAgentId ? $("agents").querySelector<HTMLElement>(`li[data-agent-id="${CSS.escape(selectedAgentId)}"]`) : null;
  if (!row) {
    if (comp.parentElement !== $("composerPark")) $("composerPark").append(comp);
    return;
  }
  let slot = row.nextElementSibling;
  if (!slot?.classList.contains("quick-send")) {
    slot = document.createElement("li");
    slot.className = "quick-send";
    slot.setAttribute("role", "none");
    row.after(slot);
  }
  if (comp.parentElement !== slot) slot.append(comp);
}

function renderComposer() {
  const v = selectedAgentView();
  const sv = selectionView({ selection: heldSelection, dropped: selectionDropped, shareOn: shareTab() });
  selectionBox().disabled = !sv.enabled;
  if (!heldSelection) selectionBox().checked = false;
  $("agentSelectionPreview").textContent = sv.text;
  const c = composerState({ agent: v, prompt: agentPrompt().value, share: shareTab() ? activeTab : null, selection: outgoingSelection() });
  const btn = $("agentSend") as HTMLButtonElement;
  btn.textContent = c.label;
  btn.disabled = !c.canSend || agentSending;
  // #137/#159: the separate "Start a new session in <folder>" button, only for sessions that can't be messaged.
  const spawn = $("agentSpawn") as HTMLButtonElement;
  // Claude Code refuses background sessions in a home folder, so don't offer Start there.
  const homeCwd = !!v && isHomeFolder(v.cwd);
  spawn.hidden = !c.spawnLabel || homeCwd;
  spawn.textContent = c.spawnLabel ?? "";
  spawn.disabled = !c.canSpawn || agentSending || homeCwd;
  $("agentShareLabel").textContent = shareTabLabel(v);
  $("agentComposerNote").textContent = c.note;
  const target = $("agentTarget");
  target.hidden = !v;
  target.innerHTML = v ? `To <b>${esc(v.title)}</b> <span class="muted">(${esc(v.vendorLabel)}, ${esc(v.connection.label)})</span>` : "";
  $("agentTabTitle").textContent = activeTab ? `(${activeTab.title || activeTab.url})` : "(no web page in this tab)";
}

function renderAgentFeed() {
  setHtml($("agentFeed"), agentSendFeed.slice().reverse().map(agentFeedLineHtml).join(""));
}

function renderAgentsBox() {
  $("agentsBox").hidden = !agentsVisible();
  if (!agentsVisible()) return;
  renderAgentList();
  renderComposer();
  renderAgentFeed();
}

function agentFeed(a: AgentFeedAction) {
  agentSendFeed = agentFeedReducer(agentSendFeed, a);
  renderAgentFeed();
}

async function readActiveTab(): Promise<SharedTab | null> {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = t?.id ?? null;
    reconcileHeldSelection();
    return shareableTab(t);
  } catch {
    return null;
  }
}

/** AD14: a selection belongs to the tab it was made in; switching tabs drops it. */
function reconcileHeldSelection() {
  const r = reconcileSelection(heldSelection, activeTabId);
  heldSelection = r.selection;
  if (r.dropped) selectionDropped = true;
}

async function refreshActiveTab() {
  activeTab = await readActiveTab();
  if (agentsVisible()) renderComposer();
}

/**
 * #92: take the context menu's pending intent, if any (AD14). Each window has its own panel, so a panel takes
 * only intents for a tab in its own window and leaves the rest for theirs. Stale or unusable intents are cleared.
 */
async function takeIntent() {
  try {
    const raw = (await chrome.storage.session.get(SEND_INTENT_KEY))[SEND_INTENT_KEY];
    if (raw === undefined) return;
    const intent = parseIntent(raw, Date.now());
    const where = intent ? await intentWindow(intent.tabId) : "gone";
    if (where === "other") return;
    await chrome.storage.session.remove(SEND_INTENT_KEY);
    if (!intent || where === "gone") return;
    pendingIntent = intent;
  } catch {
    return;
  }
  applyPendingIntent();
}

async function intentWindow(tabId: number): Promise<"mine" | "other" | "gone"> {
  const [tab, win] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), chrome.windows.getCurrent()]);
  if (!tab) return "gone";
  return tab.windowId === win.id ? "mine" : "other";
}

/** Apply the intent once the agent list is loaded, so the agent can be checked against it. */
function applyPendingIntent() {
  if (!pendingIntent || !agentsLoaded) return;
  const o = intentOutcome(pendingIntent, agents.map((a) => a.id));
  pendingIntent = null;
  if (o.select !== undefined) {
    selectedAgentId = o.select;
    agentNotice = o.notice;
  }
  heldSelection = o.selection;
  selectionDropped = false;
  selectionBox().checked = !!o.selection;
  // Re-read the active tab rather than trust an earlier read that may predate the right-click.
  activeTabId = undefined;
  if (agentsVisible()) {
    renderAgentsBox();
    agentPrompt().focus();
  }
  void refreshActiveTab();
}

/** A successful send makes the agent the first entry in the context menu's recent list. */
async function rememberRecent(agent: { id: string; name: string }) {
  try {
    const cur = sanitizeRecent((await chrome.storage.local.get(RECENT_AGENTS_KEY))[RECENT_AGENTS_KEY]);
    await chrome.storage.local.set({ [RECENT_AGENTS_KEY]: updateRecent(cur, agent) });
  } catch {
    /* best effort: the menu just keeps its old list */
  }
}

// ---------------------------------------------------------------------------
// #158 Tasks: summaries come from the bridge (built from the audit log). Re-listed when the section is shown,
// on tasks.changed (at most once a second) and after a label; running timers tick locally.
// ---------------------------------------------------------------------------
let tasks: TaskSummary[] = [];
let openTaskId: string | null = null;
let tasksError = "";
let tasksInFlight = false;
let tasksTimer: ReturnType<typeof setTimeout> | null = null;
const TASKS_THROTTLE_MS = 1000;
const TASKS_LIMIT = 50;

function renderTasks() {
  if (!state) return;
  const box = $("tasksBox") as HTMLDetailsElement;
  box.hidden = !state.tasksSupported;
  if (box.hidden) return;
  const list = $("tasks");
  const mark = markFocus(list, "data-task-id", document.activeElement);
  const scroll = list.scrollTop;
  list.innerHTML = tasksHtml(tasks, Date.now(), openTaskId);
  list.scrollTop = scroll;
  restoreFocus(list, "data-task-id", mark);
  const sum = tasksSummary(tasks);
  $("tasksCount").textContent = sum.count;
  $("tasksMeta").textContent = sum.meta;
  $("tasksError").hidden = !tasksError;
  $("tasksError").textContent = tasksError;
}

async function refreshTasks() {
  if (!state?.tasksSupported || document.hidden) return;
  if (tasksInFlight) return scheduleTasks();
  tasksInFlight = true;
  try {
    const r = await send({ type: "ui.tasks_list", limit: TASKS_LIMIT, ...(openTaskId ? { calls: openTaskId } : {}) });
    if (r?.supported === false) state.tasksSupported = false;
    else tasks = Array.isArray(r?.tasks) ? r.tasks : [];
    tasksError = "";
  } catch (e) {
    tasksError = `Could not list tasks: ${String((e as Error)?.message ?? e)}`;
  } finally {
    tasksInFlight = false;
  }
  renderTasks();
}

/** Coalesce bursts of tasks.changed (one per tool call) into one re-list a second. */
function scheduleTasks() {
  if (tasksTimer) return;
  tasksTimer = setTimeout(() => {
    tasksTimer = null;
    void refreshTasks();
  }, TASKS_THROTTLE_MS);
}

async function refreshAgents() {
  // §5: only while the panel is visible; visibilitychange refreshes when it is shown again.
  if (!agentsVisible() || agentsInFlight || document.hidden) return;
  agentsInFlight = true;
  try {
    const r = await send({ type: "ui.agents_list" });
    if (r?.supported === false) {
      state.agentsSupported = false;
      renderAgentsBox();
      return;
    }
    if (r?.error) throw new Error(r.error);
    agents = r?.agents ?? [];
    agentSources = r?.sources;
    agentsError = "";
  } catch (e) {
    agents = [];
    agentSources = undefined;
    agentsError = `Could not list agents: ${String((e as Error)?.message ?? e)}`;
  } finally {
    agentsInFlight = false;
    agentsLoaded = true;
  }
  if (selectedAgentId && !agents.some((a) => a.id === selectedAgentId)) {
    selectedAgentId = null;
    agentNotice = "The selected agent is no longer running.";
  }
  renderAgentsBox();
  applyPendingIntent();
}

/** #151: Quick send toggles the composer under that row. */
function toggleQuickSend(id: string) {
  selectedAgentId = selectedAgentId === id ? null : id;
  agentNotice = "";
  renderAgentsBox();
  if (selectedAgentId) agentPrompt().focus();
}

/** #151: a row opens the agent's chat page (an existing chat tab for it is reused). */
async function openChat(id: string) {
  const r = await send({ type: "ui.agent_open_chat", agentId: id }).catch((e) => ({ error: String(e) }));
  if (r?.error) {
    agentNotice = `Could not open the chat: ${r.error}`;
    renderAgentsBox();
  }
}

/** `forceSpawn`: the explicit Start a new session button (#137). Plain Send never spawns. */
async function sendToSelectedAgent(forceSpawn = false) {
  const v = selectedAgentView();
  if (!v || agentSending) return;
  if (forceSpawn && !v.spawnLabel) return;
  const prompt = agentPrompt().value;
  // AD12: title and url are read at Send time, not from the label shown earlier.
  // AD14: re-check the active tab now too, so a tab switch the panel missed still drops the selection.
  const current = await readActiveTab();
  const share = shareTab() ? current : null;
  if (shareTab()) activeTab = share;
  const selection = outgoingSelection();
  const c = composerState({ agent: v, prompt, share, selection });
  if (!(forceSpawn ? c.canSpawn : c.canSend)) return renderComposer();
  const requestId = crypto.randomUUID();
  const t = sendTarget(v, forceSpawn);
  agentFeed({ type: "sending", requestId, ts: Date.now(), agentName: t.agentName, vendor: v.vendor, route: t.route });
  agentSending = true;
  renderComposer();
  let r: any;
  try {
    r = await send(buildAgentSend({ requestId, agentId: v.id, prompt, share, selection, forceSpawn }));
  } catch (e) {
    r = { error: String((e as Error)?.message ?? e) };
  }
  agentSending = false;
  if (r?.type === "agent.sent") agentFeed({ type: "sent", msg: r });
  else agentFeed({ type: "sent", msg: { requestId, route: t.route, state: "failed", detail: r?.error ?? "TabAgent did not answer" } });
  // Keep the text after a failure so it can be retried.
  if (r?.type === "agent.sent" && r.state !== "failed") {
    agentPrompt().value = "";
    // The selection went with this message; the next one starts without it.
    if (selection) heldSelection = null;
    // A new session is not this agent, so it does not go in the context menu's recent list.
    if (!forceSpawn) void rememberRecent({ id: v.id, name: v.title });
  }
  renderComposer();
}

function renderWorkflows() {
  const list: any[] = state.workflows ?? [];
  const manual = (state.activeCaptures ?? []).find((capture: any) => capture.source === "manual");
  $("manualCaptureStart").hidden = !!manual;
  $("manualCaptureStop").hidden = !manual;
  $("manualCaptureState").textContent = manual ? `Recording tab ${manual.tabId}` : "";
  const tabSelect = $("manualCaptureTab") as HTMLSelectElement;
  tabSelect.disabled = !!manual;
  const previous = tabSelect.value;
  tabSelect.innerHTML = (state.workflowTabs ?? []).map((tab: any) => `<option value="${Number(tab.id)}">${esc(tab.title).slice(0, 80)}</option>`).join("") || `<option value="">No web tabs available</option>`;
  if ([...tabSelect.options].some((option) => option.value === previous)) tabSelect.value = previous;
  $("workflows").innerHTML = list
    .map((w) => {
      const steps = (w.steps ?? []).map((step: any, index: number) => {
        const detail = workflowStepDetail(step);
        const parameter = w.status === "draft" && step.kind === "input" && step.value?.kind === "fixed" ? ` <button class="ghost" data-parameterize-workflow-step="${esc(w.id)}" data-step-index="${index}" aria-label="Make step ${index + 1} a parameter">Make parameter</button>` : "";
        const placeholder = step.value?.kind === "parameter" ? ` (${step.value.placeholder})` : "";
        return `<li><span class="step-text">${esc(step.kind)}: ${esc(detail)}${esc(placeholder)}</span>${w.status === "draft" ? `<button class="ghost" data-delete-workflow-step="${esc(w.id)}" data-step-index="${index}" aria-label="Remove step ${index + 1}">Remove</button>${parameter}` : ""}</li>`;
      }).join("");
      const tag = w.status === "draft" ? "warn" : w.status === "reviewed" ? "ok" : "";
      return `<li class="recipe"><div class="recipe-head"><b>${esc(w.name)}</b> <span class="tag ${tag}">${esc(w.status)}</span></div><div class="recipe-meta">${Number(w.steps?.length ?? 0)} steps · ${esc(w.source)}</div><div class="recipe-rules">${esc((w.stopRules ?? []).join("; "))}</div>${w.dedupeKey ? `<div class="recipe-rules">Duplicate key: ${esc(w.dedupeKey)}</div>` : ""}<ol class="workflow-steps">${steps}</ol>${w.status === "draft" ? `<div class="recipe-review"><input data-dedupe-key="${esc(w.id)}" maxlength="200" placeholder="Optional duplicate key" aria-label="Duplicate key for ${esc(w.name)}"/><input data-url-assertion="${esc(w.id)}" maxlength="500" placeholder="Optional final URL must contain" aria-label="Expected final URL for ${esc(w.name)}"/><button class="primary" data-review-workflow="${esc(w.id)}">Review & approve</button></div>` : ""}</li>`;
    })
    .join("") || `<li class="empty">No captured recipes yet.</li>`;
  renderSections();
}

/** #109: a timed YOLO (policy.mode_change durationMin) shows the time left; the worker switches it off. */
function renderYoloExpiry() {
  const at = state?.settings?.yolo ? state.settings.yoloExpiresAt : null;
  const el = $("yoloExpiry");
  el.hidden = typeof at !== "number";
  el.textContent = typeof at === "number" ? `Switches off automatically in ${formatRemaining(at - Date.now())}.` : "";
}

function renderSettings() {
  const s = state.settings;
  ($("onSessionEnd") as HTMLSelectElement).value = s.onSessionEnd;
  ($("beforeUnload") as HTMLSelectElement).value = s.beforeUnload;
  ($("showOverlay") as HTMLInputElement).checked = s.showOverlay;
  ($("forceLite") as HTMLInputElement).checked = s.forceLite;
  ($("devAllowSensitive") as HTMLInputElement).checked = s.devAllowSensitive;
  ($("yolo") as HTMLInputElement).checked = !!s.yolo;
  ($("outsideApprovals") as HTMLInputElement).checked = !!s.outsideApprovals;
  $("phoneLinkRow").hidden = !s.outsideApprovals;
  $("yoloBanner").hidden = !s.yolo;
  renderYoloExpiry();
  if (document.activeElement !== $("denylist")) ($("denylist") as HTMLTextAreaElement).value = s.denylist.join("\n");
  renderSites();
  $("about").textContent = `v${state.version} · extension id ${state.extensionId}`;
}

/** #131: the Sign-in column. Allowed, without asking, codes-always, then each Always grant with a ✕. */
function signInCell(o: string, e: any): string {
  const s = state.settings;
  const blocked = authBlockedReason(o, s);
  const off = blocked ? ` disabled title="${esc(blocked.replace(/^Sign-in was not turned on: /, ""))}"` : "";
  const auto = authAutoActive(e, o, s);
  const grants = (e.authAlways ?? []) as string[];
  const list = grants.length
    ? `<ul class="always">${grants.map((id) => `<li class="chip">${esc(alwaysLabel(id))}<button type="button" data-revoke-always="${esc(id)}" data-origin="${esc(o)}" aria-label="Remove Always for ${esc(alwaysLabel(id))}" title="Remove this Always grant">✕</button></li>`).join("")}</ul>`
    : "";
  return `<td class="signin">
    <label class="chip" title="Let agents sign in here with your saved accounts (each sign-in asks unless allowed below)"><input type="checkbox" data-auth data-origin="${esc(o)}" ${authEnabled(e, o, !!s.yolo) ? "checked" : ""}/>allowed</label>
    <label class="chip" title="Sign in and enter codes here without asking"><input type="checkbox" data-auth-auto data-origin="${esc(o)}" ${auto ? "checked" : ""}${off}/>without asking</label>
    <label class="chip" title="Always allow texted and emailed codes here"><input type="checkbox" data-codes-always data-origin="${esc(o)}" ${hasCodesAlways(e) ? "checked" : ""}${off}/>codes always</label>
    ${list}${auto ? `<div class="signin-warn small">${esc(AUTH_AUTO_WARNING)}</div>` : ""}</td>`;
}

function renderSites() {
  const { rows, total } = filterSites((state.settings.sites ?? {}) as Record<string, any>, siteQuery);
  const filtering = siteQuery.trim() !== "";
  $("siteCount").textContent = `${filtering ? `${rows.length} of ` : ""}${total} site${total === 1 ? "" : "s"}`;
  $("siteSearchClear").hidden = siteQuery === "";
  $("sites").innerHTML =
    rows
      .map(([o, e]) => {
        const pol = e.policy ?? "ask";
        const pre = CATS.map((c) => `<label class="chip" title="Pre-approve ${CAT_LABEL[c]} on this site"><input type="checkbox" data-pre="${c}" data-origin="${esc(o)}" ${e.preapproved?.[c] ? "checked" : ""}/>${CAT_LABEL[c]}</label>`).join("");
        return `<tr data-site="${esc(o)}"><td class="origin">${esc(o)}</td><td class="policy"><select data-policy data-origin="${esc(o)}" aria-label="Policy for ${esc(o)}">${["ask", "read", "act", "full", "deny"].map((x) => `<option ${x === pol ? "selected" : ""}>${x}</option>`).join("")}</select></td><td class="lite"><label class="chip" title="Lite mode on this site (no debugger)"><input type="checkbox" data-lite data-origin="${esc(o)}" ${e.lite ? "checked" : ""}/>lite</label></td><td class="pre">${pre}</td>${signInCell(o, e)}<td class="del"><button data-del="${esc(o)}" title="Revoke everything for this site" aria-label="Remove ${esc(o)}">✕</button></td></tr>`;
      })
      .join("") || `<tr><td colspan="6" class="muted">${filtering && total ? "No sites match." : "No site settings yet."}</td></tr>`;
}

function render() {
  if (!state) return;
  renderStatus();
  renderPrompts();
  renderStopped();
  renderHandoffs();
  renderSessions();
  renderAgentsBox();
  renderFeed();
  renderWorkflows();
  renderTasks();
  renderSettings();
}

async function refresh() {
  state = await send({ type: "ui.state" });
  render();
  void refreshAgents();
  void refreshTasks();
}

chrome.runtime.onMessage.addListener((m: any) => {
  if (!state) return;
  switch (m.type) {
    case "feed":
      state.feed = feedReducer(state.feed, m.entry);
      renderFeed();
      break;
    case "prompts":
      state.prompts = promptReducer(state.prompts as PromptView[], { type: "replace", prompts: m.prompts });
      renderPrompts();
      break;
    case "sessions":
      state.sessions = m.sessions;
      renderSessions();
      break;
    case "handoffs":
      state.handoffs = m.handoffs;
      renderHandoffs();
      break;
    case "agent.status":
      agentFeed({ type: "status", msg: m });
      break;
    case "stoppedTabs":
      state.stoppedTabs = m.tabs;
      renderStopped();
      break;
    case "tasks.changed":
      scheduleTasks();
      break;
    case "status":
    case "paused":
    case "settings":
      refresh();
      break;
  }
});

// #156: a section the user opened or closed stays that way (summary clicks include Enter and Space).
for (const id of SECTIONS) $(`${id}Box`).querySelector("summary")!.addEventListener("click", () => touchedSections.add(id));
$("tasksBox").addEventListener("toggle", () => {
  if (($("tasksBox") as HTMLDetailsElement).open) void refreshTasks();
});
$("tasks").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.taskToggle) {
    openTaskId = openTaskId === b.dataset.taskToggle ? null : b.dataset.taskToggle;
    renderTasks();
    // The list carries calls for the opened task only: fetch them.
    if (openTaskId) void refreshTasks();
    return;
  }
  if (b.dataset.taskLabel && b.dataset.task) {
    b.disabled = true;
    const r = await send({ type: "ui.tasks_label", taskId: b.dataset.task, outcome: b.dataset.taskLabel }).catch((err) => ({ ok: false, code: String(err) }));
    tasksError = r?.ok ? "" : `Could not label the task (${r?.code ?? "error"})`;
    void refreshTasks();
  }
});

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = ($("pairCode") as HTMLInputElement).value;
  const port = ($("pairPort") as HTMLInputElement).value;
  await send({ type: "ui.pair", code, port: port || undefined });
  setTimeout(refresh, 400);
});
$("killBtn").addEventListener("click", () => send({ type: "ui.kill" }).then(refresh));
$("resumeBtn").addEventListener("click", () => send({ type: "ui.resume" }).then(refresh));
$("endRestartLock").addEventListener("click", () => send({ type: "ui.endRestartLock" }).then(refresh));
$("prompts").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.id) return;
  await send({ type: "ui.answer", promptId: b.dataset.id, answer: b.dataset.a });
  state.prompts = promptReducer(state.prompts, { type: "removed", promptId: b.dataset.id });
  renderPrompts();
});
$("stopped").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.resumeTab) send({ type: "ui.resumeTab", tabId: Number(b.dataset.resumeTab) }).then(refresh);
});
$("handoffs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.handoff) send({ type: "ui.handoff", tabId: Number(b.dataset.tab), result: b.dataset.handoff }).then(refresh);
});
$("sessions").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.end) return send({ type: "ui.endSession", id: b.dataset.end }).then(refresh);
  if (b?.dataset.viewTab) {
    const res = await send({ type: "ui.focusTab", tabId: Number(b.dataset.viewTab) });
    if (res?.error) {
      sessionsNotice(res.error);
      void refresh();
    }
  }
});
$("agents").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // The Quick send composer lives inside the list; links (Open in Claude, How to connect) open themselves.
  if (t.closest(".quick-send, a, summary")) return;
  const quick = t.closest<HTMLElement>("[data-quick-send]")?.dataset.quickSend;
  if (quick) return toggleQuickSend(quick);
  const id = t.closest<HTMLElement>("li[data-agent-id]")?.dataset.agentId;
  if (id) void openChat(id);
});
$("agents").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const t = e.target as HTMLElement;
  // Only the row itself: leave the composer, buttons, links and the disclosure to their own keys.
  if (!t.matches("li[data-agent-id]")) return;
  e.preventDefault();
  void openChat(t.dataset.agentId!);
});
// #137: remember whether "N other sessions" is open across the 5 s re-render. `toggle` does not bubble.
$("agents").addEventListener(
  "toggle",
  (e) => {
    if (e.target instanceof HTMLDetailsElement) agentsOtherOpen = e.target.open;
  },
  true,
);
agentPrompt().addEventListener("input", renderComposer);
agentPrompt().addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void sendToSelectedAgent();
  }
});
$("agentShareTab").addEventListener("change", renderComposer);
$("agentSelection").addEventListener("change", renderComposer);
// #92: an intent written while the panel is already open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[SEND_INTENT_KEY]?.newValue !== undefined) void takeIntent();
});
$("agentSend").addEventListener("click", () => void sendToSelectedAgent());
// #137: the only way to start a new session is this separate, explicitly labelled button.
$("agentSpawn").addEventListener("click", () => void sendToSelectedAgent(true));
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.title || info.url)) void refreshActiveTab();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refreshTasks();
  void refreshAgents();
  void refreshActiveTab();
});
$("workflows").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.deleteWorkflowStep) {
    send({ type: "ui.workflow.remove_step", id: b.dataset.deleteWorkflowStep, index: Number(b.dataset.stepIndex) }).then(refresh);
    return;
  }
  if (b?.dataset.parameterizeWorkflowStep) {
    send({ type: "ui.workflow.parameterize_step", id: b.dataset.parameterizeWorkflowStep, index: Number(b.dataset.stepIndex) }).then(refresh);
    return;
  }
  if (b?.dataset.reviewWorkflow) {
    const id = b.dataset.reviewWorkflow;
    const key = document.querySelector<HTMLInputElement>(`input[data-dedupe-key="${CSS.escape(id)}"]`)?.value;
    const urlIncludes = document.querySelector<HTMLInputElement>(`input[data-url-assertion="${CSS.escape(id)}"]`)?.value;
    send({ type: "ui.workflow.review", id, approve: true, dedupeKey: key, urlIncludes }).then(refresh);
  }
});
$("manualCaptureStart").addEventListener("click", () => send({ type: "ui.workflow.manual_start", tabId: Number(($("manualCaptureTab") as HTMLSelectElement).value) }).then(refresh));
$("manualCaptureStop").addEventListener("click", () => send({ type: "ui.workflow.manual_stop" }).then(refresh));

const patch = (p: unknown) => send({ type: "ui.settings", patch: p }).then(refresh);
const sites = () => structuredClone(state.settings.sites ?? {}) as Record<string, any>;
for (const id of ["onSessionEnd", "beforeUnload"]) $(id).addEventListener("change", (e) => patch({ [id]: (e.target as HTMLSelectElement).value }));
for (const id of ["showOverlay", "forceLite", "devAllowSensitive", "yolo", "outsideApprovals"]) $(id).addEventListener("change", (e) => patch({ [id]: (e.target as HTMLInputElement).checked }));
// #108: a one-time link to approve prompts from a phone (tailnet only). Clicking here is the presence proof.
$("phoneLinkBtn").addEventListener("click", async () => {
  const out = $("phoneLink");
  out.hidden = false;
  out.textContent = "Asking the bridge…";
  const r = await send({ type: "ui.approvals.phoneLink" }).catch((e) => ({ ok: false, error: { message: String(e) } }));
  out.textContent = r?.ok && r.url ? `${r.url}\nOne-time link, valid until ${new Date(r.expiresAt).toLocaleTimeString()}. Open it on your phone; it works for one device only.` : `No phone link: ${r?.error?.message ?? "the bridge did not answer"}${r?.error?.hint ? ` (${r.error.hint})` : ""}`;
});

/** Why choosing full did not turn on sign-in (#118), or the sign-in-without-asking warning (#131). */
function showLevelNote(note: string | undefined) {
  const el = $("siteLevelNote");
  el.textContent = note ?? "";
  el.hidden = !note;
}
$("sites").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const o = el.dataset.origin;
  if (!o) return;
  const all = sites();
  const entry = (all[o] ??= {});
  const on = (el as HTMLInputElement).checked;
  if ("policy" in el.dataset) {
    const r = applyLevel(entry, el.value as StoredPolicy | "ask", o, state.settings);
    all[o] = r.entry;
    showLevelNote(r.note ?? r.warning);
  } else if ("lite" in el.dataset) {
    if (on) entry.lite = true;
    else delete entry.lite;
  } else if ("auth" in el.dataset) {
    all[o] = setSignIn(entry, on, o, state.settings);
  } else if ("authAuto" in el.dataset) {
    const r = setAuthAuto(entry, on, o, state.settings);
    all[o] = r.entry;
    showLevelNote(r.note ?? r.warning);
  } else if ("codesAlways" in el.dataset) {
    const r = setCodesAlways(entry, on, o, state.settings);
    all[o] = r.entry;
    showLevelNote(r.note);
  } else if (el.dataset.pre) {
    entry.preapproved = { ...(entry.preapproved ?? {}) };
    if ((el as HTMLInputElement).checked) entry.preapproved[el.dataset.pre] = true;
    else delete entry.preapproved[el.dataset.pre];
  }
  patch({ sites: all });
});
$("sites").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.revokeAlways && b.dataset.origin) {
    const all = sites();
    all[b.dataset.origin] = revokeAlways(all[b.dataset.origin], b.dataset.revokeAlways);
    patch({ sites: all });
    return;
  }
  if (!b?.dataset.del) return;
  const all = sites();
  delete all[b.dataset.del];
  patch({ sites: all });
});
const siteSearch = $("siteSearch") as HTMLInputElement;
const setSiteQuery = (q: string) => {
  siteQuery = q;
  if (siteSearch.value !== q) siteSearch.value = q;
  if (state) renderSites();
};
siteSearch.addEventListener("input", () => setSiteQuery(siteSearch.value));
siteSearch.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !siteSearch.value) return;
  e.preventDefault();
  setSiteQuery("");
});
$("siteSearchClear").addEventListener("click", () => {
  setSiteQuery("");
  siteSearch.focus();
});
$("addSite").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = ($("newOrigin") as HTMLInputElement).value.trim();
  let origin: string;
  try {
    origin = new URL(/^https?:/.test(raw) ? raw : "https://" + raw).origin;
  } catch {
    return;
  }
  const all = sites();
  const r = applyLevel(all[origin], ($("newLevel") as HTMLSelectElement).value as StoredPolicy, origin, state.settings);
  all[origin] = r.entry;
  showLevelNote(r.note ?? r.warning);
  patch({ sites: all });
  ($("newOrigin") as HTMLInputElement).value = "";
});
$("saveDenylist").addEventListener("click", () =>
  patch({
    denylist: ($("denylist") as HTMLTextAreaElement).value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  }),
);
$("unpair").addEventListener("click", () => send({ type: "ui.unpair" }).then(refresh));

refresh();
void refreshActiveTab();
void takeIntent();
// §5: refresh the agent list every 5 s while the panel is visible.
setInterval(() => {
  if (!document.hidden) void refreshAgents();
}, AGENTS_REFRESH_MS);
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".countdown")) el.textContent = `${Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000))}s`;
  // #158: running tasks' durations tick without a re-list.
  for (const el of document.querySelectorAll<HTMLElement>(".task-dur.live")) el.textContent = liveDurationText(Number(el.dataset.started), Date.now());
  if (state) renderYoloExpiry();
}, 1000);
setInterval(() => {
  if (state && state.status !== "connected") refresh();
}, 3000);
export {};
