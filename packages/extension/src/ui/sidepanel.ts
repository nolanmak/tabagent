// Minimal pairing screen (#3): port, pairing code, connection status.
// The full side panel (feed, prompts, kill switch, settings) is #14.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<any>;
let state: any = null;

function renderStatus() {
  const st = state.status;
  const el = $("status");
  el.textContent =
    st === "connected" ? "Connected" : st === "unpaired" ? "Not paired" : st === "pair-failed" ? "Pairing failed" : st === "version-mismatch" ? "Update needed" : st === "connecting" ? "Connecting…" : "Bridge offline";
  el.className = "pill " + st;
  $("pairBox").hidden = state.paired && state.status !== "pair-failed";
  const err = $("pairErr");
  err.hidden = !state.error || (state.status !== "pair-failed" && state.status !== "version-mismatch");
  err.textContent = state.error ?? "";
  ($("pairPort") as HTMLInputElement).placeholder = String(state.port);
  $("about").textContent = `v${state.version} · extension id ${state.extensionId}`;
}

async function refresh() {
  state = await send({ type: "ui.state" });
  if (state) renderStatus();
}

chrome.runtime.onMessage.addListener((m: any) => {
  if (state && m.type === "status") refresh();
});

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = ($("pairCode") as HTMLInputElement).value;
  const port = ($("pairPort") as HTMLInputElement).value;
  await send({ type: "ui.pair", code, port: port || undefined });
  setTimeout(refresh, 400);
});
$("unpair").addEventListener("click", () => send({ type: "ui.unpair" }).then(refresh));

refresh();
setInterval(() => {
  if (state && state.status !== "connected") refresh();
}, 3000);
export {};
