// Shared fakes for the auth tests: fake `op` / `bw` executables on a temp PATH, and fixture output in
// the shapes the CLIs print (op 2.x `--format json`; bw `--response` envelopes). The shapes follow the
// CLIs' docs and source; #37 Step 0 (recording real output from a throwaway account) is still owed, see
// the report. Every secret in a fixture is a random marker chosen by the test.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE = new URL("./fixtures/auth/fake-cli.mjs", import.meta.url).pathname;

export interface FakeCliDir {
  dir: string;
  log: string;
  bin(name: string): string;
  scenario(name: string, s: Record<string, unknown>): void;
  calls(): { name: string; argv: string[]; BW_SESSION: string | null; BITWARDENCLI_APPDATA_DIR: string | null; stdinClosed: boolean }[];
}

export function fakeCliDir(): FakeCliDir {
  const dir = mkdtempSync(join(tmpdir(), "tabagent-fakecli-"));
  const log = join(dir, "calls.jsonl");
  process.env.FAKE_CLI_LOG = log;
  return {
    dir,
    log,
    bin(name) {
      const p = join(dir, name);
      copyFileSync(FAKE, p);
      chmodSync(p, 0o755);
      return p;
    },
    scenario(name, s) {
      const p = join(dir, `${name}.scenario.json`);
      writeFileSync(p, JSON.stringify(s));
      // reset per-key counters
      for (const k of Object.keys(s)) {
        const c = `${p}.count.${k}`;
        if (existsSync(c)) writeFileSync(c, "0");
      }
      process.env[`FAKE_${name.toUpperCase()}_SCENARIO`] = p;
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// ---------------------------------------------------------------------------
// 1Password (`op`)
// ---------------------------------------------------------------------------

export function opItem(id: string, urls: string[], username: string) {
  return {
    id,
    title: `Item ${id}`,
    version: 3,
    vault: { id: "vaultid0000000000000000000", name: "Private" },
    category: "LOGIN",
    last_edited_by: "USERID",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    additional_information: username,
    urls: urls.map((href, i) => ({ ...(i === 0 ? { primary: true } : {}), href })),
  };
}

export function opScenario(o: { items: ReturnType<typeof opItem>[]; secrets?: Record<string, { username?: string; password?: string; otp?: string }>; version?: string; signedIn?: boolean }) {
  const s: Record<string, unknown> = {
    "--version": { stdout: `${o.version ?? "2.30.3"}\n` },
    "account list --format json": { stdout: o.signedIn === false ? "[]" : JSON.stringify([{ url: "my.1password.com", email: "x@example.com", user_uuid: "U", account_uuid: "A" }]) },
    "item list --categories Login --format json": o.signedIn === false ? { stderr: "[ERROR] account is not signed in\n", code: 1 } : { stdout: JSON.stringify(o.items) },
  };
  for (const [id, sec] of Object.entries(o.secrets ?? {})) {
    for (const f of ["username", "password"] as const) {
      if (sec[f] !== undefined) s[`item get ${id} --fields label=${f} --reveal --format json`] = { stdout: JSON.stringify({ id: f, type: f === "password" ? "CONCEALED" : "STRING", purpose: f.toUpperCase(), label: f, value: sec[f], reference: `op://Private/${id}/${f}` }) };
    }
    s[`item get ${id} --otp`] = sec.otp !== undefined ? { stdout: `${sec.otp}\n` } : { stderr: "[ERROR] no one-time password\n", code: 1 };
  }
  return s;
}

// ---------------------------------------------------------------------------
// Bitwarden (`bw`)
// ---------------------------------------------------------------------------

export const ok = (data: unknown) => ({ stdout: JSON.stringify({ success: true, data }) });
export const bad = (message = "Session key is invalid.") => ({ stdout: JSON.stringify({ success: false, message }), code: 1 });
export const bwStatus = (status: "unauthenticated" | "locked" | "unlocked") =>
  ok({ object: "template", template: { serverUrl: "https://vault.example.invalid", lastSync: "2026-11-23T08:00:00.000Z", userEmail: "owner@example.invalid", userId: "u-1", status } });

export interface BwItemOpts {
  id: string;
  username?: string;
  password?: string | null;
  totp?: string | null;
  uris?: { uri: string; match?: number | null }[];
  passkey?: boolean;
  reprompt?: boolean;
  deleted?: boolean;
  type?: number;
  name?: string;
}

export function bwItem(o: BwItemOpts) {
  return {
    passwordHistory: null,
    revisionDate: "2026-11-01T00:00:00.000Z",
    creationDate: "2026-01-01T00:00:00.000Z",
    deletedDate: o.deleted ? "2026-11-20T00:00:00.000Z" : null,
    object: "item",
    id: o.id,
    organizationId: null,
    folderId: "folder-secret-name",
    type: o.type ?? 1,
    reprompt: o.reprompt ? 1 : 0,
    name: o.name ?? `Item ${o.id}`,
    notes: "private notes",
    favorite: false,
    fields: [{ name: "pin", value: "private-field", type: 1 }],
    login: {
      fido2Credentials: o.passkey ? [{ credentialId: "cred", keyType: "public-key", keyValue: "k", rpId: "x" }] : [],
      uris: (o.uris ?? []).map((u) => ({ match: u.match ?? null, uri: u.uri })),
      username: o.username ?? "user@example.com",
      password: o.password === undefined ? "pw" : o.password,
      totp: o.totp ?? null,
      passwordRevisionDate: null,
    },
    collectionIds: [],
  };
}

export function bwScenario(o: {
  key: string;
  items: ReturnType<typeof bwItem>[];
  state?: "unauthenticated" | "locked" | "unlocked";
  version?: string;
  totp?: Record<string, string | null>;
  rejectAfterUnlock?: boolean;
  slowList?: number;
  garbageList?: boolean;
}) {
  const unlockedOnly = (entry: unknown) => ({ ...(entry as object), requiresSession: true, otherwise: bad() });
  const s: Record<string, unknown> = {
    __sessionKey: o.rejectAfterUnlock ? "__nope__" : o.key,
    "--version": { stdout: `${o.version ?? "2025.10.0"}\n` },
    status: { ...bwStatus("unlocked"), requiresSession: true, otherwise: bwStatus(o.state === "unauthenticated" ? "unauthenticated" : "locked") },
    lock: ok({ object: "message", title: "Your vault is locked." }),
    sync: unlockedOnly(ok({ object: "message", title: "Syncing complete." })),
    "list items": o.garbageList ? { stdout: "<html>oops" } : unlockedOnly({ ...ok({ object: "list", data: o.items }), ...(o.slowList ? { sleepMs: o.slowList } : {}) }),
  };
  for (const it of o.items) {
    s[`get password ${it.id}`] = unlockedOnly(ok({ object: "string", data: it.login.password }));
    s[`get username ${it.id}`] = unlockedOnly(ok({ object: "string", data: it.login.username }));
    const t = o.totp?.[it.id];
    s[`get totp ${it.id}`] = unlockedOnly(t ? ok({ object: "string", data: t }) : bad("Premium status is required to use this feature."));
  }
  if (o.rejectAfterUnlock) s.status = { ...bwStatus("locked") };
  return s;
}
