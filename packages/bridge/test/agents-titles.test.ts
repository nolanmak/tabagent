// Readable Claude session titles (#137, spec §5): parsed from the session transcript's title entries only,
// from a bounded tail read, never from message content.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeProjectSlug,
  defaultClaudeProjectsDir,
  parseTranscriptTitles,
  pickTitle,
  readTail,
  TITLE_MAX,
  TITLE_TAIL_BYTES,
  TitleReader,
  transcriptPath,
  validSessionId,
} from "../src/agents/titles";

const SID = "784eb505-aeff-40d9-963a-0011b242b601";
const ai = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: SID });
const custom = (t: string) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: SID });
const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, sessionId: SID });

describe("project slug (verified against claude 2.1.x: every non-alphanumeric becomes -)", () => {
  it.each([
    ["/Users/x", "-Users-x"],
    ["/Users/nolanmakatche/Documents/Murmur", "-Users-nolanmakatche-Documents-Murmur"],
    ["/Users/me/tabagent/.claude/worktrees/a_b c", "-Users-me-tabagent--claude-worktrees-a-b-c"],
    ["/private/tmp/claude-501/x", "-private-tmp-claude-501-x"],
  ])("%j -> %j", (cwd, slug) => expect(claudeProjectSlug(cwd)).toBe(slug));
});

