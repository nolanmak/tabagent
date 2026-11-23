import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configCommand, helpText, skillCommand, toolOutput, toolsCommand } from "../src/commands";
import { loadConfig } from "../src/config";
import { tempHome } from "./helpers";

const SKILL = join(__dirname, "../skill/SKILL.md");

describe("CLI commands", () => {
  it("tools lists a profile; bad profile fails", () => {
    expect(toolsCommand("core").out.at(-1)).toMatch(/^9 tools/);
    expect(toolsCommand("nope").code).toBe(1);
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
  it("config show hides secrets; set port", () => {
    const h = tempHome();
    const show = JSON.parse(configCommand([]).out[0]);
    expect(show.secret).toBe("(set)");
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
  it("loadConfig/saveConfig preserve unknown top-level keys", async () => {
    const { saveConfig } = await import("../src/config");
    const h = tempHome();
    writeFileSync(join(h, "config.json"), JSON.stringify({ auth: { sms: { x: 1 } } }));
    const cfg = loadConfig();
    cfg.extensionIds.push("abc");
    saveConfig(cfg);
    const disk = JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
    expect(disk.auth).toEqual({ sms: { x: 1 } });
    expect(disk.extensionIds).toEqual(["abc"]);
  });
  it("help mentions the canonical --json form", () => {
    expect(helpText()).toMatch(/--json/);
  });
});
