// Side panel (#14): pairing, kill switch, prompts, stopped tabs, sessions,
// activity feed (audit records only) and settings. A view over worker state.
import { feedReducer, promptReducer, promptTitle, summarizeParams, type FeedEntry, type PromptView } from "./reducers";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;
let state: any = null;

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

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
    ul.innerHTML = `<li class="muted">No agents connected.</li>`;
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
    .map((w) => `<li><span><b>${esc(w.name)}</b> <span class="muted">${esc(w.status)} · ${Number(w.steps?.length ?? 0)} steps · ${esc(w.source)}</span><br><span class="muted small">${esc((w.stopRules ?? []).join("; "))}</span>${w.dedupeKey ? `<br><span class="muted small">Duplicate key: ${esc(w.dedupeKey)}</span>` : ""}</span>${w.status === "draft" ? `<span><input data-dedupe-key="${esc(w.id)}" maxlength="200" placeholder="Optional duplicate key" aria-label="Duplicate key for ${esc(w.name)}"/><input data-url-assertion="${esc(w.id)}" maxlength="500" placeholder="Optional final URL must contain" aria-label="Expected final URL for ${esc(w.name)}"/><button class="primary" data-review-workflow="${esc(w.id)}">Review & approve</button></span>` : ""}</li>`)
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
        return `<tr><td class="origin">${esc(o)}</td><td><select data-policy data-origin="${esc(o)}">${["ask", "read", "act", "full", "deny"].map((x) => `<option ${x === pol ? "selected" : ""}>${x}</option>`).join("")}</select></td><td><input type="checkbox" data-lite data-origin="${esc(o)}" ${e.lite ? "checked" : ""}/></td><td class="pre">${pre}<label class="chip" title="Let agents sign in here with your saved accounts"><input type="checkbox" data-auth data-origin="${esc(o)}" ${e.auth ? "checked" : ""}/>sign-in</label>${(e.authAlways ?? []).length ? `<span class="muted small"> (${(e.authAlways ?? []).length} account${(e.authAlways ?? []).length === 1 ? "" : "s"} always)</span>` : ""}</td><td><button data-del="${esc(o)}" title="Revoke everything for this site">✕</button></td></tr>`;
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
  renderFeed();
  renderWorkflows();
  renderSettings();
}

async function refresh() {
  state = await send({ type: "ui.state" });
  render();
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
$("workflows").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
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
      delete entry.auth;
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
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".countdown")) el.textContent = `${Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000))}s`;
}, 1000);
setInterval(() => {
  if (state && state.status !== "connected") refresh();
}, 3000);
export {};
