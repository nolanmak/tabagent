// Chat page (#151, spec §7a): one agent's conversation, live, with a composer pinned to the bottom.
// History comes from ui.agent_history, live entries through the "agent-chat" port, the agent's state from
// ui.agents_list every 5 s. All decisions and HTML live in ../pure/chat and ../pure/agents.
import { agentSendOverLimit, type Agent, type AgentEntries, type AgentHistoryResult } from "@tabagent/protocol";
import { AGENTS_REFRESH_MS, agentRowView, buildAgentSend, shareableTab } from "../pure/agents";
import {
  findSpawnedAgent,
  spawnFailureText,
  isHomeFolder,
  atBottom,
  chatHeaderView,
  chatItemHtml,
  chatItems,
  chatRailHtml,
  chatReducer,
  composerMode,
  historyErrorText,
  initialChat,
  notConnectedCardHtml,
  pendingHtml,
  recentWebTabs,
  type ChatAction,
  type ChatItem,
  type ComposerMode,
} from "../pure/chat";
import { esc } from "../pure/html";

const $ = (id: string) => document.getElementById(id)!;
const send = (m: unknown): Promise<any> => chrome.runtime.sendMessage(m);

const agentId = new URLSearchParams(location.search).get("agent") ?? "";
let state = initialChat();
let agent: Agent | null = null;
/** Every running session, for the left rail (#156). */
let allAgents: Agent[] = [];
/** The bridge listed the sessions at least once (an empty rail means none, not unknown). */
let agentsListed = false;
let lastRailHtml = "";
let agentsLoaded = false;
let bridgeNote = "";
let spawnChosen = false;
/** A Start that succeeded: follow the new session into this window once the bridge lists it. */
let pendingSpawn: { cwd: string; since: number; beforeIds: string[]; until: number } | null = null;
let mode: ComposerMode = "loading";
let sending = false;
const openKeys = new Set<string>();
const rendered = new Map<string, { el: Element; html: string; item: ChatItem }>();

const scroller = () => $("scroller");
const input = () => $("input") as HTMLTextAreaElement;

