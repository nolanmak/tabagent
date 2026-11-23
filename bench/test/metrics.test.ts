// #24: the metrics collector on a recorded Claude Code transcript.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { charTokens, collect, fromClaudeStreamJson, isTabAgentTool } from "../metrics.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const transcript = readFileSync(join(HERE, "fixtures/claude-stream.jsonl"), "utf8");

describe("metrics collector", () => {
  it("counts calls and tokens on a recorded transcript", () => {
    const m = collect(fromClaudeStreamJson(transcript));
    // tabs + page_snapshot; the Bash call is not a TabAgent call
    expect(m.calls).toBe(2);
    // per message id once: 1530 + 1520 + 1610 + 1705 (cache reads included)
    expect(m.modelTokens).toBe(6365);
    // ceil(55/4) + ceil(33/4); the Bash result is excluded
    expect(m.charTokens).toBe(23);
    expect(m.final).toBe("Gadget");
  });

  it("a result line with usage replaces the per-message sum", () => {
    const withTotal = transcript + '\n{"type":"result","result":"Gadget","usage":{"input_tokens":9000,"output_tokens":100}}\n';
    expect(collect(fromClaudeStreamJson(withTotal)).modelTokens).toBe(9100);
  });

  it("reports n/a model tokens when the agent reports no usage", () => {
    expect(collect([{ type: "tool_call", name: "tabs" }, { type: "tool_result", text: "abcde" }]).modelTokens).toBeNull();
    expect(collect([{ type: "tool_result", text: "abcde" }]).charTokens).toBe(2);
  });

  it("ceil(chars/4) is the token unit", () => {
    expect(charTokens("")).toBe(0);
    expect(charTokens("abcd")).toBe(1);
    expect(charTokens("abcde")).toBe(2);
    expect(charTokens(undefined)).toBe(0);
  });

  it("recognises TabAgent tool names", () => {
    for (const n of ["mcp__tabagent__act_click", "tabs", "act.click", "nav_goto"]) expect(isTabAgentTool(n), n).toBe(true);
    for (const n of ["Bash", "Read", "mcp__other__x"]) expect(isTabAgentTool(n), n).toBe(false);
  });
});
