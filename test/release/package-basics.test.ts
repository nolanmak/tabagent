// #25: one real test per package against the build output.
//   bridge:    `tabagent --version` prints the package version
//   extension: dist/manifest.json is a valid MV3 manifest naming an existing service worker
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, EXT_DIST, readJson, requireBuilt, ROOT } from "./helpers";

describe("bridge build", () => {
  it("--version prints the package version", () => {
    requireBuilt(CLI);
    const pkg = readJson(join(ROOT, "packages/bridge/package.json"));
    const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim();
    expect(out).toContain(pkg.version);
  });
});

describe("extension build", () => {
  const manifestPath = join(EXT_DIST, "manifest.json");

  it("dist/manifest.json is manifest_version 3", () => {
    requireBuilt(manifestPath);
    const m = readJson(manifestPath);
    expect(m.manifest_version).toBe(3);
    expect(typeof m.name).toBe("string");
    expect(m.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it("names a service worker file that exists in dist", () => {
    const m = readJson(manifestPath);
    const sw = m.background?.service_worker;
    expect(typeof sw).toBe("string");
    expect(existsSync(join(EXT_DIST, sw))).toBe(true);
  });

  it("every file the manifest references exists in dist", () => {
    const m = readJson(manifestPath);
    const files = [m.side_panel?.default_path, ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {})].filter(
      (f): f is string => typeof f === "string",
    );
    for (const f of files) expect(existsSync(join(EXT_DIST, f)), f).toBe(true);
  });
});
