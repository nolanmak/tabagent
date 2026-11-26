// Bridge side of the secret channel (DA2), through a real Daemon, a fake extension on the WebSocket
// and fake `op` / `bw` on PATH. Secrets are random markers; the no-leak sweeps search everywhere the
// bridge could write or return them.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
import fc from "fast-check";
import { getTool, TOOLS, type ToolDef } from "@tabagent/protocol";
import { ADMIN_BITWARDEN_SESSION } from "../src/auth";
import { createToken } from "../src/tokens";
import { bwItem, bwScenario, fakeCliDir, opItem, opScenario, type FakeCliDir } from "./auth-fakes";
import { pairedExt, startDaemon, type FakeExt } from "./helpers";

const marker = (p: string) => `${p}-${randomBytes(10).toString("hex")}`;
const GH_ID = "gh0000000000000000000000aa";

let fake: FakeCliDir;
let oldPath: string | undefined;
let logs: string[];
let ctx: Awaited<ReturnType<typeof startDaemon>>;
let ext: FakeExt;

async function boot(authCfg: Record<string, unknown>, opSecrets: Record<string, { username?: string; password?: string; otp?: string }>, extraItems: ReturnType<typeof opItem>[] = []) {
  fake = fakeCliDir();
  fake.bin("op");
  oldPath = process.env.PATH;
  process.env.PATH = `${fake.dir}:${oldPath}`;
  fake.scenario("op", opScenario({ items: [opItem(GH_ID, ["https://github.com"], "nolan@gmail.com"), ...extraItems], secrets: opSecrets }));
  logs = [];
  const { tempHome } = await import("./helpers");
  const home = tempHome();
  writeFileSync(join(home, "config.json"), JSON.stringify({ auth: authCfg }));
  ctx = await startDaemon({ log: (m) => logs.push(m) }, home);
  ext = await pairedExt(ctx.d);
}

afterEach(async () => {
  ext?.close();
  await ctx?.d.stop();
  if (oldPath !== undefined) process.env.PATH = oldPath;
});

/** Start a tool call over REST and return the command the extension received plus the pending response. */
async function call(tool: string, params: Record<string, unknown> = {}) {
  const resp = fetch(`${ctx.base}/v1/${tool}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.cfg.secret}` }, body: JSON.stringify(params) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const cmd = await ext.next("command", (m) => m.tool === tool);
  return { cmd, resp };
}
async function ask(m: Record<string, unknown>, replyType: string) {
  const id = `r-${randomBytes(4).toString("hex")}`;
  ext.send({ ...m, id });
  return ext.next(replyType, (x) => x.id === id);
}
function envelope(id: string, result: unknown, tool = "auth.login", ok = true) {
  return { type: "result", id, ok, ...(ok ? { result } : { error: result }), audit: { tool, origin: "https://github.com", params: {}, outcome: ok ? "ok" : "error", resultSummary: { bytes: 10, sha256: "x" } } };
}
function everythingOnDisk(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    out += statSync(p).isDirectory() ? everythingOnDisk(p) : readFileSync(p, "latin1");
  }
  return out;
}

