#!/usr/bin/env node
// TabAgent benchmark (#24).
//
//   node bench/run.mjs --dry-run [--fail id,id] [--tasks id,id] [--out file.md]
//       Scripted fake agent + recorded end states. No browser, no model. Runs in CI.
//   node bench/run.mjs --agent claude-code --model <model> [--tasks ...] [--max-steps 30] [--out file.md]
//       Real run: e2e harness browser + bridge, real agent. Needs model credentials
//       (manual `bench` workflow, never a required check).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fakeAgent } from "./agents/fake.mjs";
import { recordedEnv } from "./recorded-env.mjs";
import { renderTable, runTasks, summarize } from "./runner.mjs";
import { getTask, TASKS } from "./tasks.mjs";

export function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) f[k] = argv[++i];
    else f[k] = true;
  }
  return f;
}

const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export async function main(argv, { log = console.log } = {}) {
  const f = parseArgs(argv);
  const tasks = f.tasks ? list(f.tasks).map(getTask) : TASKS;
  const maxSteps = Number(f["max-steps"] ?? 30);
  let agent;
  let env;
  if (f["dry-run"]) {
    for (const id of list(f.fail)) getTask(id);
    env = recordedEnv({ failing: list(f.fail) });
    agent = fakeAgent({ answers: env.answers });
  } else {
    if (f.agent !== "claude-code") throw new Error("Real runs need --agent claude-code (or use --dry-run)");
    const { liveEnv, CLI } = await import("./live-env.mjs");
    const { claudeCodeAgent } = await import("./agents/claude-code.mjs");
    env = await liveEnv();
    agent = claudeCodeAgent({ model: typeof f.model === "string" ? f.model : undefined, cli: CLI, tabagentHome: env.home });
  }
  let rows;
  try {
    rows = await runTasks({ tasks, agent, env, maxSteps, date: typeof f.date === "string" ? f.date : undefined });
  } finally {
    await env.close?.();
  }
  const table = renderTable(rows);
  if (typeof f.out === "string") writeFileSync(f.out, table);
  log(table);
  const s = summarize(rows);
  log(`${s.passed}/${s.total} tasks passed`);
  return { rows, table, summary: s };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = parseArgs(process.argv.slice(2));
  main(process.argv.slice(2))
    .then(({ summary }) => process.exit(f["dry-run"] && !f.fail && summary.passed !== summary.total ? 1 : 0))
    .catch((e) => {
      console.error(e?.message ?? e);
      process.exit(2);
    });
}
