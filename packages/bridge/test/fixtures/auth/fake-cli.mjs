#!/usr/bin/env node
// Fake `op` / `bw` for tests. Replays a scenario: FAKE_CLI_SCENARIO is a JSON file
// { "<args joined by space>": { stdout, code?, sleepMs? } | [ ...one per call ] , "*": fallback }
// Flags --nointeraction / --response are stripped before matching. Every call is appended to
// FAKE_CLI_LOG as JSON: argv, the two env keys we care about, whether stdin was closed (EOF/null).
import { appendFileSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
let stdinClosed = false;
// Bytes piped on stdin (only the count is logged: stdin may carry an item with a password, #112).
let stdinBytes = 0;
try {
  const buf = Buffer.alloc(65536);
  let n = readSync(0, buf, 0, 1, null);
  stdinClosed = n === 0;
  while (n > 0) {
    stdinBytes += n;
    n = readSync(0, buf, 0, buf.length, null);
  }
} catch {
  stdinClosed = stdinBytes === 0;
}
const name = basename(process.argv[1]);
const log = process.env.FAKE_CLI_LOG;
if (log) {
  appendFileSync(
    log,
    JSON.stringify({ name, argv, BW_SESSION: process.env.BW_SESSION ?? null, BITWARDENCLI_APPDATA_DIR: process.env.BITWARDENCLI_APPDATA_DIR ?? null, stdinClosed, stdinBytes, pid: process.pid }) + "\n",
  );
}
const scenarioPath = process.env[`FAKE_${name.toUpperCase()}_SCENARIO`] ?? process.env.FAKE_CLI_SCENARIO;
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const key = argv.filter((a) => a !== "--nointeraction" && a !== "--response").join(" ");
let entry = scenario[key] ?? scenario[key.replace(/ [A-Za-z0-9-]{8,}$/, " <id>")] ?? scenario["*"];
if (Array.isArray(entry)) {
  // consume one per call, keep the last
  const counter = `${scenarioPath}.count.${key}`;
  let n = 0;
  try {
    n = Number(readFileSync(counter, "utf8"));
  } catch {
    /* first */
  }
  writeFileSync(counter, String(n + 1));
  entry = entry[Math.min(n, entry.length - 1)];
}
// A session-gated entry: answer `locked` unless BW_SESSION equals the scenario's key.
if (entry && entry.requiresSession && process.env.BW_SESSION !== scenario.__sessionKey) entry = entry.otherwise ?? { stdout: JSON.stringify({ success: false, message: "x" }), code: 1 };
if (!entry) {
  process.stderr.write(`fake ${name}: no scenario for "${key}"\n`);
  process.exit(2);
}
const done = () => {
  if (entry.stdout) process.stdout.write(typeof entry.stdout === "string" ? entry.stdout : JSON.stringify(entry.stdout));
  if (entry.stderr) process.stderr.write(entry.stderr);
  process.exit(entry.code ?? 0);
};
if (entry.sleepMs) setTimeout(done, entry.sleepMs);
else done();
