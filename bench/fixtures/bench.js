// Shared by every bench fixture page. Pages record their end state in
// localStorage["bench"] (per origin, shared across tabs, survives navigation);
// the runner reads it after the agent finishes and hands it to the checker.
window.bench = {
  get() {
    try {
      return JSON.parse(localStorage.getItem("bench") || "{}");
    } catch {
      return {};
    }
  },
  set(patch) {
    const next = Object.assign(this.get(), patch);
    localStorage.setItem("bench", JSON.stringify(next));
    return next;
  },
  formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") out[el.name] = el.checked;
      else if (el.type === "radio") {
        if (el.checked) out[el.name] = el.value;
      } else out[el.name] = el.value;
    }
    return out;
  },
};
