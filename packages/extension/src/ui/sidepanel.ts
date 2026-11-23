// Side panel: pairing, kill switch, prompts, sessions, activity feed, settings.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;
let state: any = null;

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderStatus() {
  const st = state.settings.paused ? "paused" : state.status;
  const el = $("status");
  el.textContent = st === "connected" ? "Connected" : st === "paused" ? "Stopped" : st === "unpaired" ? "Not paired" : st === "pair-failed" ? "Pairing failed" : st === "connecting" ? "Connecting…" : "Bridge offline";
  el.className = "pill " + st;
  $("pairBox").hidden = state.paired && state.status !== "pair-failed";
  const err = $("pairErr");
  err.hidden = !state.error || state.status !== "pair-failed";
  err.textContent = state.error ?? "";
  ($("pairPort") as HTMLInputElement).placeholder = String(state.settings.port);
  $("killBtn").hidden = !!state.settings.paused;
  $("resumeBtn").hidden = !state.settings.paused;
}

function renderPrompts() {
  const ul = $("prompts");
  $("promptsBox").hidden = !state.prompts.length;
  ul.innerHTML = state.prompts
    .map((p: any) => `<li><span><b>${esc(p.label)}</b> wants to ${esc(p.kind === "site" ? `${p.level} on ${p.origin}` : p.summary)}</span>
      <span><button data-a="deny" data-id="${p.id}">Deny</button> <button data-a="once" data-id="${p.id}" class="primary">Allow</button></span></li>`)
    .join("");
}

function renderSessions() {
  const ul = $("sessions");
  if (!state.sessions.length) {
    ul.innerHTML = `<li class="muted">No agents connected.</li>`;
    return;
  }
  ul.innerHTML = state.sessions
    .map((s: any) => `<li><span><span class="dot" style="background:${esc(s.color)}"></span><b>${esc(s.label)}</b> <span class="muted">${s.tabs} tab${s.tabs === 1 ? "" : "s"} · ${esc(s.cap)}</span></span><button data-end="${esc(s.id)}">End</button></li>`)
    .join("");
}

function feedLine(e: any) {
  const t = new Date(e.ts).toLocaleTimeString();
  return `<li id="f${e.id}"><span class="muted">${t}</span> <b>${esc(e.label)}</b> ${esc(e.tool)} <span class="muted">${esc(e.summary)}</span> <span class="${e.status}">${e.status}${e.ms != null ? ` ${e.ms}ms` : ""}</span>${e.error ? `<br><span class="error">${esc(e.error)}</span>` : ""}</li>`;
}

function renderFeed() {
  $("feed").innerHTML = state.feed.slice().reverse().map(feedLine).join("") || `<li class="muted">Nothing yet.</li>`;
}

function renderSettings() {
  const s = state.settings;
  ($("defaultPolicy") as HTMLSelectElement).value = s.defaultPolicy;
  ($("showOverlay") as HTMLInputElement).checked = s.showOverlay;
  ($("forceLite") as HTMLInputElement).checked = s.forceLite;
  ($("onSessionEnd") as HTMLSelectElement).value = s.onSessionEnd;
  if (document.activeElement !== $("liteSites")) ($("liteSites") as HTMLTextAreaElement).value = s.liteSites.join("\n");
  if (document.activeElement !== $("denylist")) ($("denylist") as HTMLTextAreaElement).value = s.denylist.join("\n");
  const rows = Object.entries(s.policies as Record<string, string>);
  const sens = s.sensitiveAllowed as Record<string, boolean>;
  $("policies").innerHTML =
    rows
      .map(([o, p]) => `<tr><td>${esc(o)}${sens[o] ? ' <span class="muted small">(sensitive pre-approved)</span>' : ""}</td><td><select data-origin="${esc(o)}">${["read", "act", "full", "deny", "ask"].map((x) => `<option ${x === p ? "selected" : ""}>${x}</option>`).join("")}</select></td><td><button data-del="${esc(o)}">✕</button></td></tr>`)
      .join("") || `<tr><td class="muted">No site policies yet.</td></tr>`;
  $("about").textContent = `v${state.version} · extension id ${state.extensionId}`;
}

function render() {
  if (!state) return;
  renderStatus();
  renderPrompts();
  renderSessions();
  renderFeed();
  renderSettings();
}

async function refresh() {
  state = await send({ type: "ui.state" });
  render();
}

chrome.runtime.onMessage.addListener((m: any) => {
  if (!state) return;
  if (m.type === "feed") {
    const i = state.feed.findIndex((e: any) => e.id === m.entry.id);
    if (i >= 0) state.feed[i] = m.entry;
    else state.feed.push(m.entry);
    if (state.feed.length > 200) state.feed.shift();
    renderFeed();
  } else if (m.type === "status") {
    state.status = m.status;
    state.error = m.error;
    refresh();
  } else if (m.type === "sessions") {
    state.sessions = m.sessions;
    renderSessions();
  } else if (m.type === "prompts") {
    state.prompts = m.prompts;
    renderPrompts();
  } else if (m.type === "paused") refresh();
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
$("prompts").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.id) send({ type: "ui.answer", id: b.dataset.id, answer: b.dataset.a });
});
$("sessions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.end) send({ type: "ui.endSession", id: b.dataset.end }).then(refresh);
});
const patch = (p: unknown) => send({ type: "ui.settings", patch: p }).then(refresh);
$("defaultPolicy").addEventListener("change", (e) => patch({ defaultPolicy: (e.target as HTMLSelectElement).value }));
$("showOverlay").addEventListener("change", (e) => patch({ showOverlay: (e.target as HTMLInputElement).checked }));
$("forceLite").addEventListener("change", (e) => patch({ forceLite: (e.target as HTMLInputElement).checked }));
$("onSessionEnd").addEventListener("change", (e) => patch({ onSessionEnd: (e.target as HTMLSelectElement).value }));
$("policies").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.dataset.origin) patch({ policies: { ...state.settings.policies, [sel.dataset.origin]: sel.value } });
});
$("policies").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.del) {
    const p = { ...state.settings.policies };
    const s = { ...state.settings.sensitiveAllowed };
    delete p[b.dataset.del];
    delete s[b.dataset.del];
    patch({ policies: p, sensitiveAllowed: s });
  }
});
$("addPolicy").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = ($("newOrigin") as HTMLInputElement).value.trim();
  let origin: string;
  try {
    origin = new URL(/^https?:/.test(raw) ? raw : "https://" + raw).origin;
  } catch {
    return;
  }
  patch({ policies: { ...state.settings.policies, [origin]: ($("newLevel") as HTMLSelectElement).value } });
  ($("newOrigin") as HTMLInputElement).value = "";
});
const lines = (id: string) => ($(id) as HTMLTextAreaElement).value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
$("saveLists").addEventListener("click", () => patch({ liteSites: lines("liteSites"), denylist: lines("denylist") }));
$("unpair").addEventListener("click", () => send({ type: "ui.unpair" }).then(refresh));

refresh();
setInterval(() => {
  if (state && state.status !== "connected") refresh();
}, 3000);
export {};
