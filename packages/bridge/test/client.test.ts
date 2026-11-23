import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { api, ensureDaemon, health, restCall } from "../src/client";
import type { Daemon } from "../src/daemon";
import { okEnvelope, pairedExt, startDaemon, tempHome } from "./helpers";

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

async function deadPort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe("client", () => {
  it("health: running daemon -> versions; nothing listening -> null; foreign server -> null", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    expect(await health(r.d.port)).toMatchObject({ ok: true, protocolVersion: 1 });
    expect(await health(await deadPort())).toBeNull();
    const foreign = createServer((_q, s) => s.end('{"ok":true}'));
    await new Promise<void>((res) => foreign.listen(0, "127.0.0.1", () => res()));
    expect(await health((foreign.address() as any).port)).toBeNull();
    foreign.close();
  });
  it("ensureDaemon: does not spawn when one answers", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await ensureDaemon(r.d.port, "/nonexistent.js");
    expect(e).toMatchObject({ spawned: false, health: { ok: true } });
  });
  it("ensureDaemon: spawns a detached process and waits for /v1/health (gives up after waitMs)", async () => {
    tempHome();
    const port = await deadPort();
    const dir = mkdtempSync(join(tmpdir(), "tabagent-fake-cli-"));
    const fake = join(dir, "fake.mjs");
    // stands in for `tabagent serve --port N`
    writeFileSync(
      fake,
      `import {createServer} from "node:http"; const p=Number(process.argv[4]); const s=createServer((q,r)=>r.end(JSON.stringify({ok:true,bridgeVersion:"t",protocolVersion:1}))).listen(p,"127.0.0.1"); setTimeout(()=>{s.close();process.exit(0)},3000);`,
    );
    const e = await ensureDaemon(port, fake);
    expect(e).toMatchObject({ spawned: true, health: { bridgeVersion: "t" } });
    const broken = join(dir, "broken.mjs");
    writeFileSync(broken, "process.exit(1)");
    expect(await ensureDaemon(await deadPort(), broken, 300)).toEqual({ spawned: true, health: null });
  });
  it("restCall: returns the wrapped bridge response; unreachable -> NO_EXTENSION; non-JSON -> INTERNAL", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const e = await pairedExt(r.d);
    e.onCommand = () => okEnvelope({ text: "hello" }, "page.text");
    const ok = await restCall({ port: r.d.port, token: r.cfg.secret, headers: { "x-tabagent-session": "c" } }, "page.text", {});
    expect(ok.ok).toBe(true);
    expect((ok.result as any).text).toMatch(/^<<<PAGE_DATA/);
    const down = await restCall({ port: await deadPort(), token: "x" }, "page.text", {});
    expect(down.error).toMatchObject({ code: "NO_EXTENSION" });
    const junk = createServer((_q, s) => s.end("nope"));
    await new Promise<void>((res) => junk.listen(0, "127.0.0.1", () => res()));
    expect((await restCall({ port: (junk.address() as any).port, token: "x" }, "page.text", undefined)).error?.code).toBe("INTERNAL");
    junk.close();
    expect((await api(r.d.port, r.cfg.secret, "/v1/status")).ok).toBe(true);
    expect((await api(r.d.port, r.cfg.secret, "/v1/pair", "POST", {})).pairCode).toBeTruthy();
    e.close();
  });
});
