// #108: the phone approval page. Static HTML + one nonce'd script. Prompt text never goes into the HTML:
// the script fetches it as JSON and renders it with textContent, so prompt text (which can quote agents
// and pages) cannot become markup. It shows exactly the strings the side panel shows.

const STYLE = `
*{box-sizing:border-box}html,body{margin:0;background:#111;color:#eee;font:15px/1.4 system-ui,-apple-system,sans-serif}
header{padding:12px;background:#1d1d24;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;gap:8px}
header b{color:#c4b5fd}#status{padding:6px 12px;font-size:13px;color:#fbbf24;min-height:1.4em}
ol{list-style:none;margin:0;padding:0 10px}li.p{border:1px solid #333;border-radius:8px;padding:12px;margin:10px 0;background:#18181d}
.title{font-weight:600;overflow-wrap:anywhere}.muted{color:#aaa;font-size:14px;overflow-wrap:anywhere;margin-top:4px}
ul.r{margin:6px 0 0;padding-left:18px;color:#bbb;font-size:14px}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
button{padding:12px 14px;border-radius:6px;border:1px solid #444;background:#26262e;color:#eee;font-size:15px;flex:1}
button.once{background:#15803d;border-color:#15803d;font-weight:600}button.deny{background:#3f3f46}
button:disabled{opacity:.5}#end{flex:0 0 auto;padding:8px 10px;font-size:13px}
.empty,.gone{padding:40px 16px;text-align:center;color:#bbb}`;

export function approvalsPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>TabAgent approvals</title>
<style nonce="${nonce}">${STYLE}</style></head><body>
<header><div><b>TabAgent</b> approvals</div><button id="end" type="button">End link</button></header>
<div id="status">Connecting…</div>
<ol id="list"></ol>
<div id="empty" class="empty" hidden>No prompts are waiting. New ones appear here while this link is live.</div>
<script nonce="${nonce}">
(() => {
  const base = location.pathname, H = { "x-tabagent-handoff": "1" }, J = { ...H, "content-type": "application/json" };
  const $ = (id) => document.getElementById(id), list = $("list"), st = $("status"), empty = $("empty");
  let ended = false, timer = null, shown = "";
  const LABEL = { once: "Allow once", deny: "Deny" };
  const OUTCOME = { applied: "Done.", already_answered: "Already answered elsewhere.", expired: "Too late: the prompt timed out.", not_found: "That prompt is gone.", not_offered: "That answer is not offered.", disabled: "Outside approvals are off in the side panel." };
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
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function render(prompts) {
    const key = JSON.stringify(prompts.map((p) => p.promptId));
    empty.hidden = prompts.length > 0;
    for (const s of list.querySelectorAll("[data-expires]")) s.textContent = Math.max(0, Math.round((Number(s.dataset.expires) - Date.now()) / 1000)) + "s left";
    if (key === shown) return;
    shown = key;
    list.textContent = "";
    for (const p of prompts) {
      const li = el("li", "p");
      li.append(el("div", "title", p.title), el("div", "muted", p.detail), el("div", "muted", p.summary));
      if (p.reasons.length) { const ul = el("ul", "r"); for (const r of p.reasons) ul.append(el("li", "", r)); li.append(ul); }
      const meta = el("div", "muted", "Tool: " + p.tool + " · ");
      const left = el("span", "", "");
      left.dataset.expires = String(p.expires);
      left.textContent = Math.max(0, Math.round((p.expires - Date.now()) / 1000)) + "s left";
      meta.append(left);
      li.append(meta);
      const actions = el("div", "actions");
      for (const a of p.answers) {
        const b = el("button", a, a === "always" ? (p.alwaysLabel || "Always allow") : LABEL[a]);
        b.type = "button";
        b.addEventListener("click", () => answer(p.promptId, a, actions));
        actions.append(b);
      }
      li.append(actions);
      list.append(li);
    }
    if (prompts.length && navigator.vibrate) navigator.vibrate(200);
  }
  async function poll() {
    if (ended) return;
    try {
      const r = await fetch(base + "/prompts", { headers: H, cache: "no-store" });
      if (r.status === 404) return end("This approval link has ended. You can close this page.");
      if (!r.ok) status("Waiting for the bridge…");
      else { render((await r.json()).prompts); status(""); }
    } catch { status("Connection lost; retrying…"); }
    if (!ended) timer = setTimeout(poll, 2000);
  }
  async function answer(promptId, a, actions) {
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    try {
      const r = await fetch(base + "/answer", { method: "POST", headers: J, body: JSON.stringify({ promptId, answer: a }) });
      if (r.status === 404 && !(r.headers.get("content-type") || "").includes("json")) return end("This approval link has ended. You can close this page.");
      const j = await r.json().catch(() => ({}));
      status(OUTCOME[j.outcome] || (j.error && j.error.message) || "That did not go through.");
    } catch { status("Connection lost; try again."); }
    shown = "";
    clearTimeout(timer);
    poll();
  }
  $("end").addEventListener("click", async () => {
    try { await fetch(base + "/end", { method: "POST", headers: J, body: "{}" }); } catch {}
    end("Link ended. Prompts are back to the side panel and tabagent approve only.");
  });
  (async () => {
    const t = new URLSearchParams(location.search).get("t");
    if (t) {
      let r = null;
      try { r = await fetch(base + "/claim", { method: "POST", headers: J, body: JSON.stringify({ t }) }); } catch {}
      history.replaceState(null, "", base);
      if (!r || !r.ok) return end("This link was already opened on another device, or it has ended.");
    }
    poll();
  })();
})();
</script></body></html>`;
}

export function approvalsEndedPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TabAgent approvals</title><style nonce="${nonce}">${STYLE}</style></head><body>
<div class="gone">This approval link is not valid: it was already opened on another device, it was ended, or it expired.</div></body></html>`;
}
