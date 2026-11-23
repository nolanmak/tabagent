import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabAgentError } from "@tabagent/protocol";

const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/files", async (orig) => {
  const m = await orig<typeof import("../src/files")>();
  return {
    ...m,
    resolveUploads: (...a: Parameters<typeof m.resolveUploads>) => {
      spy.calls++;
      return m.resolveUploads(...a);
    },
  };
});

import { readDownload, resolveUploads, SessionDownloads } from "../src/files";
import { loadConfig } from "../src/config";
import type { Daemon } from "../src/daemon";
import { okEnvelope, pairedExt, rest, startDaemon } from "./helpers";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as TabAgentError).code;
  }
  return "none";
}

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tabagent-files-")));
  const up = join(root, "uploads");
  const out = join(root, "outside");
  mkdirSync(up);
  mkdirSync(out);
  writeFileSync(join(up, "a.txt"), "hello");
  writeFileSync(join(out, "secret.txt"), "nope");
  mkdirSync(join(up, "sub"));
  symlinkSync(join(out, "secret.txt"), join(up, "link.txt"));
  return { root, up, out };
}

describe("upload paths (D31)", () => {
  it("inside uploadDirs is allowed and canonicalised", () => {
    const { up } = dirs();
    expect(resolveUploads([join(up, "a.txt")], [up])).toEqual([join(up, "a.txt")]);
    expect(resolveUploads(["a.txt"], [up])).toEqual([join(up, "a.txt")]);
    expect(resolveUploads([join(up, "sub", "..", "a.txt")], [up])).toEqual([join(up, "a.txt")]);
  });
  it("outside -> PERMISSION_DENIED; .. escape refused; symlink inside pointing outside refused", () => {
    const { up, out } = dirs();
    expect(code(() => resolveUploads([join(out, "secret.txt")], [up]))).toBe("PERMISSION_DENIED");
    expect(code(() => resolveUploads([join(up, "..", "outside", "secret.txt")], [up]))).toBe("PERMISSION_DENIED");
    expect(code(() => resolveUploads(["../outside/secret.txt"], [up]))).toBe("PERMISSION_DENIED");
    expect(code(() => resolveUploads([join(up, "link.txt")], [up]))).toBe("PERMISSION_DENIED");
  });
  it("non-existent -> NOT_FOUND; a directory -> BAD_REQUEST; no dirs -> PERMISSION_DENIED", () => {
    const { up } = dirs();
    expect(code(() => resolveUploads([join(up, "missing.txt")], [up]))).toBe("NOT_FOUND");
    expect(code(() => resolveUploads([join(up, "sub")], [up]))).toBe("BAD_REQUEST");
    expect(code(() => resolveUploads([join(up, "a.txt")], []))).toBe("PERMISSION_DENIED");
  });
  it("a symlinked upload dir itself is resolved, so files under it are allowed", () => {
    const { root, up } = dirs();
    symlinkSync(up, join(root, "uplink"));
    expect(resolveUploads([join(root, "uplink", "a.txt")], [join(root, "uplink")])).toEqual([join(up, "a.txt")]);
  });
  it("default uploadDirs is ~/.tabagent/uploads only", async () => {
    const { tempHome } = await import("./helpers");
    const h = tempHome();
    expect(loadConfig().uploadDirs).toEqual([join(h, "uploads")]);
  });
});

