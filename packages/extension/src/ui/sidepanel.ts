// Side panel (#14): pairing, kill switch, prompts, stopped tabs, sessions, agents (#90),
// activity feed (audit records only) and settings. A view over worker state.
import type { Agent, AgentSources } from "@tabagent/protocol";
import { AUTH_DEFAULT_ON_ORIGINS, authEnabled } from "../background/policy";
import { AGENTS_REFRESH_MS, agentFeedLineHtml, agentFeedReducer, agentRowHtml, agentRowView, buildAgentSend, composerState, shareableTab, sourcesNotes, type AgentFeedAction, type AgentFeedEntry, type SharedTab } from "../pure/agents";
import { esc } from "../pure/html";
import { feedReducer, promptReducer, promptTitle, summarizeParams, type FeedEntry, type PromptView } from "./reducers";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;
let state: any = null;

const CATS = ["a", "b", "c", "d", "e"] as const;
const CAT_LABEL: Record<string, string> = { a: "forms", b: "clicks", c: "JS", d: "creds", e: "files" };

function renderStatus() {
  const st = state.settings.paused ? "paused" : state.status;
  const el = $("status");
  el.textContent =
    st === "connected" ? "Connected" : st === "paused" ? "Stopped" : st === "unpaired" ? "Not paired" : st === "pair-failed" ? "Pairing failed" : st === "version-mismatch" ? "Update needed" : st === "connecting" ? "Connecting…" : "Bridge offline";
  el.className = "pill " + st;
  $("pairBox").hidden = state.paired && state.status !== "pair-failed";
  const err = $("pairErr");
  err.hidden = !state.error || (state.status !== "pair-failed" && state.status !== "version-mismatch");
  err.textContent = state.error ?? "";
  ($("pairPort") as HTMLInputElement).placeholder = String(state.settings.port);
  $("killBtn").hidden = !!state.settings.paused;
  $("resumeBtn").hidden = !state.settings.paused;
  $("killNote").textContent = state.settings.paused ? "All agents are stopped. Every command returns KILLED until you resume." : "Shortcut: Alt+Shift+K";
}

function promptHtml(p: any) {
  const title = promptTitle(p);
  const detail =
    p.kind === "site"
      ? p.level === "read"
        ? "It will be able to see page content."
        : p.level === "act"
          ? "It will be able to click, type and navigate on this site."
          : "It will be able to run scripts and read cookies and storage on this site."
      : p.sensitive
        ? `${p.sensitive.description} · on ${p.origin}`
        : `on ${p.origin}`;
  const isAuth = p.sensitive?.category === "g";
  const oneShot = p.kind === "attach" || p.sensitive?.category === "p" || p.sensitive?.category === "r";
  const always = oneShot ? "" : `<button data-a="always" data-id="${esc(p.promptId)}">${p.kind === "site" ? `Always allow ${esc(p.level)}` : isAuth ? "Always for this account" : "Always allow on this site"}</button>`;
  const left = Math.max(0, Math.round((p.expires - Date.now()) / 1000));
  return `<li class="prompt-item" data-prompt-id="${esc(p.promptId)}">
    <div class="ptitle">${esc(title)}</div>
    <div class="muted small pdetail">${esc(detail)}</div>
    <div class="muted small psummary">${esc(p.summary)}</div>
    <ul class="preasons reasons">${(p.reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join("")}</ul>
    <div class="muted small">Tool: ${esc(p.tool)} · <span class="countdown" data-expires="${Number(p.expires)}">${left}s</span></div>
    <div class="actions"><button data-a="deny" data-id="${esc(p.promptId)}">Deny</button>${always}<button data-a="once" data-id="${esc(p.promptId)}" class="primary">Allow once</button></div>
  </li>`;
}

function renderPrompts() {
  $("promptsBox").hidden = !state.prompts.length;
  $("prompts").innerHTML = state.prompts.map(promptHtml).join("");
}

function renderStopped() {
  const tabs: number[] = state.stoppedTabs ?? [];
  $("stoppedBox").hidden = !tabs.length;
  $("stopped").innerHTML = tabs.map((t) => `<li><span>Tab ${t}</span><button data-resume-tab="${t}">Resume</button></li>`).join("");
}

