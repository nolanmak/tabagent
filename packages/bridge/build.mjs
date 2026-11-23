import { build } from "esbuild";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, "dist"), { recursive: true, force: true });
mkdirSync(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "src/cli.ts")],
  outfile: join(here, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "ws", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
chmodSync(join(here, "dist/cli.js"), 0o755);
// ship the built extension inside the npm package for `tabagent extension path`
try {
  cpSync(join(here, "../extension/dist"), join(here, "dist/extension"), { recursive: true });
} catch {
  /* extension not built */
}
console.log("bridge built -> dist/cli.js");
