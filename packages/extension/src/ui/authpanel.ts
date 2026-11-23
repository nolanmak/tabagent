// #35 side-panel handoff UI. sidepanel.ts (agent-safety) renders the Done/Cancel list and fires
// `tabagent:handoffs` after each render. This adds the fixed heading TabAgent writes above the
// agent's reason, so the reason reads as untrusted text the agent supplied (DA9 / #35).
function decorate() {
  for (const li of Array.from(document.querySelectorAll<HTMLLIElement>("#handoffs li[data-handoff-tab]"))) {
    if (li.querySelector(".authHeading")) continue;
    const label = li.querySelector("b")?.textContent ?? "An agent";
    const h = document.createElement("div");
    h.className = "authHeading";
    h.textContent = `${label} is asking you to finish a step in this tab`;
    const reason = li.querySelector(".muted.small");
    if (reason) reason.setAttribute("title", "Text written by the agent, not by TabAgent");
    const note = document.createElement("div");
    note.className = "muted small";
    note.textContent = "The agent's reason (unverified):";
    li.firstElementChild?.prepend(h);
    reason?.before(note);
  }
}

window.addEventListener("tabagent:handoffs", () => decorate());
decorate();
