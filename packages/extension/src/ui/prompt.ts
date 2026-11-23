// Permission prompt window.
const id = new URLSearchParams(location.search).get("id")!;
const $ = (i: string) => document.getElementById(i)!;
const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;

async function load() {
  const p = await send({ type: "ui.prompt.get", id });
  if (!p) {
    $("title").textContent = "This request has expired.";
    document.querySelector(".actions")!.remove();
    setTimeout(() => window.close(), 1500);
    return;
  }
  if (p.kind === "site") {
    $("title").textContent = `${p.label} wants ${p.level === "read" ? "to read" : p.level === "act" ? "to act on" : "full access to"} ${p.origin}`;
    $("detail").textContent = p.level === "read" ? "It will be able to see page content." : p.level === "act" ? "It will be able to click, type and submit forms on this site." : "It will be able to run scripts and read cookies/storage on this site.";
    ($("always") as HTMLButtonElement).textContent = `Always allow ${p.level}`;
  } else if (p.kind === "attach") {
    $("title").textContent = `${p.label} wants to ${p.summary}`;
    $("detail").textContent = "The tab will move into the agent's tab group.";
    $("always").remove();
  } else {
    $("title").textContent = `${p.label} wants to ${p.summary}`;
    $("detail").textContent = `on ${p.origin}`;
    ($("always") as HTMLButtonElement).textContent = "Always allow on this site";
  }
  $("reasons").innerHTML = "";
  for (const r of p.reasons ?? []) {
    const li = document.createElement("li");
    li.textContent = r;
    $("reasons").appendChild(li);
  }
  $("tool").textContent = `Tool: ${p.tool}`;
  const end = p.created + 120_000;
  setInterval(() => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    $("countdown").textContent = `Auto-denies in ${s}s`;
  }, 500);
}

for (const a of ["once", "always", "deny"]) {
  $(a)?.addEventListener("click", async () => {
    await send({ type: "ui.answer", id, answer: a });
    window.close();
  });
}
load();
export {};