describe("readDownload (D31)", () => {
  it("text as UTF-8, binary as base64, > 5 MB TOO_LARGE, missing NOT_FOUND", () => {
    const { root } = dirs();
    writeFileSync(join(root, "t.csv"), "name,qty\nwidget,3\nünï\n");
    writeFileSync(join(root, "b.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(root, "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    writeFileSync(join(root, "ok.txt"), Buffer.alloc(5 * 1024 * 1024, 97));
    expect(readDownload(join(root, "t.csv"))).toMatchObject({ encoding: "utf8", text: "name,qty\nwidget,3\nünï\n", name: "t.csv" });
    expect(readDownload(join(root, "b.bin"))).toMatchObject({ encoding: "base64", data: "AAEC/w==", size: 4 });
    expect(code(() => readDownload(join(root, "big.txt")))).toBe("TOO_LARGE");
    expect(readDownload(join(root, "ok.txt")).size).toBe(5 * 1024 * 1024);
    expect(code(() => readDownload(join(root, "nope")))).toBe("NOT_FOUND");
    expect(code(() => readDownload(root))).toBe("NOT_FOUND");
    expect(code(() => readDownload(join(root, "t.csv"), 3))).toBe("TOO_LARGE");
  });
  it("SessionDownloads: only ids reported to that session, with that path", () => {
    const s = new SessionDownloads();
    s.note("s1", [{ id: 1, filename: "/d/a.csv", state: "complete" }, { bogus: true }]);
    s.note("s1", "nope");
    expect(s.check("s1", 1, "/d/a.csv")).toBe("/d/a.csv");
    expect(code(() => s.check("s2", 1, "/d/a.csv"))).toBe("NOT_FOUND");
    expect(code(() => s.check("s1", 1, "/etc/passwd"))).toBe("NOT_FOUND");
    expect(code(() => s.check("s1", 2, "/d/a.csv"))).toBe("NOT_FOUND");
    s.drop("s1");
    expect(code(() => s.check("s1", 1, "/d/a.csv"))).toBe("NOT_FOUND");
  });
});

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

describe("act.upload through the bridge (#11)", () => {
  async function setup(features = ["files.resolve"]) {
    const r = await startDaemon();
    daemons.push(r.d);
    const { up, out } = dirs();
    r.d.cfg.uploadDirs = [up];
    const e = await pairedExt(r.d, undefined, features);
    return { ...r, e, up, out };
  }

  it("without approval the path check is never called (order: extension gate first)", async () => {
    const { base, cfg, e, out } = await setup();
    spy.calls = 0;
    e.onCommand = () => ({ ok: false, error: { code: "PERMISSION_DENIED", message: "User denied" }, audit: { ...okEnvelope({}).audit, outcome: "denied" } });
    const r = await rest(base, "/v1/act.upload", cfg.secret, { ref: "e1", paths: [join(out, "secret.txt")] });
    expect(r.body.error.code).toBe("PERMISSION_DENIED");
    expect(e.msgs.find((m) => m.type === "command").params.paths).toEqual([join(out, "secret.txt")]);
    expect(spy.calls).toBe(0);
  });

  it("after approval the extension asks via files.resolve and gets canonical paths or a refusal", async () => {
    const { base, cfg, e, up, out } = await setup();
    spy.calls = 0;
    const call = rest(base, "/v1/act.upload", cfg.secret, { ref: "e1", paths: ["a.txt", join(up, "link.txt")] });
    const cmd = await e.next("command");
    e.send({ type: "files.resolve", id: "r1", commandId: cmd.id, paths: ["a.txt"] });
    expect(await e.next("files.resolved", (m) => m.id === "r1")).toMatchObject({ type: "files.resolved", id: "r1", ok: true, paths: [join(up, "a.txt")] });
    e.send({ type: "files.resolve", id: "r2", commandId: cmd.id, paths: [join(up, "link.txt")] });
    expect((await e.next("files.resolved", (m) => m.id === "r2")).error.code).toBe("PERMISSION_DENIED");
    e.send({ type: "files.resolve", id: "r3", commandId: cmd.id, paths: [join(out, "secret.txt")] });
    expect((await e.next("files.resolved", (m) => m.id === "r3")).error.message).toMatch(/differ/);
    e.send({ type: "files.resolve", id: "r4", commandId: "nope", paths: ["a.txt"] });
    expect((await e.next("files.resolved", (m) => m.id === "r4")).error.code).toBe("BAD_REQUEST");
    e.send({ type: "files.resolve", id: "bad" }); // malformed: ignored
    e.send({ type: "result", id: cmd.id, ...okEnvelope({ files: [{ name: "a.txt", size: 5 }] }, "act.upload") });
    expect((await call).body.result.files[0].name).toBe("a.txt");
    expect(spy.calls).toBe(2);
  });

  it("files.resolve for a non-upload command is refused", async () => {
    const { base, cfg, e } = await setup();
    const call = rest(base, "/v1/act.click", cfg.secret, { ref: "e1" });
    const cmd = await e.next("command");
    e.send({ type: "files.resolve", id: "r1", commandId: cmd.id, paths: ["a.txt"] });
    expect((await e.next("files.resolved")).ok).toBe(false);
    e.send({ type: "result", id: cmd.id, ...okEnvelope({}, "act.click") });
    await call;
  });

  it("legacy extensions (no files.resolve feature) get pre-validated paths", async () => {
    const { base, cfg, e, up, out } = await setup([]);
    e.onCommand = (c) => okEnvelope({ got: c.params.paths }, "act.upload");
    const ok = await rest(base, "/v1/act.upload", cfg.secret, { ref: "e1", paths: ["a.txt"] });
    expect(ok.body.result.got).toEqual([join(up, "a.txt")]);
    const no = await rest(base, "/v1/act.upload", cfg.secret, { ref: "e1", paths: [join(out, "secret.txt")] });
    expect(no.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("downloads.read through the bridge (#11)", () => {
  it("reads only a download the session saw; others NOT_FOUND; big TOO_LARGE", async () => {
    const r = await startDaemon();
    daemons.push(r.d);
    const { root } = dirs();
    const file = join(root, "data.csv");
    writeFileSync(file, "name,qty\nwidget,3\n");
    const big = join(root, "big.bin");
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 10));
    const e = await pairedExt(r.d);
    e.onCommand = (c) => {
      if (c.tool === "downloads.wait") return okEnvelope({ id: 7, filename: file, state: "complete" }, c.tool);
      if (c.tool === "act.click") return okEnvelope({}, c.tool, { downloads: [{ id: 8, filename: big, state: "complete" }] });
      if (c.tool === "downloads.read") return okEnvelope({ __bridgeRead: { id: c.params.id, path: c.params.id === 7 ? file : big, mime: "text/csv" } }, c.tool);
    };
    const sess = { "x-tabagent-session": "a" };
    expect((await rest(r.base, "/v1/downloads.read", r.cfg.secret, { id: 7 }, sess)).body.error.code).toBe("NOT_FOUND");
    await rest(r.base, "/v1/downloads.wait", r.cfg.secret, {}, sess);
    const got = await rest(r.base, "/v1/downloads.read", r.cfg.secret, { id: 7 }, sess);
    expect(got.body.ok).toBe(true);
    expect(got.body.result.encoding).toBe("utf8");
    expect(got.body.result.text).toMatch(/^<<<PAGE_DATA \w+\nname,qty\nwidget,3\n\nPAGE_DATA/);
    expect(got.body.result.__bridgeRead).toBeUndefined();
    // another session never saw id 7
    expect((await rest(r.base, "/v1/downloads.read", r.cfg.secret, { id: 7 }, { "x-tabagent-session": "b" })).body.error.code).toBe("NOT_FOUND");
    await rest(r.base, "/v1/act.click", r.cfg.secret, { ref: "e1" }, sess);
    const tooBig = await rest(r.base, "/v1/downloads.read", r.cfg.secret, { id: 8 }, sess);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe("TOO_LARGE");
  });
});
