import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { checkVersions, readFiles } from "../check-versions.mjs";

const pkg = (v: string) => JSON.stringify({ version: v });
const files = (over: Record<string, string | null> = {}) => ({
  bridgePkg: pkg("1.2.3"),
  extensionPkg: pkg("1.2.3"),
  protocolPkg: pkg("1.2.3"),
  manifest: pkg("1.2.3"),
  protocolSrc: "export const PROTOCOL_VERSION = 4;",
  versionTs: 'export const BRIDGE_VERSION = "1.2.3";',
  ...over,
});

describe("check-versions", () => {
  it("the repo is consistent", () => {
    expect(checkVersions(readFiles()).problems).toEqual([]);
  });
  it("passes when all agree and reports PROTOCOL_VERSION", () => {
    expect(checkVersions(files())).toEqual({ problems: [], version: "1.2.3", protocolVersion: 4 });
  });
  it("flags a manifest that was not bumped", () => {
    expect(checkVersions(files({ manifest: pkg("1.2.2") })).problems).toEqual([
      "packages/extension/manifest.json has version 1.2.2, expected 1.2.3",
    ]);
  });
  it("checks against a release tag", () => {
    expect(checkVersions(files(), "v1.3.0").problems).toHaveLength(5);
  });
  it("ignores a version.ts that reads package.json", () => {
    expect(checkVersions(files({ versionTs: "export const BRIDGE_VERSION = pkg.version;" })).problems).toEqual([]);
    expect(checkVersions(files({ versionTs: null })).problems).toEqual([]);
  });
  it("requires an integer PROTOCOL_VERSION literal", () => {
    expect(checkVersions(files({ protocolSrc: "" })).problems[0]).toMatch(/PROTOCOL_VERSION not found/);
  });
});