function renderHandoffs() {
  const list: any[] = state.handoffs ?? [];
  $("handoffBox").hidden = !list.length;
  $("handoffs").innerHTML = list
    .map((h) => `<li data-handoff-tab="${Number(h.tabId)}"><span><b>${esc(h.sessionLabel)}</b> · ${esc(h.origin)}<br><span class="muted small">${esc(h.reason)}</span></span><span><button data-handoff="cancel" data-tab="${Number(h.tabId)}">Cancel</button> <button data-handoff="done" data-tab="${Number(h.tabId)}" class="primary">Done</button></span></li>`)
    .join("");
  window.dispatchEvent(new CustomEvent("tabagent:handoffs", { detail: list }));
}

function renderSessions() {
  const ul = $("sessions");
  if (!state.sessions.length) {
    ul.innerHTML = `<li class="muted">No sessions.</li>`;
    return;
  }
  ul.innerHTML = state.sessions
    .map((s: any) => `<li><span><span class="dot g-${esc(s.color)}"></span><b>${esc(s.label)}</b> <span class="muted">${s.tabs} tab${s.tabs === 1 ? "" : "s"} · ${esc(s.cap)}</span></span><button data-end="${esc(s.id)}">End</button></li>`)
    .join("");
}

function feedLine(e: FeedEntry) {
  const t = new Date(e.ts).toLocaleTimeString();
  const tool = e.action ? `${e.tool} ${e.action}` : e.tool;
  return `<li data-feed-id="${e.id}"><span class="muted">${t}</span> <b>${esc(e.label)}</b> ${esc(tool)} <span class="muted">${esc(e.origin ?? "")} ${esc(summarizeParams(e.params))}</span> <span class="${esc(e.status)}">${esc(e.status)}${e.errorCode ? ` ${esc(e.errorCode)}` : ""}${e.ms != null ? ` ${e.ms}ms` : ""}</span></li>`;
}

function renderFeed() {
  $("feed").innerHTML = state.feed.slice().reverse().map(feedLine).join("") || `<li class="muted">Nothing yet.</li>`;
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
/** The active tab as it would be shared; re-read at Send time. */
let activeTab: SharedTab | null = null;

const agentsVisible = () => !!state?.agentsSupported;
const agentPrompt = () => $("agentPrompt") as HTMLTextAreaElement;
const shareTab = () => ($("agentShareTab") as HTMLInputElement).checked;

function selectedAgentView() {
  const a = agents.find((x) => x.id === selectedAgentId);
  return a ? agentRowView(a, Date.now()) : null;
}

/** Set innerHTML only when it changed, so the 5 s refresh does not swallow a click mid-press. */
function setHtml(el: HTMLElement, html: string) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderAgentList() {
  const now = Date.now();
  const html = !agentsLoaded
    ? `<li class="muted">Looking for agents…</li>`
    : agentsError
      ? `<li class="err">${esc(agentsError)}</li>`
      : agents.map((a) => agentRowHtml(agentRowView(a, now), a.id === selectedAgentId)).join("") || `<li class="muted">No agents running.</li>`;
  setHtml($("agents"), html);
  const notes = sourcesNotes(agentSources);
  $("agentSources").hidden = !notes.length;
  $("agentSources").textContent = notes.join(" · ");
}

function renderComposer() {
  const v = selectedAgentView();
  const c = composerState({ agent: v, prompt: agentPrompt().value, share: shareTab() ? activeTab : null });
  const btn = $("agentSend") as HTMLButtonElement;
  btn.textContent = c.label;
  btn.disabled = !c.canSend || agentSending;
  $("agentComposerNote").textContent = c.note;
  const target = $("agentTarget");
  target.hidden = !v && !agentNotice;
  target.innerHTML = v ? `To <b>${esc(v.title)}</b> <span class="muted">(${esc(v.vendorLabel)}, ${esc(v.routeWords)})</span>` : `<span class="err">${esc(agentNotice)}</span>`;
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
    return shareableTab(t);
  } catch {
    return null;
  }
}

async function refreshActiveTab() {
  activeTab = await readActiveTab();
  if (agentsVisible()) renderComposer();
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
}

function selectAgent(el: EventTarget | null) {
  const li = (el as HTMLElement | null)?.closest<HTMLElement>("li[data-agent-id]");
  if (!li?.dataset.agentId) return;
  selectedAgentId = li.dataset.agentId;
  agentNotice = "";
  renderAgentsBox();
  agentPrompt().focus();
}

