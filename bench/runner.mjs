// Benchmark runner core (#24): runs tasks through an agent and an environment,
// checks end states, and renders the results table. Pure apart from what the
// agent and environment do, so dry runs are unit-testable.
//
// agent: { name, model, run(task, { startUrl, profile, maxSteps }) -> { events } }
// env:   { prepare(task) -> { startUrl }, state(task, final) -> recorded state, close?() }

import { collect } from "./metrics.mjs";
import { profileOf, TASK_SET_VERSION } from "./tasks.mjs";

export const COLUMNS = ["agent", "model", "date", "task-set", "task", "success", "calls", "tokens (model)", "tokens (chars/4)"];

export async function runTasks({ tasks, agent, env, date = new Date().toISOString().slice(0, 10), maxSteps = 30 }) {
  const rows = [];
  for (const task of tasks) {
    let pass = false;
    let reason = "";
    let m = { calls: 0, modelTokens: null, charTokens: 0, final: null };
    try {
      const { startUrl } = await env.prepare(task);
      const { events } = await agent.run(task, { startUrl, profile: profileOf(task), maxSteps });
      m = collect(events);
      const state = await env.state(task, m.final);
      const verdict = task.check(state);
      pass = verdict.pass;
      reason = verdict.reason;
    } catch (e) {
      reason = `error: ${e?.message ?? e}`;
    }
    rows.push({
      agent: agent.name,
      model: agent.model,
      date,
      taskSet: TASK_SET_VERSION,
      task: task.id,
      success: pass,
      reason,
      calls: m.calls,
      modelTokens: m.modelTokens,
      charTokens: m.charTokens,
    });
  }
  return rows;
}

export function summarize(rows) {
  const passed = rows.filter((r) => r.success).length;
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const anyModel = rows.some((r) => r.modelTokens !== null);
  return { passed, total: rows.length, calls: sum("calls"), modelTokens: anyModel ? sum("modelTokens") : null, charTokens: sum("charTokens") };
}

const cell = (v) => (v === null || v === undefined ? "n/a" : String(v).replace(/\|/g, "\\|"));

export function renderTable(rows) {
  const out = [`| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`];
  for (const r of rows) {
    out.push(`| ${[r.agent, r.model, r.date, r.taskSet, r.task, r.success ? "pass" : `FAIL: ${r.reason}`, r.calls, r.modelTokens, r.charTokens].map(cell).join(" | ")} |`);
  }
  if (rows.length) {
    const s = summarize(rows);
    const r0 = rows[0];
    out.push(`| ${[r0.agent, r0.model, r0.date, r0.taskSet, "**total**", `${s.passed}/${s.total}`, s.calls, s.modelTokens, s.charTokens].map(cell).join(" | ")} |`);
  }
  return out.join("\n") + "\n";
}
