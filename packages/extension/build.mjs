// Build the MV3 extension into dist/.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const watch = process.argv.includes("--watch");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, target: "chrome125", logLevel: "warning", sourcemap: false, legalComments: "none" };

// pagelib first: it is both a file (lite mode) and an inlined string (CDP isolated worlds)
await build({ ...common, entryPoints: [join(here, "src/pagelib/index.ts")], outfile: join(out, "pagelib.js"), format: "iife" });
const pagelibSrc = readFileSync(join(out, "pagelib.js"), "utf8");

await build({
  ...common,
  entryPoints: [join(here, "src/background/index.ts")],
  outfile: join(out, "background.js"),
  format: "esm",
  define: { PAGELIB_SRC: JSON.stringify(pagelibSrc) },
});
const uiEntries = { sidepanel: join(here, "src/ui/sidepanel.ts"), prompt: join(here, "src/ui/prompt.ts") };
await build({ ...common, entryPoints: uiEntries, outdir: out, format: "iife" });

cpSync(join(here, "static"), out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
if (process.env.TABAGENT_STORE_BUILD) delete manifest.key; // Web Store assigns its own id
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("extension built ->", out);
if (watch) console.log("(watch not implemented; re-run build)");
