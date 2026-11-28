// #33 1Password and #37 Bitwarden adapters against fake `op` / `bw` executables replaying CLI-shaped
// output. Secrets in fixtures are random markers.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BW_META_KEYS, BitwardenProvider, BW_HINTS, projectItem } from "../src/auth/bitwarden";
import { nodeRunner, type Runner } from "../src/auth/exec";
import { OnePasswordProvider } from "../src/auth/onepassword";
import { bad, bwItem, bwScenario, fakeCliDir, ok, opItem, opScenario, type FakeCliDir } from "./auth-fakes";

const marker = (p: string) => `${p}-${randomBytes(8).toString("hex")}`;
let fake: FakeCliDir;
beforeEach(() => {
  fake = fakeCliDir();
});

// ---------------------------------------------------------------------------
describe("1Password provider (op)", () => {
  function op(scn: Parameters<typeof opScenario>[0]) {
    fake.scenario("op", opScenario(scn));
    return new OnePasswordProvider({ bin: fake.bin("op") });
  }
  const items = [
    opItem("gh0000000000000000000000aa", ["https://github.com/login"], "nolan@gmail.com"),
    opItem("gh0000000000000000000000bb", ["github.com"], "work@corp.example"), // schemeless = https
    opItem("ev0000000000000000000000cc", ["https://github.com.evil.example"], "x@evil.example"),
    opItem("ht0000000000000000000000dd", ["http://github.com"], "insecure@x.example"), // http item
    opItem("nu0000000000000000000000ee", [], "nourl@x.example"), // no URL
    opItem("tl0000000000000000000000ff", ["https://github.co"], "tld@x.example"), // different TLD
    opItem("sb0000000000000000000000gg", ["https://gist.github.com"], "sub@x.example"), // subdomain item
  ];

  it.each([
    ["https://github.com", ["gh0000000000000000000000aa", "gh0000000000000000000000bb", "sb0000000000000000000000gg"]],
    ["https://api.github.com", ["gh0000000000000000000000aa", "gh0000000000000000000000bb", "sb0000000000000000000000gg"]],
    ["https://github.com.evil.example", ["ev0000000000000000000000cc"]],
    ["https://github.co", ["tl0000000000000000000000ff"]],
    ["http://github.com", []],
  ])("URL match on %s", async (origin, want) => {
    const p = op({ items });
    const got = await p.find(origin);
    expect(got.map((a) => a.id.split(":")[1]).sort()).toEqual([...want].sort());
    for (const a of got) expect(a.id.startsWith("1password:")).toBe(true);
  });

  it("masks usernames and carries the item URLs for the extension's re-check", async () => {
    const p = op({ items: items.slice(0, 1) });
    expect(await p.find("https://github.com")).toEqual([
      { id: "1password:gh0000000000000000000000aa", provider: "1password", accountMasked: "n•••@gmail.com", uris: [{ uri: "https://github.com/login", match: "domain" }] },
    ]);
  });

  it("listing fetches no secret; secret() fetches one field with --reveal; totp with --otp", async () => {
    const pw = marker("PW");
    const p = op({ items: items.slice(0, 1), secrets: { gh0000000000000000000000aa: { username: "nolan@gmail.com", password: pw, otp: "123456" } } });
    await p.find("https://github.com");
    expect(fake.calls().map((c) => c.argv.join(" "))).toEqual(["item list --categories Login --format json"]);
    expect(await p.secret("gh0000000000000000000000aa", "password")).toBe(pw);
    expect(await p.secret("gh0000000000000000000000aa", "username")).toBe("nolan@gmail.com");
    expect(await p.secret("gh0000000000000000000000aa", "totp")).toBe("123456");
    expect(fake.calls().slice(1).map((c) => c.argv.join(" "))).toEqual([
      "item get gh0000000000000000000000aa --fields label=password --reveal --format json",
      "item get gh0000000000000000000000aa --fields label=username --reveal --format json",
      "item get gh0000000000000000000000aa --otp",
    ]);
    for (const c of fake.calls()) expect(c.stdinClosed).toBe(true);
  });

  it("item without OTP → NOT_FOUND", async () => {
    const p = op({ items: items.slice(0, 1), secrets: { gh0000000000000000000000aa: { password: "x" } } });
    await expect(p.secret("gh0000000000000000000000aa", "totp")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects ids that could be flags", async () => {
    const p = op({ items: [] });
    await expect(p.secret("--help", "password")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.calls()).toEqual([]);
  });

  it("status: missing CLI, old version, signed out, ok; locked → NOT_FOUND with a hint, never a password prompt", async () => {
    expect((await new OnePasswordProvider({ bin: join(fake.dir, "no-such-op") }).status()).state).toBe("missing");
    expect((await op({ items: [], version: "2.10.0" }).status()).state).toBe("old-version");
    expect((await op({ items: [], signedIn: false }).status()).state).toBe("logged-out");
    expect(await op({ items: [] }).status()).toEqual({ name: "1password", state: "unlocked", totp: "unknown" });
    const locked = op({ items, signedIn: false });
    const e = await locked.find("https://github.com").catch((x) => x);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.hint).toMatch(/unlock the 1Password app|op signin/);
    expect(JSON.stringify(e)).not.toContain("[ERROR]"); // CLI text is not copied into errors
    await expect(new OnePasswordProvider({ bin: join(fake.dir, "no-such-op") }).find("https://github.com")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("garbage output → INTERNAL with a fixed message", async () => {
    fake.scenario("op", { "item list --categories Login --format json": { stdout: "<<not json>>" } });
    const e = await new OnePasswordProvider({ bin: fake.bin("op") }).find("https://github.com").catch((x) => x);
    expect(e).toMatchObject({ code: "INTERNAL", message: "Unreadable output from the 1Password CLI" });
  });
});

// ---------------------------------------------------------------------------
describe("Bitwarden provider (bw, #37)", () => {
  let t: number;
  const KEY = "S".repeat(10) + randomBytes(16).toString("base64url");
  function bw(scn: Parameters<typeof bwScenario>[0], o: { enabled?: boolean; runner?: Runner } = {}) {
    fake.scenario("bw", bwScenario(scn));
    t = 1_800_000_000_000;
    return new BitwardenProvider({ bin: fake.bin("bw"), dataDir: join(fake.dir, "bwdata"), enabled: () => o.enabled ?? true, now: () => t, runner: o.runner });
  }
  const gh = (o: Partial<Parameters<typeof bwItem>[0]> = {}) => bwItem({ id: "a1b2c3d4-0001", uris: [{ uri: "https://github.com" }], username: "nolan@gmail.com", ...o });

  it("states: disabled, missing, old-version, logged-out, locked, unlocked", async () => {
    expect((await bw({ key: KEY, items: [] }, { enabled: false }).status()).state).toBe("disabled");
    expect((await new BitwardenProvider({ bin: join(fake.dir, "nope"), dataDir: fake.dir, enabled: () => true }).status()).state).toBe("missing");
    expect((await bw({ key: KEY, items: [], version: "1.22.1" }).status()).state).toBe("old-version");
    expect((await bw({ key: KEY, items: [], state: "unauthenticated" }).status())).toEqual({ name: "bitwarden", state: "logged-out", hint: BW_HINTS["logged-out"] });
    const p = bw({ key: KEY, items: [] });
    expect((await p.status()).state).toBe("locked");
    await p.setSession(KEY);
    expect(await p.status()).toEqual({ name: "bitwarden", state: "unlocked", totp: "unknown" });
  });

  it("every child: --nointeraction --response, stdin closed, own data dir, BW_SESSION only when needed", async () => {
    const p = bw({ key: KEY, items: [gh()] });
    await p.status();
    await p.setSession(KEY);
    await p.find("https://github.com");
    await p.secret("a1b2c3d4-0001", "password");
    await p.drop("lock");
    const calls = fake.calls();
    expect(calls.length).toBeGreaterThan(4);
    for (const c of calls) {
      expect(c.argv).toContain("--nointeraction");
      expect(c.argv).toContain("--response");
      expect(c.stdinClosed).toBe(true);
      expect(c.BITWARDENCLI_APPDATA_DIR).toBe(join(fake.dir, "bwdata"));
      expect(c.argv.join(" ")).not.toContain(KEY); // never on argv
      expect(c.argv).not.toContain("serve");
      expect(c.argv).not.toContain("--url"); // no pre-filter
    }
    expect(calls.filter((c) => c.argv[0] === "--version" || c.argv[0] === "lock").every((c) => c.BW_SESSION === null)).toBe(true);
  });

  it("setSession rejects a bad key (checked with bw status) and an unlock refused when disabled", async () => {
    const p = bw({ key: KEY, items: [] });
    await expect(p.setSession("Z".repeat(40))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(p.unlocked).toBe(false);
    await expect(p.setSession("short")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bw({ key: KEY, items: [] }, { enabled: false }).setSession(KEY)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("listing projects into strict metadata: passkey-only, reprompt, trashed, non-login; no secret kept", async () => {
    const pw = marker("PW");
    const seed = marker("SEED");
    const items = [
      gh({ id: "it-login-0001", password: pw, totp: seed }),
      gh({ id: "it-passkey-01", password: null, passkey: true }),
      gh({ id: "it-reprompt-1", reprompt: true }),
      gh({ id: "it-trash-0001", deleted: true }),
      gh({ id: "it-card-00001", type: 3 }),
    ];
    const p = bw({ key: KEY, items });
    await p.setSession(KEY);
    const cache = p.cachedItems();
    expect(cache.map((m) => m.id).sort()).toEqual(["it-login-0001", "it-passkey-01", "it-reprompt-1"]);
    for (const m of cache) expect(Object.keys(m).sort()).toEqual(BW_META_KEYS);
    const dump = JSON.stringify(cache);
    for (const s of [pw, seed, "private notes", "folder-secret-name", "private-field", "Item it-"]) expect(dump).not.toContain(s);
    const byId = Object.fromEntries(cache.map((m) => [m.id, m]));
    expect(byId["it-login-0001"]).toMatchObject({ hasTotp: true, passkeyOnly: false, reprompt: false, accountMasked: "n•••@gmail.com" });
    expect(byId["it-passkey-01"].passkeyOnly).toBe(true);
    expect(byId["it-reprompt-1"].reprompt).toBe(true);
    expect(() => projectItem({ ...items[0], id: "--bad" })).not.toThrow();
    expect(projectItem({ ...items[0], id: "--bad" })).toBeNull();
  });

  it("find returns only origin matches with their URIs; look-alike gets nothing and no `get` runs", async () => {
    const p = bw({ key: KEY, items: [gh(), bwItem({ id: "other-000001", uris: [{ uri: "https://gitlab.com" }] })] });
    await p.setSession(KEY);
    const a = await p.find("https://github.com");
    expect(a).toEqual([{ id: "bitwarden:a1b2c3d4-0001", provider: "bitwarden", accountMasked: "n•••@gmail.com", hasTotp: false, passkeyOnly: false, reprompt: false, uris: [{ uri: "https://github.com", match: null }] }]);
    expect(await p.find("https://github.com.evil.example")).toEqual([]);
    expect(fake.calls().some((c) => c.argv[0] === "get")).toBe(false);
  });

  it("passkey-only and reprompt items are never fetched", async () => {
    const p = bw({ key: KEY, items: [gh({ id: "it-passkey-01", password: null, passkey: true }), gh({ id: "it-reprompt-1", reprompt: true })] });
    await p.setSession(KEY);
    await expect(p.secret("it-passkey-01", "password")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(p.secret("it-reprompt-1", "password")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.calls().some((c) => c.argv[0] === "get")).toBe(false);
  });

  it("locked: find and secret → NOT_FOUND with the user-facing hint", async () => {
    const p = bw({ key: KEY, items: [gh()] });
    const e = await p.find("https://github.com").catch((x) => x);
    expect(e).toMatchObject({ code: "NOT_FOUND", hint: BW_HINTS.locked });
    await expect(p.secret("a1b2c3d4-0001", "password")).rejects.toMatchObject({ code: "NOT_FOUND", hint: BW_HINTS.locked });
  });

  it("session rejected mid-run → key dropped, answered as locked, no retry loop", async () => {
    const scn = { key: KEY, items: [gh()] };
    const p = bw(scn);
    await p.setSession(KEY);
    fake.scenario("bw", { ...bwScenario(scn), __sessionKey: "someone-locked-it" });
    const before = fake.calls().length;
    await expect(p.secret("a1b2c3d4-0001", "password")).rejects.toMatchObject({ code: "NOT_FOUND", hint: BW_HINTS.locked });
    expect(p.unlocked).toBe(false);
    const after = fake.calls().slice(before).map((c) => c.argv[0]);
    expect(after).toEqual(["get", "status", "lock"]);
  });

  it("garbage output → INTERNAL with a fixed message", async () => {
    const p = bw({ key: KEY, items: [gh()], garbageList: true });
    await p.setSession(KEY).catch(() => {});
    const e = await p.sync().catch((x) => x);
    expect(e).toMatchObject({ code: "INTERNAL", message: "Unreadable output from the Bitwarden CLI" });
  });

  it("a slow bw is killed after the timeout → TIMEOUT", async () => {
    const slowRunner: Runner = { run: (b, a, o) => nodeRunner().run(b, a, a[0] === "list" ? { ...o, timeoutMs: 1500 } : o) };
    const p = bw({ key: KEY, items: [gh()], slowList: 5_000 }, { runner: slowRunner });
    await p.setSession(KEY); // its sync times out, swallowed
    await expect(p.sync()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("TOTP: Premium → code; free → plan-required and stays so until the next unlock", async () => {
    const premium = bw({ key: KEY, items: [gh({ totp: "otpauth://x" })], totp: { "a1b2c3d4-0001": "246810" } });
    await premium.setSession(KEY);
    expect(await premium.secret("a1b2c3d4-0001", "totp")).toBe("246810");
    expect(premium.totpState).toBe("available");

    const free = bw({ key: KEY, items: [gh({ totp: "otpauth://x" })] });
    await free.setSession(KEY);
    await expect(free.secret("a1b2c3d4-0001", "totp")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(free.totpState).toBe("plan-required");
    expect((await free.status()).totp).toBe("plan-required");
    const n = fake.calls().length;
    await expect(free.secret("a1b2c3d4-0001", "totp")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.calls().length).toBe(n); // not retried
    await free.setSession(KEY);
    expect(free.totpState).toBe("unknown");
  });

  it("startup removes an inherited BW_SESSION and runs bw lock; comes up locked", async () => {
    const env: NodeJS.ProcessEnv = { BW_SESSION: "inherited", PATH: "x" };
    const p = bw({ key: KEY, items: [] });
    await p.startup(env);
    expect(env.BW_SESSION).toBeUndefined();
    expect(fake.calls().map((c) => c.argv[0])).toEqual(["lock"]);
    expect(p.unlocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Bitwarden lifetime, queue and sync policy (fake clock, in-memory bw)", () => {
  const KEY = "K".repeat(12) + randomBytes(12).toString("base64url");
  function memBw(limits: { idleLockMs?: number; maxUnlockMs?: number } = {}) {
    const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    let gate: Promise<void> | null = null;
    const items = [bwItem({ id: "item-000001", uris: [{ uri: "https://github.com" }], totp: "seed" })];
    const runner: Runner = {
      async run(_bin, args, o) {
        calls.push({ args, env: o?.env ?? {} });
        if (gate) await gate;
        const a = args.filter((x) => !x.startsWith("--n") && x !== "--response");
        const has = o?.env?.BW_SESSION === KEY;
        const r = (x: { stdout: string; code?: number }) => ({ code: x.code ?? 0, stdout: x.stdout, stderr: "" });
        if (a[0] === "status") return r(ok({ object: "template", template: { status: has ? "unlocked" : "locked" } }));
        if (a[0] === "--version") return r({ stdout: "2025.10.0" });
        if (a[0] === "lock") return r(ok({}));
        if (!has) return r(bad());
        if (a.join(" ") === "list items") return r(ok({ object: "list", data: items }));
        if (a[0] === "get") return r(ok({ object: "string", data: "secret-value" }));
        return r(bad());
      },
    };
    let now = 0;
    const events: string[] = [];
    const p = new BitwardenProvider({ ...limits, bin: "bw", dataDir: "/tmp/x", runner, enabled: () => true, now: () => now, event: (e, d) => events.push(`${e}:${(d as { reason?: string }).reason ?? ""}`) });
    return {
      p,
      calls,
      events,
      advance: (ms: number) => (now += ms),
      hold: () => {
        let release!: () => void;
        gate = new Promise((r) => (release = r));
        return () => {
          gate = null;
          release();
        };
      },
    };
  }
  const MIN = 60_000;

  it("auth.status every minute for 31 minutes still idle-locks at 30", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    for (let i = 1; i <= 31; i++) {
      m.advance(MIN);
      await m.p.status();
      await m.p.find("https://github.com").catch(() => {});
    }
    expect(m.p.unlocked).toBe(false);
    expect(m.events).toContain("bitwarden.locked:idle");
    expect(m.calls.map((c) => c.args[0])).toContain("lock");
  });

  it("a fill at 29 minutes extends the idle timer", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    m.advance(29 * MIN);
    await m.p.secret("item-000001", "password");
    m.advance(29 * MIN);
    await m.p.tick();
    expect(m.p.unlocked).toBe(true);
    m.advance(2 * MIN);
    await m.p.tick();
    expect(m.p.unlocked).toBe(false);
  });

  it("with both limits off (Infinity) it stays unlocked for a month of idling", async () => {
    const m = memBw({ idleLockMs: Infinity, maxUnlockMs: Infinity });
    await m.p.setSession(KEY);
    m.advance(30 * 24 * 60 * MIN);
    await m.p.tick();
    expect(m.p.unlocked).toBe(true);
    await m.p.drop("lock");
    expect(m.p.unlocked).toBe(false);
  });

  it("the 8-hour hard cap locks regardless of activity", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    for (let i = 0; i < 8 * 3; i++) {
      m.advance(20 * MIN);
      await m.p.secret("item-000001", "password").catch(() => {});
    }
    expect(m.p.unlocked).toBe(false);
    expect(m.events).toContain("bitwarden.locked:max-unlock");
  });

  it("kill → drop + bw lock; queued calls at drop → NOT_FOUND with the locked hint", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    const release = m.hold();
    const first = m.p.secret("item-000001", "password"); // in flight (held)
    await Promise.resolve();
    const queued = m.p.secret("item-000001", "username"); // queued behind it
    const dropped = m.p.drop("kill");
    release();
    await first.catch(() => {});
    await expect(queued).rejects.toMatchObject({ code: "NOT_FOUND", hint: BW_HINTS.locked });
    await dropped;
    expect(m.p.unlocked).toBe(false);
    expect(m.events).toContain("bitwarden.locked:kill");
    expect(m.calls.at(-1)!.args[0]).toBe("lock");
  });

  it("two concurrent lookups are serialised", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    let running = 0;
    let max = 0;
    const inner = (m.p as unknown as { runner: Runner }).runner;
    (m.p as unknown as { runner: Runner }).runner = {
      async run(b, a, o) {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 20));
        try {
          return await inner.run(b, a, o);
        } finally {
          running--;
        }
      },
    };
    await Promise.all([m.p.secret("item-000001", "password"), m.p.secret("item-000001", "username"), m.p.sync()]);
    expect(max).toBe(1);
  });

  it("sync policy: after unlock, every 30 minutes, a miss once per 5 minutes, once on login-unknown", async () => {
    const m = memBw();
    const lists = () => m.calls.filter((c) => c.args[0] === "list").length;
    await m.p.setSession(KEY);
    expect(lists()).toBe(1); // right after unlock
    m.advance(10 * MIN);
    await m.p.secret("item-000001", "password");
    await m.p.find("https://nomatch.example"); // miss → sync
    expect(lists()).toBe(2);
    await m.p.find("https://nomatch.example"); // within 5 min → no sync
    expect(lists()).toBe(2);
    m.advance(5 * MIN);
    await m.p.secret("item-000001", "password");
    await m.p.find("https://nomatch.example");
    expect(lists()).toBe(3);
    await m.p.find("https://github.com"); // hit: no sync
    expect(lists()).toBe(3);
    m.advance(16 * MIN); // 31 min since last sync... but last sync at 15 min → 31-15=16 <30
    await m.p.secret("item-000001", "password");
    expect(lists()).toBe(3);
    m.advance(15 * MIN);
    await m.p.secret("item-000001", "password");
    expect(lists()).toBe(4); // 30 minutes since the last sync
    m.p.noteLoginUnknown();
    await new Promise((r) => setTimeout(r, 0));
    m.p.noteLoginUnknown();
    await new Promise((r) => setTimeout(r, 0));
    expect(lists()).toBe(5); // once
  });

  it("only BW children ever see BW_SESSION; the key is never on argv", async () => {
    const m = memBw();
    await m.p.setSession(KEY);
    await m.p.secret("item-000001", "password");
    for (const c of m.calls) expect(c.args.join(" ")).not.toContain(KEY);
  });
});

describe("Bitwarden rememberUnlock (Keychain)", () => {
  const KEY2 = "c2Vzc2lvbi1rZXktZm9yLXRlc3Rz";
  function setup(remember: boolean, saved: string | null = null) {
    let stored = saved;
    const ops: string[] = [];
    const keyStore = {
      load: async () => stored,
      save: async (k: string) => { stored = k; ops.push("save"); },
      clear: async () => { stored = null; ops.push("clear"); },
    };
    const calls: string[] = [];
    const runner: Runner = {
      async run(_bin, args, o) {
        const a = args.filter((x) => !x.startsWith("--n") && x !== "--response");
        calls.push(a[0]);
        const has = o?.env?.BW_SESSION === KEY2;
        const r = (x: { stdout: string }) => ({ code: 0, stdout: x.stdout, stderr: "" });
        if (a[0] === "status") return r(ok({ object: "template", template: { status: has ? "unlocked" : "locked" } }));
        if (a[0] === "lock") return r(ok({}));
        if (a.join(" ") === "list items" && has) return r(ok({ object: "list", data: [] }));
        return { code: 1, stdout: bad().stdout, stderr: "" };
      },
    };
    const p = new BitwardenProvider({ bin: "bw", dataDir: "/tmp/x", runner, enabled: () => true, remember: () => remember, keyStore });
    return { p, ops, calls, stored: () => stored };
  }

  it("saves on unlock and restores on the next start without locking", async () => {
    const a = setup(true);
    await a.p.setSession(KEY2);
    expect(a.stored()).toBe(KEY2);
    await a.p.drop("daemon-exit");
    expect(a.stored()).toBe(KEY2);
    expect(a.calls).not.toContain("lock");
    const b = setup(true, KEY2);
    await b.p.startup({});
    expect(b.p.unlocked).toBe(true);
    expect(b.calls).not.toContain("lock");
  });

  it("an explicit lock or the kill switch deletes the saved key", async () => {
    for (const reason of ["lock", "kill", "idle"]) {
      const a = setup(true);
      await a.p.setSession(KEY2);
      await a.p.drop(reason);
      expect(a.stored()).toBeNull();
      expect(a.calls).toContain("lock");
    }
  });

  it("off: never saves, and startup clears any old key and locks", async () => {
    const a = setup(false, KEY2);
    await a.p.startup({});
    expect(a.p.unlocked).toBe(false);
    expect(a.stored()).toBeNull();
    expect(a.calls).toContain("lock");
    await a.p.setSession(KEY2);
    expect(a.ops).not.toContain("save");
  });

  it("a saved key the vault no longer accepts is discarded", async () => {
    const a = setup(true, "bm90LWEtdmFsaWQta2V5LWF0LWFsbA");
    await a.p.startup({});
    expect(a.p.unlocked).toBe(false);
    expect(a.stored()).toBeNull();
  });
});
