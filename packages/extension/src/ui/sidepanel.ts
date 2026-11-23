// Minimal pairing screen (#3): port field, code field, status line. #14 replaces it with the
// full side panel. A view over worker state, polled while open.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;

const LABEL: Record<string, string> = {
  connected: "Connected",
  unpaired: "Not paired",
  "pair-failed": "Pairing failed",
  "version-mismatch": "Update needed",
  connecting: "Connecting…",
};

function render(state: any) {
  const el = $("status");
  el.textContent = LABEL[state.status] ?? "Bridge offline";
  el.className = "pill " + state.status;
  const err = $("pairErr");
  err.hidden = !state.error || (state.status !== "pair-failed" && state.status !== "version-mismatch");
  err.textContent = state.error ?? "";
  ($("pairPort") as HTMLInputElement).placeholder = String(state.port);
}

async function refresh() {
  try {
    render(await send({ type: "ui.state" }));
  } catch {
    /* worker restarting */
  }
}

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = ($("pairCode") as HTMLInputElement).value.trim();
  const port = ($("pairPort") as HTMLInputElement).value.trim();
  await send({ type: "ui.pair", code, ...(port ? { port: Number(port) } : {}) });
  ($("pairCode") as HTMLInputElement).value = "";
  refresh();
});

refresh();
setInterval(refresh, 300);
