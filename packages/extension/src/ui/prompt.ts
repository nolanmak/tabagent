// Permission prompt window (opened from the notification click when the side panel can't open).
// #108: the same strings and answers as the side panel, the CLI and the phone page (pure/promptView).
import { answerLabel } from "@tabagent/protocol";
import { promptView } from "../pure/promptView";

const id = new URLSearchParams(location.search).get("id")!;
const $ = (i: string) => document.getElementById(i)!;
const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;

async function load() {
  const p = await send({ type: "ui.prompt.get", id });
  if (!p) {
    $("title").textContent = "This request has expired or was already answered.";
    document.querySelector(".actions")?.remove();
    $("timer").remove();
    setTimeout(() => window.close(), 1500);
    return;
  }
  const v = promptView(p);
  $("title").textContent = v.title;
  $("detail").textContent = v.detail;
  const summary = document.createElement("p");
  summary.className = "small";
  summary.id = "summary";
  summary.textContent = v.summary;
  $("detail").after(summary);
  for (const a of ["once", "always", "deny"] as const) {
    if (!v.answers.includes(a)) $(a).remove();
    else $(a).textContent = answerLabel(a, v.alwaysLabel);
  }
  $("reasons").innerHTML = "";
  for (const r of v.reasons) {
    const li = document.createElement("li");
    li.textContent = r;
    $("reasons").appendChild(li);
  }
  $("tool").textContent = `Tool: ${v.tool}`;
  // #156: a thin bar that empties as the prompt runs out; amber for the last 15 seconds.
  const total = Math.max(1, v.expires - Date.now());
  const bar = $("timer").firstElementChild as HTMLElement;
  const tick = () => {
    const left = Math.max(0, v.expires - Date.now());
    const s = Math.round(left / 1000);
    $("countdown").textContent = `Times out in ${s}s (the agent gets PROMPT_TIMEOUT)`;
    bar.style.transform = `scaleX(${left / total})`;
    $("timer").classList.toggle("low", s <= 15);
  };
  tick();
  setInterval(tick, 500);
}

for (const a of ["once", "always", "deny"]) {
  document.getElementById(a)?.addEventListener("click", async () => {
    await send({ type: "ui.answer", promptId: id, answer: a });
    window.close();
  });
}
load();
export {};
