// Scripted fake agent for dry runs (#24). It "calls" each tool in the task's
// script, gets a canned result, reports deterministic model usage, and ends
// with the answer from the recorded end state. No browser, no model.

const CANNED = {
  "page.snapshot": '- main\n  - heading "Fixture" level=1\n  - button "Go" [ref=e1]\n  - textbox "Name" [ref=e2] value=""',
  "page.markdown": "# Fixture\n\nSome page text.",
  "extract.table": '{"columns":["Name","Price","Qty"],"rows":[["Widget","$12.50","10"],["Gadget","$99.00","3"]]}',
};

export function fakeAgent({ answers = {} } = {}) {
  return {
    name: "fake",
    model: "scripted",
    async run(task) {
      const events = [];
      (task.script ?? []).forEach(([tool], i) => {
        events.push({ type: "usage", input: 1000 + 100 * i, output: 40 });
        events.push({ type: "tool_call", name: tool });
        events.push({ type: "tool_result", text: CANNED[tool] ?? '{"ok":true}' });
      });
      events.push({ type: "usage", input: 1000 + 100 * (task.script?.length ?? 0), output: 20 });
      events.push({ type: "final", text: answers[task.id] ?? "Done." });
      return { events };
    },
  };
}