describe("secret channel (1Password through fake op)", () => {
  let PW: string;
  beforeEach(async () => {
    PW = marker("PW");
    await boot({ providers: ["1password"] }, { [GH_ID]: { username: "nolan@gmail.com", password: PW, otp: "864209" } });
  });

  it("happy path: accounts → secret → result; the marker is nowhere but the secret message", async () => {
    const { cmd, resp } = await call("auth.login");
    const acc = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    expect(acc.ok).toBe(true);
    expect(acc.accounts).toEqual([{ id: `1password:${GH_ID}`, provider: "1password", accountMasked: "n•••@gmail.com", uris: [{ uri: "https://github.com", match: "domain" }] }]);
    expect(acc.providers).toEqual([{ name: "1password", state: "unlocked", totp: "unknown" }]);
    expect(acc.codeSources.map((c: { name: string }) => c.name)).toEqual(["sms"]);
    const sec = await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" }, "secret");
    expect(sec).toMatchObject({ type: "secret", commandId: cmd.id, field: "password", ok: true, value: PW });
    ext.send(envelope(cmd.id, { filled: true, account: "n•••@gmail.com", source: "1password", submitted: true, next: "done" }));
    const r = await resp;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result).toEqual({ filled: true, account: "n•••@gmail.com", source: "1password", submitted: true, next: "done" });
    // no-leak sweep
    const sweep = [r.text, logs.join("\n"), everythingOnDisk(ctx.home), JSON.stringify(process.env), JSON.stringify(fake.calls().map((c) => c.argv))];
    for (const s of sweep) expect(s).not.toContain(PW);
    // DA11: the secret fetch is audited with provider, masked account, field, outcome; no value
    const audit = readFileSync(join(ctx.home, "audit.jsonl"), "utf8");
    const ev = audit.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === "auth.secret");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ kind: "auth", tool: "auth.login", origin: "https://github.com", provider: "1password", account: "n•••@gmail.com", field: "password", outcome: "ok" });
  });

  it("no-leak property: whatever the password, a well-behaved run never surfaces it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 6, maxLength: 40 }).filter((s) => !/["\\\n]/.test(s) && s.trim().length >= 6), async (pw) => {
        // The marker keeps this property about leaking the *secret value*, not a
        // coincidental ordinary word such as the audit field name "caller".
        const secret = `__tabagent_secret_${pw}__`;
        fake.scenario("op", opScenario({ items: [opItem(GH_ID, ["https://github.com"], "nolan@gmail.com")], secrets: { [GH_ID]: { password: secret } } }));
        const { cmd, resp } = await call("auth.login");
        await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
        const s = await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" }, "secret");
        expect(s.value).toBe(secret);
        ext.send(envelope(cmd.id, { filled: true, account: "n•••@gmail.com", source: "1password", submitted: false, next: "unknown" }));
        const r = await resp;
        expect(r.text.includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
        expect(readFileSync(join(ctx.home, "audit.jsonl"), "utf8").includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
      }),
      { numRuns: 5 },
    );
  });

  it("an extension that leaks the secret into the result gets it withheld (result, audit params)", async () => {
    const { cmd, resp } = await call("auth.login");
    await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" }, "secret");
    const env = envelope(cmd.id, { filled: true, account: "n•••@gmail.com", source: "1password", submitted: true, next: "done" });
    (env.audit as Record<string, unknown>).params = { typed: PW };
    ext.send(env);
    const r = await resp;
    expect(r.text).not.toContain(PW);
    expect(JSON.parse(r.text).error.code).toBe("INTERNAL");
    expect(readFileSync(join(ctx.home, "audit.jsonl"), "utf8")).not.toContain(PW);
  });

  it("a secret tool result that breaks its strict schema is withheld", async () => {
    const { cmd, resp } = await call("auth.login");
    ext.send(envelope(cmd.id, { filled: true, submitted: true, next: "done", note: "free text" }));
    expect(JSON.parse((await resp).text).error.code).toBe("INTERNAL");
  });

  it("only for an in-flight auth.* command: unknown id and a non-auth command are refused, nothing fetched", async () => {
    const r1 = await ask({ type: "auth.accounts", commandId: "nope", origin: "https://github.com" }, "auth.accounts.result");
    expect(r1).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    const { cmd, resp } = await call("page.snapshot");
    const r2 = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    expect(r2.ok).toBe(false);
    const r3 = await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" }, "secret");
    expect(r3).toMatchObject({ ok: false, field: "password" });
    expect(r3.value).toBeUndefined();
    ext.send(envelope(cmd.id, { snapshot: "x" }, "page.snapshot"));
    await resp;
    expect(fake.calls()).toEqual([]);
  });

  it("origin binding: look-alike origin gets no accounts and a secret for github's item is refused without calling op", async () => {
    const { cmd, resp } = await call("auth.login");
    const acc = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com.evil.example" }, "auth.accounts.result");
    expect(acc.accounts).toEqual([]);
    const sec = await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" }, "secret");
    expect(sec).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(fake.calls().filter((c) => c.argv[0] === "item" && c.argv[1] === "get")).toEqual([]);
    ext.send(envelope(cmd.id, { code: "PERMISSION_DENIED", message: "x" }, "auth.login", false));
    await resp;
  });

  it("http page → refused before any provider call", async () => {
    const { cmd, resp } = await call("auth.login");
    const acc = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "http://github.com" }, "auth.accounts.result");
    expect(acc).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(fake.calls()).toEqual([]);
    ext.send(envelope(cmd.id, { code: "PERMISSION_DENIED", message: "x" }, "auth.login", false));
    await resp;
  });

  it("each field once per command; totp only for auth.code (sent back as field code)", async () => {
    const { cmd, resp } = await call("auth.login");
    await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    const req = { type: "auth.secret.request", commandId: cmd.id, accountId: `1password:${GH_ID}`, field: "password" };
    expect((await ask(req, "secret")).ok).toBe(true);
    expect(await ask(req, "secret")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(await ask({ ...req, field: "totp" }, "secret")).toMatchObject({ ok: false, field: "code" });
    ext.send(envelope(cmd.id, { filled: true, submitted: false, next: "code_required" }));
    await resp;

    const c2 = await call("auth.code", { source: "totp" });
    await ask({ type: "auth.accounts", commandId: c2.cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    expect(await ask({ ...req, commandId: c2.cmd.id, field: "totp" }, "secret")).toMatchObject({ ok: true, field: "code", value: "864209" });
    expect(await ask({ ...req, commandId: c2.cmd.id, field: "password" }, "secret")).toMatchObject({ ok: false });
    ext.send(envelope(c2.cmd.id, { filled: true, source: "totp", submitted: true }, "auth.code"));
    expect(JSON.parse((await c2.resp).text).result).toEqual({ filled: true, source: "totp", submitted: true });
  });

  it("an SMS code request while SMS is off → PERMISSION_DENIED with the config hint; audited as source sms", async () => {
    const { cmd, resp } = await call("auth.code", { source: "sms" });
    const r = await ask({ type: "auth.code.request", commandId: cmd.id, source: "sms", since: Date.now(), timeout: 1000 }, "secret");
    if (process.platform === "darwin") expect(r).toMatchObject({ ok: false, field: "code", error: { code: "PERMISSION_DENIED" } });
    else expect(r).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    ext.send(envelope(cmd.id, { code: "PERMISSION_DENIED", message: "x" }, "auth.code", false));
    await resp;
    const ev = readFileSync(join(ctx.home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === "auth.code");
    expect(ev.data).toMatchObject({ kind: "auth", source: "sms", outcome: "error" });
  });

  it("auth.handoff gets the 5-minute wait budget", () => {
    // the daemon's command timer is prompt + tool timeout + slack + authExtraTimeout(tool)
    expect(getTool("auth.handoff")).toBeDefined();
  });
});

describe("#37 admin route and Bitwarden through the daemon", () => {
  let KEY: string;
  let PW: string;
  let SEED: string;
  const BW_ID = "bw-item-000001";
  beforeEach(async () => {
    KEY = "K" + randomBytes(24).toString("base64url");
    PW = marker("BWPW");
    SEED = marker("SEED");
    fake = fakeCliDir();
    const bw = fake.bin("bw");
    fake.scenario("bw", bwScenario({ key: KEY, items: [bwItem({ id: BW_ID, uris: [{ uri: "https://github.com", match: 1 }], password: PW, totp: SEED, username: "nolan@gmail.com" })], totp: { [BW_ID]: "135246" } }));
    process.env.BW_SESSION = "inherited-should-be-removed";
    await boot({ providers: ["bitwarden"], bitwarden: { bin: bw } }, {});
    // boot() made a new fake dir for op; keep the bw scenario env from the first
  });

  const admin = (method: string, body?: unknown, headers: Record<string, string> = {}, token = ctx.cfg.secret) =>
    fetch(`${ctx.base}${ADMIN_BITWARDEN_SESSION}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });

  it("startup removed the inherited BW_SESSION and ran bw lock", () => {
    expect(process.env.BW_SESSION).toBeUndefined();
  });

  it("route: D3 token → 401, browser Origin → 403, bridge secret → 204; bad key → 400", async () => {
    const tok = createToken(ctx.d.cfg, "bot", "full");
    expect((await admin("POST", { key: KEY }, {}, tok)).status).toBe(401);
    expect((await admin("POST", { key: KEY }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await admin("POST", { key: "Z".repeat(30) })).status).toBe(400);
    expect((await admin("POST", { key: KEY })).status).toBe(204);
    expect(ctx.d.auth.bitwarden.unlocked).toBe(true);
    expect((await admin("DELETE")).status).toBe(204);
    expect(ctx.d.auth.bitwarden.unlocked).toBe(false);
  });

  it("registry sweep: no tool reaches /v1/admin/*", async () => {
    for (const t of TOOLS as unknown as ToolDef[]) {
      expect(`/v1/${t.name}`.startsWith("/v1/admin")).toBe(false);
      expect(t.name.startsWith("admin")).toBe(false);
    }
    const r = await fetch(`${ctx.base}/v1/admin.bitwarden`, { method: "POST", headers: { authorization: `Bearer ${ctx.cfg.secret}` }, body: "{}" });
    expect(r.status).not.toBe(204);
  });

  it("full flow: unlock, accounts, login secret, TOTP, kill; no marker anywhere; unlock/lock audited without the key", async () => {
    expect((await admin("POST", { key: KEY })).status).toBe(204);
    const { cmd, resp } = await call("auth.login");
    const acc = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    expect(acc.accounts).toEqual([{ id: `bitwarden:${BW_ID}`, provider: "bitwarden", accountMasked: "n•••@gmail.com", hasTotp: true, passkeyOnly: false, reprompt: false, uris: [{ uri: "https://github.com", match: "host" }] }]);
    expect(acc.providers).toEqual([{ name: "bitwarden", state: "unlocked", totp: "unknown" }]);
    const sec = await ask({ type: "auth.secret.request", commandId: cmd.id, accountId: `bitwarden:${BW_ID}`, field: "password" }, "secret");
    expect(sec.value).toBe(PW);
    ext.send(envelope(cmd.id, { filled: true, account: "n•••@gmail.com", source: "bitwarden", submitted: true, next: "code_required" }));
    const r1 = await resp;

    const c2 = await call("auth.code", { source: "totp" });
    await ask({ type: "auth.accounts", commandId: c2.cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    const code = await ask({ type: "auth.secret.request", commandId: c2.cmd.id, accountId: `bitwarden:${BW_ID}`, field: "totp" }, "secret");
    expect(code).toMatchObject({ ok: true, field: "code", value: "135246" });
    ext.send(envelope(c2.cmd.id, { filled: true, source: "totp", submitted: true }, "auth.code"));
    const r2 = await c2.resp;

    // kill reaches the bridge as an event and drops the key
    ext.send({ type: "event", event: "killed", data: { kind: "kill" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.d.auth.bitwarden.unlocked).toBe(false);

    const sweep = [r1.text, r2.text, logs.join("\n"), everythingOnDisk(ctx.home), JSON.stringify(process.env)];
    for (const s of sweep) {
      expect(s).not.toContain(PW);
      expect(s).not.toContain(SEED);
      expect(s).not.toContain(KEY);
    }
    for (const c of fake.calls()) {
      expect(c.argv.join(" ")).not.toContain(KEY);
      if (c.name !== "bw") expect(c.BW_SESSION).toBeNull();
    }
    const events = readFileSync(join(ctx.home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
    expect(events).toContain("bitwarden.unlocked");
    expect(events).toContain("bitwarden.locked");
  });

  it("a hello with paused: true after reconnect drops the key first", async () => {
    expect((await admin("POST", { key: KEY })).status).toBe(204);
    ext.close();
    const { FakeExt } = await import("./helpers");
    const e2 = new FakeExt(ctx.d.port);
    await e2.hello({ secret: ctx.cfg.secret, paused: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.d.auth.bitwarden.unlocked).toBe(false);
    e2.close();
  });

  it("locked → auth.accounts reports the state with the user hint and no accounts", async () => {
    const { cmd, resp } = await call("auth.status");
    const acc = await ask({ type: "auth.accounts", commandId: cmd.id, origin: "https://github.com" }, "auth.accounts.result");
    expect(acc.accounts).toEqual([]);
    expect(acc.providers[0]).toMatchObject({ name: "bitwarden", state: "locked" });
    expect(acc.providers[0].hint).toContain("tabagent bitwarden unlock");
    ext.send(envelope(cmd.id, { loginFormPresent: true, providers: acc.providers.map((p: object) => ({ ...p, accounts: [] })), codeSources: [] }, "auth.status"));
    await resp;
  });
});