describe("title parsing", () => {
  it("custom-title wins over ai-title, wherever each appears", () => {
    expect(parseTranscriptTitles([custom("My rename"), ai("Auto one"), user("hi")].join("\n"))).toEqual({ customTitle: "My rename", aiTitle: "Auto one" });
    expect(pickTitle({ customTitle: "My rename", aiTitle: "Auto one" }, "name-03")).toBe("My rename");
  });
  it("the last entry of each kind wins", () => {
    expect(parseTranscriptTitles([ai("First"), user("x"), ai("Second"), custom("A"), custom("B")].join("\n"))).toEqual({ customTitle: "B", aiTitle: "Second" });
  });
  it("falls back to ai-title, then to the vendor name, then null", () => {
    expect(pickTitle({ aiTitle: "Pending user input check" }, "nolanmakatche-22")).toBe("Pending user input check");
    expect(pickTitle({}, "nolanmakatche-22")).toBe("nolanmakatche-22");
    expect(pickTitle({}, null)).toBeNull();
    expect(pickTitle({ customTitle: "  " }, "  ")).toBeNull();
  });
  it("skips malformed lines, wrong types and empty titles", () => {
    const text = ["{not json", JSON.stringify({ type: "ai-title", aiTitle: 7 }), JSON.stringify({ type: "custom-title", customTitle: "   " }), ai("Good"), "", "null", "[]"].join("\n");
    expect(parseTranscriptTitles(text)).toEqual({ aiTitle: "Good" });
  });
  it("never takes a title from message content, even when it quotes a title entry", () => {
    const text = [ai("Real"), user(`please echo ${custom("Injected")}`), JSON.stringify({ type: "assistant", aiTitle: "Nope", customTitle: "Nope" })].join("\n");
    expect(parseTranscriptTitles(text)).toEqual({ aiTitle: "Real" });
  });
  it("drops the first line of a tail that started mid-file (it is a fragment)", () => {
    const tail = `${ai("Cut off")}\n${ai("Whole")}`.slice(5);
    expect(parseTranscriptTitles(tail, { partial: true })).toEqual({ aiTitle: "Whole" });
    // A fragment that happens to parse is still dropped.
    expect(parseTranscriptTitles(`${ai("Fragment")}\n`, { partial: true })).toEqual({});
  });
  it("strips control characters, collapses whitespace and caps the length", () => {
    expect(parseTranscriptTitles(ai("a\u0000b\n\tc  d"))).toEqual({ aiTitle: "ab c d" });
    const long = parseTranscriptTitles(custom("x".repeat(TITLE_MAX + 50))).customTitle!;
    expect(long).toHaveLength(TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("session ids and the projects dir", () => {
  it.each([[SID, true], ["abc", true], ["../etc/passwd", false], ["a/b", false], ["", false], [undefined, false], ["x".repeat(200), false]])("validSessionId(%j) = %j", (id, ok) => {
    expect(validSessionId(id)).toBe(ok);
  });
  it("TABAGENT_CLAUDE_PROJECTS_DIR, then CLAUDE_CONFIG_DIR/projects, then ~/.claude/projects", () => {
    expect(defaultClaudeProjectsDir({ TABAGENT_CLAUDE_PROJECTS_DIR: "/t/p", CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe("/t/p");
    expect(defaultClaudeProjectsDir({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe(join("/c", "projects"));
    expect(defaultClaudeProjectsDir({}, "/h")).toBe(join("/h", ".claude", "projects"));
  });
});

describe("transcript files (tail read)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ta-titles-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (cwd: string, lines: string[], sid = SID, slug = claudeProjectSlug(cwd)) => {
    mkdirSync(join(dir, slug), { recursive: true });
    const p = join(dir, slug, `${sid}.jsonl`);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  };

  it("finds the transcript by cwd slug, and falls back to searching every project dir", () => {
    const p = write("/work/proj", [ai("A")]);
    expect(transcriptPath(dir, "/work/proj", SID)).toBe(p);
    // A slug Claude computed differently (e.g. a long, hashed one) is still found by session id.
    const q = write("/elsewhere", [ai("B")], "aaaa-bbbb", "-some-other-slug-123abc");
    expect(transcriptPath(dir, "/elsewhere", "aaaa-bbbb")).toBe(q);
    expect(transcriptPath(dir, "/work/proj", "missing")).toBeNull();
    expect(transcriptPath(dir, "/work/proj", "../x")).toBeNull();
    expect(transcriptPath(join(dir, "nope"), "/work/proj", SID)).toBeNull();
  });

  it("reads at most the last 256 KB: a title only near the start of a large file is not seen", () => {
    const filler = user("y".repeat(1000));
    const lines = [ai("Too early"), ...Array.from({ length: 400 }, () => filler)];
    const p = write("/big", lines);
    const t = readTail(p, TITLE_TAIL_BYTES)!;
    expect(Buffer.byteLength(t.text)).toBe(TITLE_TAIL_BYTES);
    expect(t.partial).toBe(true);
    const r = new TitleReader({ projectsDir: dir });
    expect(r.titles("/big", SID)).toEqual({});
    appendFileSync(p, ai("Near the end") + "\n" + filler + "\n");
    expect(r.titles("/big", SID)).toEqual({ aiTitle: "Near the end" });
  });

  it("a small file is read whole (not partial)", () => {
    const p = write("/small", [custom("Renamed"), ai("Auto")]);
    expect(readTail(p, TITLE_TAIL_BYTES)!.partial).toBe(false);
    expect(new TitleReader({ projectsDir: dir }).titles("/small", SID)).toEqual({ customTitle: "Renamed", aiTitle: "Auto" });
  });

  it("missing file, missing dir, a directory in place of the file, or a bad session id -> no titles", () => {
    const r = new TitleReader({ projectsDir: dir });
    expect(r.titles("/none", SID)).toEqual({});
    expect(r.titles("/none", undefined)).toEqual({});
    expect(new TitleReader({ projectsDir: join(dir, "missing") }).titles("/none", SID)).toEqual({});
    mkdirSync(join(dir, claudeProjectSlug("/d"), `${SID}.jsonl`), { recursive: true });
    expect(r.titles("/d", SID)).toEqual({});
    expect(readTail(join(dir, "nope.jsonl"), 10)).toBeNull();
  });

  it("re-reads only when the file changed (size or mtime)", () => {
    const p = write("/c", [ai("One")]);
    const r = new TitleReader({ projectsDir: dir });
    expect(r.titles("/c", SID)).toEqual({ aiTitle: "One" });
    appendFileSync(p, custom("Two") + "\n");
    expect(r.titles("/c", SID)).toEqual({ customTitle: "Two", aiTitle: "One" });
  });
});