async function sendToSelectedAgent() {
  const v = selectedAgentView();
  if (!v || agentSending) return;
  const prompt = agentPrompt().value;
  // AD12: title and url are read at Send time, not from the label shown earlier.
  const share = shareTab() ? await readActiveTab() : null;
  if (shareTab()) activeTab = share;
  if (!composerState({ agent: v, prompt, share }).canSend) return renderComposer();
  const requestId = crypto.randomUUID();
  agentFeed({ type: "sending", requestId, ts: Date.now(), agentName: v.title, vendor: v.vendor, route: v.route });
  agentSending = true;
  renderComposer();
  let r: any;
  try {
    r = await send(buildAgentSend({ requestId, agentId: v.id, prompt, share }));
  } catch (e) {
    r = { error: String((e as Error)?.message ?? e) };
  }
  agentSending = false;
  if (r?.type === "agent.sent") agentFeed({ type: "sent", msg: r });
  else agentFeed({ type: "sent", msg: { requestId, route: v.route, state: "failed", detail: r?.error ?? "TabAgent did not answer" } });
  // Keep the text after a failure so it can be retried.
  if (r?.type === "agent.sent" && r.state !== "failed") agentPrompt().value = "";
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
        const target = step.locator?.name || step.locator?.label || step.locator?.text || step.locator?.role || "target";
        const detail = step.kind === "navigate" ? step.url : step.kind === "press" ? (step.locator ? `${step.key} in ${target}` : step.key) : step.kind === "check" ? `${target} → ${step.checked === false ? "off" : "on"}` : step.kind === "wait" ? `${step.waitFor ?? "?"}${step.waitValue ? ` ${step.waitValue}` : ""}` : step.kind === "scroll" ? `${step.locator ? `${target} ` : ""}by ${step.dx ?? 0},${step.dy ?? 0}` : step.kind === "download" ? (step.download?.mime ?? step.download?.extension ?? "artifact") : target;
        const parameter = w.status === "draft" && step.kind === "input" && step.value?.kind === "fixed" ? ` <button data-parameterize-workflow-step="${esc(w.id)}" data-step-index="${index}" aria-label="Make step ${index + 1} a parameter">Make parameter</button>` : "";
        const placeholder = step.value?.kind === "parameter" ? ` (${step.value.placeholder})` : "";
        return `<li class="small">${esc(step.kind)}: ${esc(detail)}${esc(placeholder)}${w.status === "draft" ? ` <button data-delete-workflow-step="${esc(w.id)}" data-step-index="${index}" aria-label="Remove step ${index + 1}">Remove</button>${parameter}` : ""}</li>`;
      }).join("");
      return `<li><span><b>${esc(w.name)}</b> <span class="muted">${esc(w.status)} · ${Number(w.steps?.length ?? 0)} steps · ${esc(w.source)}</span><br><span class="muted small">${esc((w.stopRules ?? []).join("; "))}</span>${w.dedupeKey ? `<br><span class="muted small">Duplicate key: ${esc(w.dedupeKey)}</span>` : ""}<ol class="workflow-steps">${steps}</ol></span>${w.status === "draft" ? `<span><input data-dedupe-key="${esc(w.id)}" maxlength="200" placeholder="Optional duplicate key" aria-label="Duplicate key for ${esc(w.name)}"/><input data-url-assertion="${esc(w.id)}" maxlength="500" placeholder="Optional final URL must contain" aria-label="Expected final URL for ${esc(w.name)}"/><button class="primary" data-review-workflow="${esc(w.id)}">Review & approve</button></span>` : ""}</li>`;
    })
    .join("") || `<li class="muted">No captured recipes yet.</li>`;
}

