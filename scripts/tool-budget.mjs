#!/usr/bin/env node
// #30 tool budget gate. A token is ceil(chars / 4) (D23) of the JSON that MCP tools/list returns.
// Gates: core <= 2000, full <= 8000. The skill (SKILL.md) has a 1500 soft cap: reported, not gated.
//
//   node scripts/tool-budget.mjs                       # real tools/list from the built bridge
//   node scripts/tool-budget.mjs --fixture core=a.json  # use a saved tools/list JSON for a profile (tests)
//   node scripts/tool-budget.mjs --skill path/to/SKILL.md
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/bridge/dist/cli.js");
export const BUDGETS = { core: 2000, full: 8000 };
export const SKILL_SOFT_CAP = 1500;
export const tokens = (s) => Math.ceil(s.length / 4);

const args = process.argv.slice(2);
const fixtures = {};
let skillPath = join(ROOT, "packages/bridge/skill/SKILL.md");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fixture") {
    const [p, f] = args[++i].split("=");
    fixtures[p] = f;
  } else if (args[i] === "--skill") skillPath = args[++i];
}

function toolsList(profile) {
  if (fixtures[profile]) return readFileSync(fixtures[profile], "utf8").trim();
  if (!existsSync(CLI)) {
    console.error(`tool-budget: ${CLI} missing; run npm run build first`);
    process.exit(2);
  }
  return execFileSync(process.execPath, [CLI, "tools", "--mcp-json", "--profile", profile], { encoding: "utf8" }).trim();
}

let failed = false;
for (const [profile, budget] of Object.entries(BUDGETS)) {
  const json = toolsList(profile);
  const list = JSON.parse(json);
  const used = tokens(json);
  const ok = used <= budget;
  console.log(`${ok ? "ok  " : "FAIL"} ${profile.padEnd(5)} ${String(list.length).padStart(2)} tools  ${used} / ${budget} tokens`);
  if (!ok) {
    failed = true;
    const largest = list
      .map((t) => ({ name: t.name, tokens: tokens(JSON.stringify(t)) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3);
    console.log(`     largest: ${largest.map((t) => `${t.name} (${t.tokens})`).join(", ")}`);
  }
}
if (existsSync(skillPath)) {
  const st = tokens(readFileSync(skillPath, "utf8"));
  console.log(`${st <= SKILL_SOFT_CAP ? "ok  " : "warn"} skill ${st} / ${SKILL_SOFT_CAP} tokens (soft cap, not gated)`);
}
process.exit(failed ? 1 : 0);
