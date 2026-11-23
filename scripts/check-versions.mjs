#!/usr/bin/env node
// Release guard (#23): the npm package and the Web Store build ship the same
// version and the same PROTOCOL_VERSION.
//   node scripts/check-versions.mjs [--tag v0.2.0]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pure: collect versions from file contents and return a list of problems. */
export function checkVersions(files, tag) {
  const problems = [];
  const versions = {
    "packages/bridge/package.json": JSON.parse(files.bridgePkg).version,
    "packages/extension/package.json": JSON.parse(files.extensionPkg).version,
    "packages/extension/manifest.json": JSON.parse(files.manifest).version,
    "packages/protocol/package.json": JSON.parse(files.protocolPkg).version,
  };
  // version.ts may read package.json instead of holding a literal; only check a literal.
  const lit = files.versionTs?.match(/BRIDGE_VERSION\s*=\s*["']([^"']+)["']/);
  if (lit) versions["packages/bridge/src/version.ts"] = lit[1];
  const want = tag ? tag.replace(/^v/, "") : versions["packages/bridge/package.json"];
  for (const [file, v] of Object.entries(versions)) if (v !== want) problems.push(`${file} has version ${v}, expected ${want}`);
  const pv = files.protocolSrc.match(/export const PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!pv) problems.push("packages/protocol/src: PROTOCOL_VERSION not found as an integer literal");
  return { problems, version: want, protocolVersion: pv ? Number(pv[1]) : null };
}

export function readFiles(root = ROOT) {
  const r = (p) => readFileSync(join(root, p), "utf8");
  let versionTs = null;
  try {
    versionTs = r("packages/bridge/src/version.ts");
  } catch {
    /* optional */
  }
  return {
    bridgePkg: r("packages/bridge/package.json"),
    extensionPkg: r("packages/extension/package.json"),
    protocolPkg: r("packages/protocol/package.json"),
    manifest: r("packages/extension/manifest.json"),
    // PROTOCOL_VERSION may live in any protocol source file (messages.ts today).
    protocolSrc: readdirSync(join(root, "packages/protocol/src")).filter((f) => f.endsWith(".ts")).map((f) => r(`packages/protocol/src/${f}`)).join("\n"),
    versionTs,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--tag");
  const tag = i > 0 ? process.argv[i + 1] : undefined;
  const { problems, version, protocolVersion } = checkVersions(readFiles(), tag);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`version ${version}, PROTOCOL_VERSION ${protocolVersion}: consistent`);
}
