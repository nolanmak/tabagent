// #29 skill installer. Claude Code: ~/.claude/skills/tabagent. Codex (OT6): $CODEX_HOME/skills/tabagent,
// default ~/.codex/skills/tabagent; Codex reads the same SKILL.md format (YAML frontmatter name + description).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillTarget {
  name: "claude" | "codex";
  dir: string;
}

export type InstallAction = "installed" | "updated" | "unchanged" | "refused";
export type UninstallAction = "removed" | "absent" | "refused";

const MANIFEST = ".tabagent-skill.json";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function skillTargets(o: { claude?: boolean; codex?: boolean; home?: string; codexHome?: string } = {}): SkillTarget[] {
  const home = o.home ?? homedir();
  const both = !o.claude && !o.codex;
  const out: SkillTarget[] = [];
  if (o.claude || both) out.push({ name: "claude", dir: join(home, ".claude", "skills", "tabagent") });
  if (o.codex || both) out.push({ name: "codex", dir: join(o.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"), "skills", "tabagent") });
  return out;
}

function installedHash(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")).sha256 ?? null;
  } catch {
    return null;
  }
}

/** A file is "modified" when it differs from what we last installed (or we never installed it). */
function isModified(dir: string): boolean {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return false;
  return sha(readFileSync(file)) !== installedHash(dir);
}

export function installSkill(src: string, targets: SkillTarget[], force = false): { target: SkillTarget; path: string; action: InstallAction }[] {
  const content = readFileSync(src);
  const h = sha(content);
  return targets.map((target) => {
    const path = join(target.dir, "SKILL.md");
    if (existsSync(path)) {
      if (sha(readFileSync(path)) === h) {
        writeFileSync(join(target.dir, MANIFEST), JSON.stringify({ sha256: h }) + "\n");
        return { target, path, action: "unchanged" as const };
      }
      if (isModified(target.dir) && !force) return { target, path, action: "refused" as const };
    }
    const existed = existsSync(path);
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(path, content);
    writeFileSync(join(target.dir, MANIFEST), JSON.stringify({ sha256: h }) + "\n");
    return { target, path, action: existed ? ("updated" as const) : ("installed" as const) };
  });
}

export function uninstallSkill(targets: SkillTarget[], force = false): { target: SkillTarget; action: UninstallAction }[] {
  return targets.map((target) => {
    const path = join(target.dir, "SKILL.md");
    if (!existsSync(path) && !existsSync(join(target.dir, MANIFEST))) return { target, action: "absent" as const };
    if (isModified(target.dir) && !force) return { target, action: "refused" as const };
    rmSync(path, { force: true });
    rmSync(join(target.dir, MANIFEST), { force: true });
    try {
      if (!readdirSync(target.dir).length) rmdirSync(target.dir);
    } catch {
      /* keep a non-empty dir */
    }
    return { target, action: "removed" as const };
  });
}