function renderSettings() {
  const s = state.settings;
  ($("onSessionEnd") as HTMLSelectElement).value = s.onSessionEnd;
  ($("beforeUnload") as HTMLSelectElement).value = s.beforeUnload;
  ($("showOverlay") as HTMLInputElement).checked = s.showOverlay;
  ($("forceLite") as HTMLInputElement).checked = s.forceLite;
  ($("devAllowSensitive") as HTMLInputElement).checked = s.devAllowSensitive;
  ($("yolo") as HTMLInputElement).checked = !!s.yolo;
  $("yoloBanner").hidden = !s.yolo;
  if (document.activeElement !== $("denylist")) ($("denylist") as HTMLTextAreaElement).value = s.denylist.join("\n");
  const rows = Object.entries(s.sites as Record<string, any>);
  $("sites").innerHTML =
    rows
      .map(([o, e]) => {
        const pol = e.policy ?? "ask";
        const pre = CATS.map((c) => `<label class="chip"><input type="checkbox" data-pre="${c}" data-origin="${esc(o)}" ${e.preapproved?.[c] ? "checked" : ""}/>${CAT_LABEL[c]}</label>`).join("");
        return `<tr><td class="origin">${esc(o)}</td><td><select data-policy data-origin="${esc(o)}">${["ask", "read", "act", "full", "deny"].map((x) => `<option ${x === pol ? "selected" : ""}>${x}</option>`).join("")}</select></td><td><input type="checkbox" data-lite data-origin="${esc(o)}" ${e.lite ? "checked" : ""}/></td><td class="pre">${pre}<label class="chip" title="Let agents sign in here with your saved accounts"><input type="checkbox" data-auth data-origin="${esc(o)}" ${authEnabled(e, o, !!state.settings?.yolo) ? "checked" : ""}/>sign-in</label>${(e.authAlways ?? []).length ? `<span class="muted small"> (${(e.authAlways ?? []).length} account${(e.authAlways ?? []).length === 1 ? "" : "s"} always)</span>` : ""}</td><td><button data-del="${esc(o)}" title="Revoke everything for this site">✕</button></td></tr>`;
      })
      .join("") || `<tr><td colspan="5" class="muted">No site settings yet.</td></tr>`;
  $("about").textContent = `v${state.version} · extension id ${state.extensionId}`;
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
  renderSettings();
}

async function refresh() {
  state = await send({ type: "ui.state" });
  render();
  void refreshAgents();
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
    case "status":
    case "paused":
      refresh();
      break;
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
$("sessions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.end) send({ type: "ui.endSession", id: b.dataset.end }).then(refresh);
});
$("agents").addEventListener("click", (e) => selectAgent(e.target));
$("agents").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  selectAgent(e.target);
});
agentPrompt().addEventListener("input", renderComposer);
agentPrompt().addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void sendToSelectedAgent();
  }
});
$("agentShareTab").addEventListener("change", renderComposer);
$("agentSend").addEventListener("click", () => void sendToSelectedAgent());
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.title || info.url)) void refreshActiveTab();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
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
for (const id of ["showOverlay", "forceLite", "devAllowSensitive", "yolo"]) $(id).addEventListener("change", (e) => patch({ [id]: (e.target as HTMLInputElement).checked }));

$("sites").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const o = el.dataset.origin;
  if (!o) return;
  const all = sites();
  const entry = (all[o] ??= {});
  if ("policy" in el.dataset) {
    if (el.value === "ask") delete entry.policy;
    else entry.policy = el.value;
  } else if ("lite" in el.dataset) {
    if ((el as HTMLInputElement).checked) entry.lite = true;
    else delete entry.lite;
  } else if ("auth" in el.dataset) {
    if ((el as HTMLInputElement).checked) entry.auth = true;
    else {
      // A default-on origin (Google) needs an explicit false to stay off.
      if (state.settings?.yolo || AUTH_DEFAULT_ON_ORIGINS.includes(el.dataset.origin ?? "")) entry.auth = false;
      else delete entry.auth;
      delete entry.authAlways;
    }
  } else if (el.dataset.pre) {
    entry.preapproved = { ...(entry.preapproved ?? {}) };
    if ((el as HTMLInputElement).checked) entry.preapproved[el.dataset.pre] = true;
    else delete entry.preapproved[el.dataset.pre];
  }
  patch({ sites: all });
});
$("sites").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.del) return;
  const all = sites();
  delete all[b.dataset.del];
  patch({ sites: all });
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
  all[origin] = { ...(all[origin] ?? {}), policy: ($("newLevel") as HTMLSelectElement).value };
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
// §5: refresh the agent list every 5 s while the panel is visible.
setInterval(() => {
  if (!document.hidden) void refreshAgents();
}, AGENTS_REFRESH_MS);
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".countdown")) el.textContent = `${Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000))}s`;
}, 1000);
setInterval(() => {
  if (state && state.status !== "connected") refresh();
}, 3000);
export {};
