#!/usr/bin/env node
// Generate docs/tools.md and docs/lite-mode.md from the tool registry.
//   node scripts/gen-docs.mjs          write the files
//   node scripts/gen-docs.mjs --check  exit 1 if they are stale
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderLiteDoc, renderToolsDoc } from "./gen-docs-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "tabagent-gendocs-"));
  const outfile = join(dir, "registry.mjs");
  try {
    await build({
      stdin: {
        contents: `export { TOOLS } from "./packages/protocol/src/index.ts"; export { toJSONSchema } from "zod";`,
        resolveDir: ROOT,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "error",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 0);
  }
}

export function outputs(TOOLS, toJSONSchema) {
  return {
    "docs/tools.md": renderToolsDoc(TOOLS, toJSONSchema),
    "docs/lite-mode.md": renderLiteDoc(TOOLS),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const { TOOLS, toJSONSchema } = await loadRegistry();
  let stale = 0;
  for (const [rel, text] of Object.entries(outputs(TOOLS, toJSONSchema))) {
    const path = join(ROOT, rel);
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* missing */
    }
    if (current === text) continue;
    if (check) {
      console.error(`${rel} is stale; run \`npm run docs:gen\``);
      stale++;
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
