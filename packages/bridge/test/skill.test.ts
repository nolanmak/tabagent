import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ERROR_CODES, getTool, PROFILES, ResultEnvelopeSchema, TOOLS, type ToolDef } from "@tabagent/protocol";
import { installSkill, skillTargets, uninstallSkill } from "../src/skill";

const SKILL = join(__dirname, "../skill/SKILL.md");
const text = readFileSync(SKILL, "utf8");
const tools = TOOLS as unknown as ToolDef[];

function codeSpans(md: string): string[] {
  const body = md.replace(/^---[\s\S]*?---/, "");
  return [...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

function keysOf(schema: z.ZodType): string[] {
  let s: any = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
  if (s instanceof z.ZodObject) return Object.entries(s.shape).flatMap(([k, v]) => [k, ...keysOf(v as z.ZodType)]);
  if (s instanceof z.ZodArray) return keysOf(s.element as z.ZodType);
  return [];
}

/** Every name the skill may mention: params, result fields and envelope fields. */
const KNOWN_FIELDS = new Set([...tools.flatMap((t) => [...Object.keys(t.params.shape), ...keysOf(t.result)]), ...Object.keys(ResultEnvelopeSchema.shape), ...PROFILES]);
const TOOL_RE = /^(tabs|nav|page|act|form|extract|dialog|js|console|network|cookies|storage|downloads|session)([._][A-Za-z]+)?\b/;

export function lintSkill(md: string): string[] {
  const problems: string[] = [];
  for (const span of codeSpans(md)) {
    if (/^tabagent\b|^~|^<<<|^- |PAGE_DATA|^https?:/.test(span)) continue;
    if (/^[A-Z][A-Z_]{3,}$/.test(span)) {
      if (!(ERROR_CODES as readonly string[]).includes(span)) problems.push(`unknown error code ${span}`);
      continue;
    }
    const m = span.match(TOOL_RE);
    if (m && (m[2] || m[1] === "tabs")) {
      const tool = getTool(m[0]);
      if (!tool) {
        problems.push(`unknown tool ${m[0]}`);
        continue;
      }
      const brace = span.slice(m[0].length).match(/^\s*\{(.*)\}\s*$/);
      if (brace) {
        for (const part of brace[1].split(",")) {
          const key = part.split(":")[0].trim();
          if (key && !(key in tool.params.shape)) problems.push(`${tool.name} has no param ${key}`);
        }
      }
      continue;
    }
    const field = span.match(/^([a-zA-Z][a-zA-Z0-9]*)(:.*)?$/);
    if (field && !KNOWN_FIELDS.has(field[1])) problems.push(`unknown field ${field[1]}`);
  }
  return problems;
}

describe("SKILL.md lint (#29)", () => {
  it("every tool, param, field and error code in code formatting exists in the registry", () => {
    expect(lintSkill(text)).toEqual([]);
  });
  it("a renamed tool, a bad param or a bad code fails the lint", () => {
    expect(lintSkill("use `nav.go`")).toEqual(["unknown tool nav.go"]);
    expect(lintSkill("use `act.click {ref, selector}`")).toEqual(["act.click has no param selector"]);
    expect(lintSkill("got `NO_SUCH_CODE`")).toEqual(["unknown error code NO_SUCH_CODE"]);
    expect(lintSkill("read `snapshotDif`")).toEqual(["unknown field snapshotDif"]);
    expect(lintSkill("MCP `nav_goto` and `page_find {by, value}`")).toEqual([]);
  });
  it("frontmatter parses and has name and description", () => {
    const fm = text.match(/^---\n([\s\S]*?)\n---/)![1];
    const kv = Object.fromEntries(fm.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    expect(kv.name).toBe("tabagent");
    expect(kv.description.length).toBeGreaterThan(40);
    expect(kv.description.length).toBeLessThanOrEqual(1024);
  });
  it("tells agents to sign in with the auth tools before asking the user", () => {
    for (const t of ["auth.status", "auth.login", "auth.code", "auth.handoff"]) expect(text).toContain("`" + t);
    expect(text).toMatch(/--profile[^\n]*auth/);
    expect(text).not.toMatch(/At a login wall, ask the user to sign in/);
  });
  it("covers the troubleshooting codes and D19 guidance", () => {
    for (const c of ["NO_EXTENSION", "TAB_BUSY", "PERMISSION_DENIED", "PROMPT_TIMEOUT", "KILLED", "DIALOG_OPEN", "REF_STALE"]) expect(text).toContain("`" + c + "`");
    expect(text).toMatch(/side panel/);
    expect(text).toMatch(/--json/);
  });
});

describe("skill installer (#29)", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "tabagent-home-"));
  it("targets: both by default; Claude and Codex paths; CODEX_HOME respected", () => {
    const h = "/h";
    expect(skillTargets({ home: h, codexHome: undefined }).map((t) => t.name)).toEqual(["claude", "codex"]);
    const prev = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    expect(skillTargets({ home: h }).map((t) => t.dir)).toEqual(["/h/.claude/skills/tabagent", "/h/.codex/skills/tabagent"]);
    expect(skillTargets({ home: h, codex: true, codexHome: "/c" })).toEqual([{ name: "codex", dir: "/c/skills/tabagent" }]);
    expect(skillTargets({ home: h, claude: true }).map((t) => t.name)).toEqual(["claude"]);
    if (prev !== undefined) process.env.CODEX_HOME = prev;
  });
  it("installs into both targets; second run is a no-op", () => {
    const home = fresh();
    const targets = skillTargets({ home, codexHome: join(home, ".codex") });
    expect(installSkill(SKILL, targets).map((r) => r.action)).toEqual(["installed", "installed"]);
    for (const t of targets) expect(readFileSync(join(t.dir, "SKILL.md"), "utf8")).toBe(text);
    expect(installSkill(SKILL, targets).map((r) => r.action)).toEqual(["unchanged", "unchanged"]);
  });
  it("a locally edited file is not overwritten without --force; an older unedited copy is updated", () => {
    const home = fresh();
    const [t] = skillTargets({ home, claude: true });
    const old = join(home, "old.md");
    writeFileSync(old, "---\nname: tabagent\ndescription: old\n---\n");
    installSkill(old, [t]);
    expect(installSkill(SKILL, [t])[0].action).toBe("updated");
    writeFileSync(join(t.dir, "SKILL.md"), text + "\nmy notes\n");
    expect(installSkill(SKILL, [t])[0].action).toBe("refused");
    expect(readFileSync(join(t.dir, "SKILL.md"), "utf8")).toContain("my notes");
    expect(uninstallSkill([t])[0].action).toBe("refused");
    expect(installSkill(SKILL, [t], true)[0].action).toBe("updated");
    expect(readFileSync(join(t.dir, "SKILL.md"), "utf8")).toBe(text);
  });
  it("a pre-existing SKILL.md we didn't write counts as modified", () => {
    const home = fresh();
    const [t] = skillTargets({ home, claude: true });
    installSkill(SKILL, [t]);
    writeFileSync(join(t.dir, ".tabagent-skill.json"), "{bad");
    writeFileSync(join(t.dir, "SKILL.md"), "someone else's");
    expect(installSkill(SKILL, [t])[0].action).toBe("refused");
  });
  it("uninstall removes them; again reports absent; --force removes edited", () => {
    const home = fresh();
    const targets = skillTargets({ home, codexHome: join(home, ".codex") });
    installSkill(SKILL, targets);
    expect(uninstallSkill(targets).map((r) => r.action)).toEqual(["removed", "removed"]);
    for (const t of targets) expect(existsSync(t.dir)).toBe(false);
    expect(uninstallSkill(targets).map((r) => r.action)).toEqual(["absent", "absent"]);
    installSkill(SKILL, targets);
    writeFileSync(join(targets[0].dir, "SKILL.md"), "edited");
    writeFileSync(join(targets[0].dir, "keep.txt"), "x");
    expect(uninstallSkill(targets, true)[0].action).toBe("removed");
    expect(existsSync(join(targets[0].dir, "keep.txt"))).toBe(true);
  });
});

describe("MCP server instructions", () => {
  it("point agents at the auth tools for sign-in walls", async () => {
    const { INSTRUCTIONS } = await import("../src/mcp");
    expect(INSTRUCTIONS).toMatch(/auth_status/);
    expect(INSTRUCTIONS).toMatch(/--profile[^.]*auth/);
  });
});
