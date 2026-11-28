// Opt-in persistence of TabAgent's Bitwarden session key in the macOS login Keychain
// (`auth.bitwarden.rememberUnlock on`). The key never appears in argv: writes go through
// `security -i` on stdin. Same threat model as the in-memory key: any process running as this
// macOS user can read it; the gain is only that it survives a bridge restart or reboot.
//
// The entry is per TabAgent home (keyed by the Bitwarden data dir): another bridge with a different
// TABAGENT_HOME (an e2e run, a second install) must never read or delete this home's session.
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface KeyStore {
  load(): Promise<string | null>;
  save(key: string): Promise<void>;
  clear(): Promise<void>;
}

const SERVICE = "tabagent-bitwarden-session";
const KEY_RE = /^[A-Za-z0-9+/=_-]{16,512}$/;
const SECURITY = "/usr/bin/security";

/** Keychain account for one TabAgent home: stable, and different per Bitwarden data dir. */
export function keychainAccount(dataDir: string): string {
  return `tabagent:${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}`;
}

export function macKeychain(o: { dataDir: string; bin?: string }): KeyStore {
  const bin = o.bin ?? SECURITY;
  const account = keychainAccount(o.dataDir);
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(bin, args, { timeout: 10_000 }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) }));
    });
  return {
    async load() {
      if (process.platform !== "darwin") return null;
      const r = await run(["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
      const key = r.stdout.trim();
      return r.code === 0 && KEY_RE.test(key) ? key : null;
    },
    async save(key) {
      if (process.platform !== "darwin" || !KEY_RE.test(key)) return;
      await new Promise<void>((resolve, reject) => {
        const p = spawn(bin, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`security exited ${code}`))));
        p.stdin.end(`add-generic-password -U -a ${account} -s ${SERVICE} -l "TabAgent Bitwarden session" -w "${key}"\n`);
      });
    },
    async clear() {
      if (process.platform !== "darwin") return;
      await run(["delete-generic-password", "-a", account, "-s", SERVICE]);
    },
  };
}

/** Synchronous delete for the CLI (`rememberUnlock off`), which exits right after. */
export function clearKeychainSync(o: { dataDir: string; bin?: string }) {
  if (process.platform !== "darwin") return;
  spawnSync(o.bin ?? SECURITY, ["delete-generic-password", "-a", keychainAccount(o.dataDir), "-s", SERVICE], { stdio: "ignore", timeout: 10_000 });
}
