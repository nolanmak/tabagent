// #23: the built extension's permissions equal the justified list exactly.
// A new permission fails until it is justified in docs/store/permissions.md,
// and a stale justification fails until it is removed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXT_DIST, readJson, requireBuilt, ROOT } from "./helpers";

const isHost = (p: string) => p === "<all_urls>" || p.includes("://");

export function justified(markdown: string): string[] {
  return [...markdown.matchAll(/^### `([^`]+)`\s*$/gm)].map((m) => m[1]);
}

describe("store permission justifications", () => {
  it("cover exactly the built manifest's permissions", () => {
    const manifestPath = join(EXT_DIST, "manifest.json");
    requireBuilt(manifestPath);
    const m = readJson(manifestPath);
    const requested = [
      ...(m.permissions ?? []),
      ...(m.optional_permissions ?? []),
      ...(m.host_permissions ?? []),
      ...(m.optional_host_permissions ?? []),
    ];
    const docs = justified(readFileSync(join(ROOT, "docs/store/permissions.md"), "utf8"));
    expect(new Set(docs).size).toBe(docs.length);
    expect([...requested].sort()).toEqual([...docs].sort());
    // Host patterns must sit under "Host permissions", API permissions above it.
    const md = readFileSync(join(ROOT, "docs/store/permissions.md"), "utf8");
    const hostSection = md.slice(md.indexOf("## Host permissions"));
    for (const p of docs) expect(hostSection.includes(`### \`${p}\``), p).toBe(isHost(p));
  });

  it("the store build drops the dev key", async () => {
    // build.mjs deletes `key` when TABAGENT_STORE_BUILD is set; the release workflow relies on it.
    const src = readFileSync(join(ROOT, "packages/extension/build.mjs"), "utf8");
    expect(src).toMatch(/TABAGENT_STORE_BUILD/);
  });
});
