import { describe, expect, it } from "vitest";
import { getTool, wrapResponse } from "@tabagent/protocol";
import { parseFlags, toolParamsFromArgs } from "../src/args";
import { renderCli, renderMcp } from "../src/format";

const p = (tool: string, args: string[]) => toolParamsFromArgs(getTool(tool)!, parseFlags(args).f);

describe("CLI args (D30)", () => {
  it.each([
    ["nav.goto", ["--json", '{"url":"https://a","timeout":500}'], ["--url", "https://a", "--timeout", "500"]],
    ["act.click", ["--json", '{"ref":"e7","clickCount":2}'], ["--ref=e7", "--clickCount", "2"]],
    ["act.select", ["--json", '{"ref":"e1","values":["a","b"]}'], ["--ref", "e1", "--values", "a,b"]],
    ["act.select", ["--json", '{"ref":"e1","values":["a"]}'], ["--ref", "e1", "--values", '["a"]']],
    ["act.type", ["--json", '{"text":"42","submit":true}'], ["--text", "42", "--submit"]],
    ["act.check", ["--json", '{"ref":"e1","checked":false}'], ["--ref", "e1", "--checked", "false"]],
    ["tabs", ["--json", '{"action":"list"}'], ["--action", "list"]],
  ])("%s: --json and flags give the same params", (tool, json, flags) => {
    expect(p(tool, flags)).toEqual(p(tool, json));
  });
  it("flags override --json; CLI flags are not params", () => {
    expect(p("nav.goto", ["--json", '{"url":"a"}', "--url", "b", "--raw", "--session", "s", "--port", "1", "--out", "x"])).toEqual({ url: "b" });
  });
  it("errors: unknown flag, bad number/boolean, bad JSON", () => {
    expect(() => p("nav.goto", ["--bogus", "1"])).toThrow(/Unknown flag --bogus.*url/);
    expect(() => p("nav.goto", ["--timeout", "soon"])).toThrow(/number/);
    expect(() => p("act.check", ["--ref", "e1", "--checked", "maybe"])).toThrow(/true or false/);
    expect(() => p("nav.goto", ["--json", "{x"])).toThrow(/not valid JSON/);
    expect(() => p("nav.goto", ["--json", "[1]"])).toThrow(/JSON object/);
    expect(() => p("nav.goto", ["--json"])).toThrow(/needs a JSON/);
    expect(() => p("session.end", ["--x", "1"])).toThrow(/\(none\)/);
  });
  it("parseFlags: positional, short flags, = form", () => {
    expect(parseFlags(["tail", "-n", "5", "--follow", "--a=b", "-f"])).toEqual({ f: { n: "5", follow: true, a: "b", f: true }, rest: ["tail"] });
  });
});

describe("rendering (identical wrapping on every surface)", () => {
  const snap = getTool("page.snapshot")!;
  it("first line JSON, big page blocks hoisted with real newlines, short ones inline", () => {
    const { response } = wrapResponse({ ok: true, result: { snapshot: "- a\n- b", title: "T", refs: 2 }, snapshotDiff: "+ x" }, snap, "n");
    const t = renderMcp(response).content[0] as { text: string };
    const [first, ...rest] = t.text.split("\n");
    expect(JSON.parse(first)).toEqual({ title: "<<<PAGE_DATA n\nT\nPAGE_DATA n>>>", refs: 2 });
    expect(rest.join("\n")).toBe("snapshot:\n<<<PAGE_DATA n\n- a\n- b\nPAGE_DATA n>>>\nsnapshotDiff:\n<<<PAGE_DATA n\n+ x\nPAGE_DATA n>>>");
    expect(renderCli(response)).toBe(t.text);
  });
  it("screenshots become image blocks (D30 shape and legacy shape)", () => {
    const r = renderMcp({ ok: true, result: { mime: "image/png", dataBase64: "QUJD", width: 10, height: 5 } });
    expect(r.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ mime: "image/png", width: 10, height: 5 });
    const l = renderMcp({ ok: true, result: { image: { data: "QUJD", mimeType: "image/jpeg" } } });
    expect(l.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(renderCli({ ok: true, result: { mime: "image/png", dataBase64: "QUJD", width: 1, height: 1 } })).toMatch(/\[image image\/png, 0 KB\]/);
  });
  it("errors, empty results, side fields and primitives", () => {
    expect(renderMcp({ ok: false, error: { code: "TIMEOUT", message: "slow", hint: "wait" } })).toEqual({ isError: true, content: [{ type: "text", text: "TIMEOUT: slow\nHint: wait" }] });
    expect((renderMcp({ ok: true }).content[0] as any).text).toBe("ok");
    expect((renderMcp({ ok: true, navigation: { url: "u", title: "t", kind: "k" } }).content[0] as any).text).toBe('{"navigation":{"url":"u","title":"t","kind":"k"}}');
    expect((renderMcp({ ok: true, result: "plain" }).content[0] as any).text).toBe("plain");
    expect((renderMcp({ ok: true, result: [1, 2] }).content[0] as any).text).toBe("[1,2]");
    expect(JSON.parse((renderMcp({ ok: true, result: { a: 1 }, dialogs: [{ type: "alert", message: "m" }] }).content[0] as any).text).dialogs[0].type).toBe("alert");
  });
});