function dispatch(a: ChatAction) {
  state = chatReducer(state, a);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fromHtml(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content.firstElementChild!;
}

/** Keyed update: unchanged bubbles stay in the DOM, so text selection and open chips survive live updates. */
function renderLog() {
  const log = $("log");
  const keep = new Set<string>();
  let prev: Element | null = null;
  for (const item of chatItems(state.entries)) {
    keep.add(item.key);
    const html = chatItemHtml(item, openKeys.has(item.key));
    let r = rendered.get(item.key);
    if (!r || r.html !== html) {
      const el = fromHtml(html);
      if (r) r.el.replaceWith(el);
      r = { el, html, item };
      rendered.set(item.key, r);
    }
    const want: Element | null = prev ? prev.nextElementSibling : log.firstElementChild;
    if (want !== r.el) {
      if (prev) prev.after(r.el);
      else log.prepend(r.el);
    }
    prev = r.el;
  }
  for (const [k, r] of rendered)
    if (!keep.has(k)) {
      r.el.remove();
      rendered.delete(k);
    }
}

function renderPending() {
  $("pending").innerHTML = state.pending.map(pendingHtml).join("");
}

function renderNotice() {
  const n = $("notice");
  let html = "";
  if (!agentId) html = `<p>No session selected. Open a session from the TabAgent side panel.</p>`;
  else if (state.loading) html = `<p class="muted"><span class="spinner" aria-hidden="true"></span> Loading conversation…</p>`;
  else if (state.error) {
    const retry = state.error.code !== "UNSUPPORTED" && state.error.code !== "AGENT_GONE" ? ` <button type="button" class="secondary" data-retry>Retry</button>` : "";
    html = `<p class="${state.error.code === "UNSUPPORTED" || state.error.code === "NO_TRANSCRIPT" ? "muted" : "err"}">${esc(historyErrorText(state.error))}${retry}</p>`;
  } else if (!state.entries.length && !state.pending.length) html = `<p class="muted">No messages yet.${mode === "send" ? " Say something below." : ""}</p>`;
  if (bridgeNote) html = `<p class="err">${esc(bridgeNote)}</p>` + html;
  n.hidden = !html;
  if (n.innerHTML !== html) n.innerHTML = html;
  const older = $("loadOlder") as HTMLButtonElement;
  older.hidden = !state.hasMore || state.loading;
  older.disabled = state.loadingOlder;
  older.textContent = state.loadingOlder ? "Loading…" : "Load earlier messages";
}

function renderHeader() {
  if (!agent) {
    $("title").textContent = agentsLoaded ? (agentId ? "Session not running" : "No session") : "Loading…";
    for (const id of ["status", "conn", "rcBtn", "vendor"]) $(id).hidden = true;
    $("typing").hidden = true;
    return;
  }
  const h = chatHeaderView(agent, Date.now());
  $("title").textContent = h.title;
  document.title = `${h.title} · TabAgent`;
  $("folder").textContent = h.folder;
  $("folder").title = h.folder;
  const vendor = $("vendor");
  vendor.hidden = false;
  vendor.textContent = h.vendorLabel;
  vendor.className = `vendor vendor-${agent.vendor}`;
  const status = $("status");
  status.hidden = false;
  status.textContent = h.statusText;
  status.className = `status-pill${h.busy ? " busy" : ""}`;
  const conn = $("conn");
  conn.hidden = false;
  conn.textContent = h.connection.label;
  conn.className = `conn conn-${h.connection.tone}`;
  const rc = $("rcBtn") as HTMLAnchorElement;
  rc.hidden = !h.remoteControlUrl;
  if (h.remoteControlUrl) rc.href = h.remoteControlUrl;
  $("typing").hidden = !h.busy;
}

const ROUTE_HINT: Record<string, string> = {
  channel: "Delivered instantly",
  piggyback: "Delivered on its next browser action",
  queue: "Queued on the Codex thread",
};

function renderComposer() {
  mode = composerMode(agent, { loaded: agentsLoaded, spawnChosen });
  const form = $("composer");
  const opts = $("composerOpts");
  const card = $("card");
  const note = $("composerNote");
  const showForm = mode === "send" || mode === "spawn";
  form.hidden = !showForm;
  opts.hidden = !showForm;
  $("composerHints").hidden = !showForm;
  $("spawnCancel").hidden = mode !== "spawn";
  const v = agent ? agentRowView(agent, Date.now()) : null;
  if (mode === "spawn" && v) {
    input().placeholder = `First message for a new session in ${v.cwdBase}…`;
    ($("sendBtn") as HTMLButtonElement).textContent = "Start session";
    $("routeHint").textContent = `Starts a new background session in ${v.cwdBase}`;
  } else if (v) {
    input().placeholder = `Message ${v.title}…`;
    ($("sendBtn") as HTMLButtonElement).textContent = "Send";
    $("routeHint").textContent = ROUTE_HINT[v.route] ?? "";
  }
  let cardHtml = "";
  if (mode === "card" && agent) cardHtml = notConnectedCardHtml(agent);
  else if (mode === "gone" && agentId) cardHtml = `<div class="nc-card"><p class="nc-title">This session is no longer running.</p><p class="muted">Its conversation stays readable above. Open the side panel to pick another session.</p></div>`;
  else if (mode === "none" && v) cardHtml = `<div class="nc-card"><p class="nc-title">${esc(v.reason ?? "This agent can't take messages.")}</p></div>`;
  card.hidden = !cardHtml;
  if (card.innerHTML !== cardHtml) card.innerHTML = cardHtml;
  const over = showForm ? agentSendOverLimit({ prompt: input().value }) : null;
  note.hidden = !over;
  note.textContent = over ? `The message is ${over.length.toLocaleString("en-US")} characters; the limit is ${over.limit.toLocaleString("en-US")}.` : "";
  const homeSpawn = mode === "spawn" && !!agent && isHomeFolder(agent.cwd);
  ($("sendBtn") as HTMLButtonElement).disabled = !showForm || sending || !input().value.trim() || !!over || homeSpawn;
}

/** #156: the rail of sessions; rewritten only when it changed, so a hover or focus survives the 5 s refresh. */
function renderRail() {
  const html = agentsListed ? chatRailHtml(allAgents.map((a) => agentRowView(a, Date.now())), agentId) : agentsLoaded ? `<li class="rail-empty">Sessions unavailable.</li>` : "";
  if (html && html !== lastRailHtml) {
    $("railList").innerHTML = html;
    lastRailHtml = html;
  }
}

/** Re-render everything; keep the view pinned to the bottom when it was there, else offer the pill. */
function render(o: { stick?: boolean; newContent?: boolean } = {}) {
  const sc = scroller();
  const wasBottom = atBottom(sc);
  renderHeader();
  renderRail();
  renderComposer();
  renderLog();
  renderPending();
  renderNotice();
  if (o.stick || wasBottom) {
    sc.scrollTop = sc.scrollHeight;
    $("newPill").hidden = true;
  } else if (o.newContent) $("newPill").hidden = false;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadHistory() {
  if (!agentId) return render();
  dispatch({ type: "loading" });
  render({ newContent: false });
  let r: AgentHistoryResult | { error?: string };
  try {
    r = await send({ type: "ui.agent_history", agentId });
  } catch (e) {
    r = { error: String((e as Error)?.message ?? e) };
  }
  if ("ok" in r && r.ok) dispatch({ type: "history", entries: r.entries, hasMore: r.hasMore, before: r.before });
  else dispatch({ type: "historyError", code: "code" in r ? r.code : undefined, detail: ("detail" in r && r.detail) || ("error" in r && r.error) || "TabAgent did not answer" });
  render({ stick: true });
}

async function loadOlder() {
  if (!state.hasMore || state.loadingOlder) return;
  dispatch({ type: "loadingOlder" });
  renderNotice();
  const sc = scroller();
  const fromBottom = sc.scrollHeight - sc.scrollTop;
  let r: any;
  try {
    r = await send({ type: "ui.agent_history", agentId, before: state.before });
  } catch {
    r = null;
  }
  if (r?.ok) dispatch({ type: "history", entries: r.entries, hasMore: r.hasMore, before: r.before, older: true });
  else dispatch({ type: "historyError", detail: r?.detail ?? "TabAgent did not answer", older: true });
  render({ newContent: false });
  // Keep the message the user was reading where it was.
  sc.scrollTop = sc.scrollHeight - fromBottom;
}

async function refreshAgent() {
  // Without an agent id the page still lists the running sessions in the rail (#156).
  if (document.hidden) return;
  try {
    const r = await send({ type: "ui.agents_list" });
    if (r?.supported === false) bridgeNote = "The TabAgent bridge does not support agents. Update @nolmak/tabagent.";
    else if (r?.error) throw new Error(r.error);
    else {
      bridgeNote = "";
      allAgents = (r?.agents as Agent[] | undefined) ?? [];
      agentsListed = true;
      agent = allAgents.find((a) => a.id === agentId) ?? null;
      if (pendingSpawn) {
        const hit = findSpawnedAgent(pendingSpawn.beforeIds, allAgents, pendingSpawn);
        if (hit) {
          pendingSpawn = null;
          location.replace(`${location.pathname}?agent=${encodeURIComponent(hit.id)}`);
          return;
        }
        if (Date.now() > pendingSpawn.until) pendingSpawn = null;
      }
    }
  } catch (e) {
    bridgeNote = `TabAgent can't reach the bridge: ${String((e as Error)?.message ?? e)}`;
  }
  agentsLoaded = true;
  render({ newContent: false });
}

// Live entries: a port the worker pushes this agent's appended transcript entries into.
let port: chrome.runtime.Port | null = null;
function connectPort() {
  if (!agentId) return;
  port = chrome.runtime.connect({ name: "agent-chat" });
  port.onMessage.addListener((m: AgentEntries) => {
    if (m?.type !== "agent.entries" || m.agentId !== agentId) return;
    if (m.reset) return void loadHistory();
    if (!m.entries.length) return;
    dispatch({ type: "entries", entries: m.entries });
    render({ newContent: true });
  });
  port.onDisconnect.addListener(() => {
    // The service worker restarted: watch again, and reload in case entries were missed meanwhile.
    port = null;
    setTimeout(() => {
      connectPort();
      void loadHistory();
    }, 1000);
  });
  port.postMessage({ type: "watch", agentId });
}

chrome.runtime.onMessage.addListener((m: any) => {
  if (m?.type === "agent.status") {
    dispatch({ type: "status", msg: m });
    renderPending();
  }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sharedTab() {
  const id = Number(($("shareTab") as HTMLSelectElement).value);
  if (!id) return null;
  const tab = await chrome.tabs.get(id).catch(() => undefined);
  return shareableTab(tab);
}

async function refreshShareTabs() {
  const sel = $("shareTab") as HTMLSelectElement;
  const cur = sel.value;
  let tabs: chrome.tabs.Tab[] = [];
  try {
    const win = await chrome.windows.getCurrent();
    tabs = recentWebTabs(await chrome.tabs.query({ windowId: win.id }));
  } catch {
    /* no tabs API */
  }
  sel.innerHTML = `<option value="">No tab</option>` + tabs.map((t) => `<option value="${t.id}">${esc((t.title || t.url || "").slice(0, 80))}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

async function submit() {
  if (!agent || sending || (mode !== "send" && mode !== "spawn")) return;
  const prompt = input().value;
  if (!prompt.trim() || agentSendOverLimit({ prompt })) return;
  const forceSpawn = mode === "spawn";
  const clickedAt = Date.now();
  const share = await sharedTab();
  const requestId = crypto.randomUUID();
  dispatch({ type: "sending", requestId, text: prompt, ts: Date.now(), ...(forceSpawn ? { spawn: true } : {}) });
  input().value = "";
  autosize();
  sending = true;
  render({ stick: true });
  let r: any;
  try {
    r = await send(buildAgentSend({ requestId, agentId: agent.id, prompt, share, forceSpawn }));
  } catch (e) {
    r = { error: String((e as Error)?.message ?? e) };
  }
  sending = false;
  if (r?.type === "agent.sent" && forceSpawn && r.state === "failed") r = { ...r, detail: spawnFailureText(r, agent?.cwd ?? "") };
  if (r?.type === "agent.sent") dispatch({ type: "sent", msg: r });
  else dispatch({ type: "sent", msg: { requestId, route: forceSpawn ? "spawn" : (agent?.delivery ?? "none"), state: "failed", detail: r?.error ?? "TabAgent did not answer" } });
  if (forceSpawn && r?.state === "started") {
    spawnChosen = false;
    // The new session is a different agent: switch this window to it as soon as it shows up.
    if (agent) pendingSpawn = { cwd: agent.cwd, since: clickedAt - 2_000, beforeIds: allAgents.map((a) => a.id), until: Date.now() + 90_000 };
    setTimeout(() => void refreshAgent(), 1_500);
  }
  render({ stick: true });
  input().focus();
}

function autosize() {
  const el = input();
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit();
});
input().addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter is a newline; never while an IME is composing.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
});
input().addEventListener("input", () => {
  autosize();
  renderComposer();
});
$("shareTab").addEventListener("focus", () => void refreshShareTabs());
$("spawnCancel").addEventListener("click", () => {
  spawnChosen = false;
  render({ newContent: false });
});
$("card").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-spawn-start]");
  if (!b) return;
  spawnChosen = true;
  render({ newContent: false });
  input().focus();
});
$("notice").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-retry]")) void loadHistory();
});
$("pending").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const edit = t.closest<HTMLElement>("[data-edit]")?.dataset.edit;
  const dismiss = t.closest<HTMLElement>("[data-dismiss]")?.dataset.dismiss;
  if (edit) {
    const p = state.pending.find((x) => x.requestId === edit);
    if (p) input().value = p.text;
    dispatch({ type: "dismiss", requestId: edit });
    autosize();
    render({ newContent: false });
    input().focus();
  } else if (dismiss) {
    dispatch({ type: "dismiss", requestId: dismiss });
    render({ newContent: false });
  }
});
$("loadOlder").addEventListener("click", () => void loadOlder());
$("log").addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const key = d.dataset?.key;
    if (!key) return;
    if (d.open) openKeys.add(key);
    else openKeys.delete(key);
    const r = rendered.get(key);
    if (r) r.html = chatItemHtml(r.item, d.open);
  },
  true,
);
scroller().addEventListener("scroll", () => {
  if (atBottom(scroller())) $("newPill").hidden = true;
});
$("newPill").addEventListener("click", () => {
  scroller().scrollTo({ top: scroller().scrollHeight, behavior: "smooth" });
  $("newPill").hidden = true;
});
// #156: the current session's rail row keeps you here (no reload, the draft stays); the others navigate.
$("railList").addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("a[aria-current='page']")) return;
  e.preventDefault();
  if (!$("composer").hidden) input().focus();
});
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $("focusKey").textContent = "Ctrl+K";
// #156: Cmd/Ctrl+K or / focuses the composer; Esc leaves it.
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  if (e.key === "Escape" && t === input()) {
    input().blur();
    return;
  }
  const want = ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey);
  if (!want || $("composer").hidden) return;
  e.preventDefault();
  input().focus();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshAgent();
});

render({ newContent: false });
connectPort();
void refreshAgent();
void loadHistory();
void refreshShareTabs();
setInterval(() => void refreshAgent(), AGENTS_REFRESH_MS);
export {};
