// #61 Part B: the phone page. Static HTML + one nonce'd script. Shows only a live picture of the one
// handed-off tab and sends taps, text, a few keys and scrolls. No address bar, no navigation, no eval.
import type { HandoffEntry } from "./registry";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function host(origin: string) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

const STYLE = `
*{box-sizing:border-box}html,body{margin:0;background:#111;color:#eee;font:15px/1.35 system-ui,-apple-system,sans-serif}
header{padding:10px 12px;background:#1d1d24;border-bottom:1px solid #333}
header b{color:#c4b5fd}.reason{margin-top:4px;color:#bbb;font-size:14px;overflow-wrap:anywhere}
#status{padding:4px 12px;font-size:13px;color:#fbbf24;min-height:1.4em}
#wrap{position:relative;padding:0 6px}
#shot{display:block;width:100%;height:auto;border:1px solid #333;border-radius:6px;touch-action:manipulation;cursor:crosshair;background:#222;min-height:200px}
#dot{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #a78bfa;pointer-events:none;display:none}
.bar{display:flex;gap:6px;padding:8px 6px;flex-wrap:wrap}
.bar input{flex:1 1 160px;min-width:0;padding:10px;border-radius:6px;border:1px solid #444;background:#1a1a1a;color:#eee;font-size:16px}
button{padding:10px 12px;border-radius:6px;border:1px solid #444;background:#26262e;color:#eee;font-size:15px}
.end{position:sticky;bottom:0;background:#111;border-top:1px solid #333}
.end button{flex:1;font-weight:600;padding:14px}#done{background:#15803d;border-color:#15803d}#cancel{background:#3f3f46}
.gone{padding:40px 16px;text-align:center;color:#bbb}`;

export function handoffPage(e: HandoffEntry, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>TabAgent handoff</title>
<style nonce="${nonce}">${STYLE}</style></head><body>
<header><div><b>${esc(e.sessionLabel)}</b> needs you on <b>${esc(host(e.origin))}</b></div><div class="reason">${esc(e.reason)}</div></header>
<div id="status">Connecting…</div>
<div id="wrap"><img id="shot" alt="Live view of the handed-off tab. Tap to click."><div id="dot"></div></div>
<div class="bar"><input id="text" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type into the focused field"><button id="send">Send</button></div>
<div class="bar"><button data-key="Enter">Enter</button><button data-key="Backspace">⌫</button><button data-key="Tab">Tab</button><button data-key="Escape">Esc</button><button data-scroll="-500">▲</button><button data-scroll="500">▼</button></div>
<div class="bar end"><button id="cancel">Cancel</button><button id="done">Done</button></div>
<script nonce="${nonce}">
(() => {
  const base = location.pathname, H = { "x-tabagent-handoff": "1" }, J = { ...H, "content-type": "application/json" };
  const $ = (id) => document.getElementById(id), img = $("shot"), dot = $("dot"), st = $("status");
  let ended = false, timer = null, soon = null;
  const status = (t) => (st.textContent = t || "");
  function end(msg) {
    ended = true;
    clearTimeout(timer);
    document.body.innerHTML = "";
    const d = document.createElement("div");
    d.className = "gone";
    d.textContent = msg;
    document.body.appendChild(d);
  }
  async function frame() {
    const r = await fetch(base + "/frame", { headers: H, cache: "no-store" });
    if (r.status === 404) return end("This handoff has ended. You can close this page.");
    if (!r.ok) return status("Waiting for the tab…");
    const u = URL.createObjectURL(await r.blob()), old = img.src;
    img.src = u;
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    status("");
  }
  async function loop() {
    if (ended) return;
    try { await frame(); } catch { status("Connection lost; retrying…"); }
    if (!ended) timer = setTimeout(loop, 900);
  }
  function refreshSoon() {
    clearTimeout(soon);
    soon = setTimeout(() => { clearTimeout(timer); loop(); }, 250);
  }
  async function send(input) {
    if (ended) return;
    try {
      const r = await fetch(base + "/input", { method: "POST", headers: J, body: JSON.stringify(input) });
      if (r.status === 404) return end("This handoff has ended. You can close this page.");
      if (!r.ok) status("That did not reach the tab; try again.");
    } catch { status("Connection lost; retrying…"); }
    refreshSoon();
  }
  const clamp = (v) => Math.min(1, Math.max(0, v));
  img.addEventListener("click", (ev) => {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = clamp((ev.clientX - r.left) / r.width), y = clamp((ev.clientY - r.top) / r.height);
    dot.style.left = 6 + x * r.width + "px";
    dot.style.top = y * r.height + "px";
    dot.style.display = "block";
    setTimeout(() => (dot.style.display = "none"), 400);
    send({ kind: "tap", x, y });
  });
  img.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = img.getBoundingClientRect();
    send({ kind: "scroll", x: clamp((ev.clientX - r.left) / r.width), y: clamp((ev.clientY - r.top) / r.height), dy: Math.max(-4000, Math.min(4000, ev.deltaY)) });
  }, { passive: false });
  const text = $("text");
  const sendText = () => { if (text.value) { send({ kind: "text", text: text.value.slice(0, 500) }); text.value = ""; } };
  $("send").addEventListener("click", sendText);
  text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); sendText(); } });
  for (const b of document.querySelectorAll("[data-key]")) b.addEventListener("click", () => send({ kind: "key", key: b.dataset.key }));
  for (const b of document.querySelectorAll("[data-scroll]")) b.addEventListener("click", () => send({ kind: "scroll", x: 0.5, y: 0.5, dy: Number(b.dataset.scroll) }));
  async function finish(result) {
    if (ended) return;
    try {
      const r = await fetch(base + "/end", { method: "POST", headers: J, body: JSON.stringify({ result }) });
      end(r.ok ? (result === "done" ? "Done. The agent has the tab back." : "Cancelled. The agent has been told.") : "This handoff has already ended.");
    } catch { status("Connection lost; try again."); }
  }
  $("done").addEventListener("click", () => finish("done"));
  $("cancel").addEventListener("click", () => finish("cancel"));
  (async () => {
    const t = new URLSearchParams(location.search).get("t");
    if (t) {
      let r = null;
      try { r = await fetch(base + "/claim", { method: "POST", headers: J, body: JSON.stringify({ t }) }); } catch {}
      history.replaceState(null, "", base);
      if (!r || !r.ok) return end("This link was already opened on another device, or the handoff has ended.");
    }
    loop();
  })();
})();
</script></body></html>`;
}

export function endedPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TabAgent handoff</title><style nonce="${nonce}">${STYLE}</style></head><body>
<div class="gone">This handoff link is not valid: it was already opened on another device, the handoff ended, or it expired.</div></body></html>`;
}
