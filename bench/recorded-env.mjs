// Dry-run environment (#24): end states come from bench/recorded/states.json.
// Tasks listed in `failing` get their recorded failing state.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadRecordedStates() {
  return JSON.parse(readFileSync(join(HERE, "recorded/states.json"), "utf8"));
}

export function recordedEnv({ failing = [], states = loadRecordedStates() } = {}) {
  const fail = new Set(failing);
  return {
    answers: Object.fromEntries(Object.entries(states).map(([id, s]) => [id, (fail.has(id) ? s.fail : s.pass).answer ?? "Done."])),
    async prepare(task) {
      if (!states[task.id]) throw new Error(`no recorded state for ${task.id}`);
      return { startUrl: `http://localhost:8800/${task.page}` };
    },
    async state(task, final) {
      const s = states[task.id][fail.has(task.id) ? "fail" : "pass"];
      return { ...s, answer: final ?? s.answer };
    },
  };
}
