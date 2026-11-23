// Permission prompt window (opened from the notification click when the side panel can't open).
import { promptTitle } from "./reducers";

const id = new URLSearchParams(location.search).get("id")!;
const $ = (i: string) => document.getElementById(i)!;
const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;

async function load() {
  const p = await send({ type: "ui.prompt.get", id });
  if (!p) {
    $("title").textContent = "This request has expired or was already answered.";
    document.querySelector(".actions")?.remove();
    setTimeout(() => window.close(), 1500);
    return;
  }
  $("title").textContent = promptTitle(p);
  if (p.kind === "site") {
    $("detail").textContent = p.level === "read" ? "It will be able to see page content." : p.level === "act" ? "It will be able to click, type and navigate on this site." : "It will be able to run scripts and read cookies and storage on this site.";
    ($("always") as HTMLButtonElement).textContent = `Always allow ${p.level}`;
  } else if (p.kind === "attach") {
    $("detail").textContent = "The tab will move into the agent's tab group. When the session ends it is ungrouped and left open.";
    $("always").remove();
  } else {
    $("detail").textContent = `${p.sensitive?.description ?? "Sensitive action"} · on ${p.origin}`;
    ($("always") as HTMLButtonElement).textContent = "Always allow on this site";
  }
  $("reasons").innerHTML = "";
  for (const r of p.reasons ?? []) {
    const li = document.createElement("li");
    li.textContent = r;
    $("reasons").appendChild(li);
  }
  $("tool").textContent = `Tool: ${p.tool}`;
  const tick = () => {
    const s = Math.max(0, Math.round((p.expires - Date.now()) / 1000));
    $("countdown").textContent = `Times out in ${s}s (the agent gets PROMPT_TIMEOUT)`;
  };
  tick();
  setInterval(tick, 500);
}

for (const a of ["once", "always", "deny"]) {
  $(a)?.addEventListener("click", async () => {
    await send({ type: "ui.answer", promptId: id, answer: a });
    window.close();
  });
}
load();
export {};
