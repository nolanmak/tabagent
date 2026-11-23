import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditWriter } from "../src/audit";
import { auditTail, configCommand, formatAuditLine, helpText, skillCommand, tokenCommand, toolOutput, toolsCommand } from "../src/commands";
import { auditPath, loadConfig } from "../src/config";
import { tempHome } from "./helpers";

const SKILL = join(__dirname, "../skill/SKILL.md");

describe("CLI commands", () => {
  it("tools lists a profile; bad profile fails", () => {
    expect(toolsCommand("core").out.at(-1)).toMatch(/^13 tools/);
    expect(toolsCommand("nope").code).toBe(1);
  });
  it("token create/list/revoke", () => {
    tempHome();
    expect(tokenCommand(["list"], {}).out).toEqual(["No tokens."]);
    const c = tokenCommand(["create"], { name: "bot", caps: "read", sites: "*.a.com" });
    expect(c.code).toBe(0);
    expect(c.out[0]).toMatch(/^tab_/);
    expect(c.err[0]).toMatch(/caps=read, sites=\*\.a\.com/);
    expect(loadConfig().tokens[0]).toMatchObject({ name: "bot", cap: "read" });
    expect(tokenCommand(["create", "legacy"], { cap: "full" }).code).toBe(0);
    expect(tokenCommand(["list"], {}).out[0]).toMatch(/bot\s+caps=read\s+sites=\*\.a\.com/);
    expect(tokenCommand(["create"], { name: "x", caps: "root" }).code).toBe(1);
    expect(tokenCommand(["revoke", "bot"], {}).code).toBe(0);
    expect(tokenCommand(["revoke", "bot"], {}).err[0]).toMatch(/No token/);
    expect(tokenCommand([], {}).err[0]).toMatch(/Usage/);
  });
  it("audit tail formats records and events", () => {
    tempHome();
    expect(auditTail(5).out).toEqual(["No audit log yet."]);
    const w = new AuditWriter(auditPath());
    w.record({ tool: "tabs", action: "new", origin: "https://a", params: { url: "x" }, outcome: "ok", errorCode: undefined, resultSummary: { bytes: 1, sha256: "s" } }, { caller: "cc" });
    w.minimal("act.click", "error", { caller: "cc" }, "NO_EXTENSION");
    w.event("killed", { by: "user" });
    const lines = auditTail(2).out;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/cc\s+error\s+act\.click\s+-\s+NO_EXTENSION/);
    expect(lines[1]).toMatch(/event killed \{"by":"user"\}/);
    expect(auditTail(5).out[0]).toMatch(/tabs\(new\)\s+https:\/\/a\s+\{"url":"x"\}/);
    expect(formatAuditLine("not json")).toBe("not json");
  });
  it("skill install/uninstall/print", () => {
    const home = mkdtempSync(join(tmpdir(), "tabagent-ch-"));
    const prevHome = process.env.HOME;
    const prevCodex = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, ".codex");
    try {
      expect(skillCommand(["install"], {}, SKILL).out.join("\n")).toMatch(/Installed \(claude\)[\s\S]*Installed \(codex\)/);
      expect(skillCommand(["install"], {}, SKILL).out[0]).toMatch(/Up to date/);
      writeFileSync(join(home, ".claude/skills/tabagent/SKILL.md"), "mine");
      const r = skillCommand(["install"], { claude: true }, SKILL);
      expect(r.code).toBe(1);
      expect(skillCommand(["uninstall"], { claude: true }, SKILL).code).toBe(1);
      expect(skillCommand(["install"], { claude: true, force: true }, SKILL).out[0]).toMatch(/Updated/);
      expect(skillCommand(["uninstall"], {}, SKILL).out.join("\n")).toMatch(/Removed \(claude\)[\s\S]*Removed \(codex\)/);
      expect(skillCommand(["uninstall"], { codex: true }, SKILL).out[0]).toMatch(/Not installed/);
      expect(skillCommand(["print"], {}, SKILL).out[0]).toContain("name: tabagent");
      expect(skillCommand(["bogus"], {}, SKILL).code).toBe(1);
    } finally {
      process.env.HOME = prevHome;
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
    }
  });
  it("config show hides secrets; add-upload-dir; set port", () => {
    const h = tempHome();
    const show = JSON.parse(configCommand([]).out[0]);
    expect(show.secret).toBe("(set)");
    expect(show.uploadDirs).toEqual([join(h, "uploads")]);
    expect(configCommand(["add-upload-dir", h]).out[0]).toContain(h);
    expect(configCommand(["set", "port", "5555"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(h, "config.json"), "utf8")).port).toBe(5555);
    expect(configCommand(["set", "port", "x"]).code).toBe(1);
  });
  it("tool output: text, raw, errors, screenshot to file (D30)", () => {
    tempHome();
    expect(toolOutput({ ok: true, result: { a: 1 } }, {}).out[0]).toBe('{"a":1}');
    expect(JSON.parse(toolOutput({ ok: true, result: { a: 1 } }, { raw: true }).out[0]).result.a).toBe(1);
    const e = toolOutput({ ok: false, error: { code: "TAB_BUSY", message: "owned", hint: "use your tabs" } }, {});
    expect([e.code, e.err[0]]).toEqual([1, "TAB_BUSY: owned\nHint: use your tabs"]);
    expect(toolOutput({ ok: false, error: { code: "KILLED", message: "k" } }, {}).err[0]).toBe("KILLED: k");
    const shot = { ok: true, result: { mime: "image/png", dataBase64: Buffer.from("PNGDATA").toString("base64"), width: 2, height: 3 } };
    const tmp = toolOutput(shot, {}, 42).out[0];
    expect(tmp).toMatch(/tabagent-42\.png$/);
    expect(readFileSync(tmp, "utf8")).toBe("PNGDATA");
    const dir = mkdtempSync(join(tmpdir(), "tabagent-shot-"));
    const raw = JSON.parse(toolOutput({ ok: true, result: { ...shot.result, mime: "image/jpeg" } }, { out: join(dir, "s.jpg"), raw: true }).out[0]);
    expect(raw.result).toEqual({ mime: "image/jpeg", width: 2, height: 3, savedTo: join(dir, "s.jpg") });
    expect(existsSync(join(dir, "s.jpg"))).toBe(true);
    expect(toolOutput({ ok: true, result: { ...shot.result, mime: "image/jpeg" } }, {}, 7).out[0]).toMatch(/\.jpg$/);
  });
  it("help mentions the canonical --json form", () => {
    expect(helpText()).toMatch(/--json/);
  });
});
