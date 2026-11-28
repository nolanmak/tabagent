// Process-tree stand-in for the documented install (spike §1): `claude` -> `npm exec` -> `tabagent mcp`.
// Role "claude" is launched through a symlink named `claude` that points at node, so `ps -o comm=` reports
// `claude`; it writes its pid for the stub `claude agents --json` and runs role "npm" as a child, which runs
// the real `tabagent mcp`. stdio is inherited all the way down, so the MCP client talks to the proxy.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [role, ...rest] = process.argv.slice(2);
const node = process.env.TA_NODE;

function run(cmd, args) {
  const c = spawn(cmd, args, { stdio: "inherit" });
  c.on("exit", (code) => process.exit(code ?? 1));
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => c.kill(s));
}

if (role === "claude") {
  writeFileSync(process.env.TA_PID_FILE, String(process.pid));
  run(node, [fileURLToPath(import.meta.url), "npm", ...rest]);
} else {
  run(node, [process.env.TA_CLI, "mcp", ...rest]);
}
