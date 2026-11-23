import { describe, expect, it } from "vitest";
import { getTool } from "@tabagent/protocol";
import { parseFlags, toolParamsFromArgs } from "../src/args";
import { renderCli, renderMcp } from "../src/format";

const p = (tool: string, args: string[]) => toolParamsFromArgs(getTool(tool)!, parseFlags(args).f);

describe("CLI args (D30)", () => {
  it.each([
    ["nav.goto", ["--json", '{"url":"https://a","timeout":500}'], ["--url", "https://a", "--timeout", "500"]],
    ["nav.goto", ["--json", '{"url":"https://a","tabId":7}'], ["--url=https://a", "--tabId", "7"]],
    ["nav.reload", ["--json", '{"timeout":100}'], ["--timeout", "100"]],
    ["tabs", ["--json", '{"action":"list"}'], ["--action", "list"]],
    ["tabs", ["--json", '{"action":"new","url":"https://a"}'], ["--action", "new", "--url", "https://a"]],
  ])("%s: --json and flags give the same params", (tool, json, flags) => {
    expect(p(tool, flags)).toEqual(p(tool, json));
  });
  it("flags override --json; CLI flags are not params", () => {
    expect(p("nav.goto", ["--json", '{"url":"a"}', "--url", "b", "--raw", "--session", "s", "--port", "1", "--out", "x"])).toEqual({ url: "b" });
  });
  it("errors: unknown flag, bad number/boolean, bad JSON", () => {
    expect(() => p("nav.goto", ["--bogus", "1"])).toThrow(/Unknown flag --bogus.*url/);
    expect(() => p("nav.goto", ["--timeout", "soon"])).toThrow(/number/);
    expect(() => p("nav.goto", ["--json", "{x"])).toThrow(/not valid JSON/);
    expect(() => p("nav.goto", ["--json", "[1]"])).toThrow(/JSON object/);
    expect(() => p("nav.goto", ["--json"])).toThrow(/needs a JSON/);
  });
  it("parseFlags: positional, short flags, = form", () => {
    expect(parseFlags(["tail", "-n", "5", "--follow", "--a=b", "-f"])).toEqual({ f: { n: "5", follow: true, a: "b", f: true }, rest: ["tail"] });
  });
});

describe("rendering (identical on every surface)", () => {
  it("first line JSON, then a snapshotDiff block", () => {
    const response = { ok: true, result: { title: "T", url: "http://a/" }, snapshotDiff: "+ x" };
    const t = renderMcp(response).content[0] as { text: string };
    const [first, ...rest] = t.text.split("\n");
    expect(JSON.parse(first)).toEqual({ title: "T", url: "http://a/" });
    expect(rest.join("\n")).toBe("snapshotDiff:\n+ x");
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
