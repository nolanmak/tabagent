// The saved Bitwarden session is per TabAgent home: another bridge (an e2e run, a second
// TABAGENT_HOME) must never read or delete this home's entry (found in live QA, 2026-11-27).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearKeychainSync, keychainAccount, macKeychain } from "../src/auth/keychain";

/** A fake `security` binary that logs its argv (and stdin) to a file. */
function fakeSecurity() {
  const dir = mkdtempSync(join(tmpdir(), "tabagent-sec-"));
  const log = join(dir, "log");
  const bin = join(dir, "security");
  writeFileSync(bin, `#!/bin/sh\necho "ARGV $*" >> "${log}"\nif [ "$1" = "-i" ]; then cat >> "${log}"; fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, log: () => readFileSync(log, "utf8") };
}

describe("keychain entry per TabAgent home", () => {
  it("the account name depends on the Bitwarden data dir and is stable", () => {
    expect(keychainAccount("/Users/a/.tabagent/bitwarden")).toBe(keychainAccount("/Users/a/.tabagent/bitwarden"));
    expect(keychainAccount("/Users/a/.tabagent/bitwarden")).not.toBe(keychainAccount("/tmp/e2e-home/bitwarden"));
    expect(keychainAccount("/x")).toMatch(/^tabagent:[0-9a-f]{16}$/);
  });
  it.runIf(process.platform === "darwin")("save, load and clear all use this home's account", async () => {
    const f = fakeSecurity();
    const ks = macKeychain({ bin: f.bin, dataDir: "/home-a/bitwarden" });
    await ks.save("K".repeat(20));
    await ks.load();
    await ks.clear();
    clearKeychainSync({ bin: f.bin, dataDir: "/home-a/bitwarden" });
    const acct = keychainAccount("/home-a/bitwarden");
    const lines = f.log().split("\n").filter(Boolean);
    expect(lines.filter((l) => l.includes(acct)).length).toBeGreaterThanOrEqual(4);
    expect(f.log()).not.toContain(keychainAccount("/home-b/bitwarden"));
    expect(f.log()).not.toMatch(/-a tabagent(\s|$)/); // never the old global account
  });
});
