import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import { render, tokensOf, type FrameTree } from "../src/background/snapshot";
import { ax, GOLDENS, list, loadAx, M1_PAGES, source } from "./helpers";

const UPDATE = !!process.env.UPDATE_GOLDENS;
mkdirSync(GOLDENS, { recursive: true });

function golden(name: string, text: string) {
  const f = join(GOLDENS, name);
  if (UPDATE || !existsSync(f)) writeFileSync(f, text + "\n");
  expect(text).toBe(readFileSync(f, "utf8").trimEnd());
}

const INTERACTIVE_ROLES = /^- (button|link|textbox|searchbox|combobox|listbox|option|checkbox|radio|switch|slider|spinbutton|menuitem\w*|tab|treeitem) /;

describe("render: goldens over recorded AX trees", () => {
  for (const page of M1_PAGES) {
    it(`${page} interactive + full`, () => {
      const fx = loadAx(page);
      const tree: FrameTree[] = [{ key: "|main", nodes: fx.nodes, sensitive: fx.sensitive }];
      const r = render(tree, { refs: source() });
      golden(`${page}.interactive.txt`, r.text);
      // M1 budget: every fixture page <= 1500 tokens in interactive mode
      expect(r.tokens).toBeLessThanOrEqual(1500);
      const f = render(tree, { mode: "full", refs: source() });
      golden(`${page}.full.txt`, f.text);
      expect(f.text.length).toBeGreaterThanOrEqual(r.text.length);
    });
  }
});

describe("render: D23 interactive mode", () => {
  it("only interactive nodes carry refs; landmarks and headings appear without refs", () => {
    for (const page of M1_PAGES) {
      const fx = loadAx(page);
      const r = render([{ key: "|main", nodes: fx.nodes }], { refs: source() });
      for (const raw of r.lines) {
        const l = raw.trim();
        if (l.includes("[ref=")) expect(l, `${page}: ${l}`).toMatch(INTERACTIVE_ROLES);
        if (/^- (heading|main|navigation|banner|contentinfo|form|dialog|complementary|region|search)\b/.test(l)) expect(l).not.toContain("[ref=");
      }
    }
    const idx = render(loadAx("index").nodes, { refs: source() }).text;
    expect(idx).toContain('- heading "TabAgent fixtures" level=1');
    expect(idx).toMatch(/- navigation\n/);
    expect(idx).not.toContain("Welcome to the fixture site"); // paragraph text: full mode only
  });

  it("full mode includes text", () => {
    const t = render(loadAx("index").nodes, { mode: "full", refs: source() }).text;
    expect(t).toContain("Welcome to the fixture site");
  });

  it("password and card values render as ••••", () => {
    const fx = loadAx("masked");
    const t = render([{ key: "|main", nodes: fx.nodes, sensitive: fx.sensitive }], { refs: source() }).text;
    expect(t).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
    expect(t).toMatch(/textbox "Card number" \[ref=e\d+\] value="••••"/);
    expect(t).not.toContain("4111");
    expect(t).toContain('value="neo"');
    // without the sensitive list the Chrome bullet value is still masked
    const t2 = render(fx.nodes, { refs: source() }).text;
    expect(t2).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
  });

  it("maxTokens: output within budget, ends with the truncation line carrying the right N", () => {
    const fx = loadAx("form");
    const all = render(fx.nodes, { refs: source() });
    for (const max of [20, 60, 120]) {
      const src = source();
      const r = render(fx.nodes, { maxTokens: max, refs: src });
      expect(r.tokens).toBeLessThanOrEqual(max);
      expect(r.truncated).toBe(true);
      const last = r.lines[r.lines.length - 1];
      const n = Number(last.match(/^- … truncated, (\d+) more nodes; narrow with root=<ref>$/)![1]);
      expect(n).toBe(all.lines.length - (r.lines.length - 1));
      // truncated nodes have no refs until shown
      expect(src.table.size()).toBe(r.refs.length);
    }
  });

  it("root renders only that subtree; unknown root -> REF_STALE", () => {
    const fx = loadAx("form");
    const formNode = fx.nodes.find((n) => n.role?.value === "form")!;
    const r = render(fx.nodes, { root: { frameKey: "|main", backendNodeId: formNode.backendDOMNodeId! }, refs: source() });
    expect(r.text.split("\n")[0]).toBe("- form");
    expect(r.text).not.toContain("Create your account");
    expect(r.text).toContain('button "Create account"');
    let err: unknown;
    try {
      render(fx.nodes, { root: { frameKey: "|main", backendNodeId: 999999 }, refs: source() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TabAgentError);
    expect((err as TabAgentError).code).toBe("REF_STALE");
  });

  it("the same node keeps its ref across renders", () => {
    const fx = loadAx("index");
    const src = source();
    const a = render(fx.nodes, { refs: src });
    const b = render(fx.nodes, { refs: src });
    expect(b.text).toBe(a.text);
    expect(b.refs).toEqual(a.refs);
  });

  it("accepts a bare AXNode[] and an empty tree", () => {
    expect(render([], { refs: source() }).text).toBe("");
  });
});

describe("render: same-process frames", () => {
  const frames = (): FrameTree[] => {
    const main = ax(["RootWebArea", "Top", [["main", undefined, [["button", "Top button"], ["Iframe", "Child", []]]]]]);
    const iframes = main.filter((n) => n.role?.value === "Iframe");
    const child = ax(["RootWebArea", "c", [["button", "Inner button"]]]);
    // same backendNodeId in both frames, different frames
    const innerBtn = child.find((n) => n.role?.value === "button")!;
    innerBtn.backendDOMNodeId = main.find((n) => n.role?.value === "button")!.backendDOMNodeId;
    return [
      { key: "|main", nodes: main },
      { key: "|child", nodes: child, ownerBackendNodeId: iframes[0].backendDOMNodeId, ownerFrameKey: "|main" },
    ];
  };

  it("splices child frames; same backendNodeId in two frames gets two refs", () => {
    const src = source();
    const r = render(frames(), { refs: src });
    expect(r.text).toMatch(/- iframe "Child"\n\s+- button "Inner button" \[ref=e\d+\]/);
    const top = r.shown.find((s) => s.frameKey === "|main")!;
    const inner = r.shown.find((s) => s.frameKey === "|child")!;
    expect(top.backendNodeId).toBe(inner.backendNodeId);
    expect(top.ref).not.toBe(inner.ref);
  });
});

describe("render: M1 hard stop (D23)", () => {
  const page = (n: number) =>
    ax(["RootWebArea", "p", [["main", undefined, [["heading", "Rows", [], { properties: [{ name: "level", value: { value: 1 } }] }], list(n, (i) => ["listitem", undefined, [["link", `Row number ${i}`], ["button", `Open ${i}`]]]), ["button", "After"]]]]]);

  it("pathological page: one 5,000-item list stays within budget; later nodes get no refs", () => {
    const src = source();
    const r = render(page(5000), { refs: src });
    expect(r.tokens).toBeLessThanOrEqual(6000);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/… truncated, (\d+) more nodes; narrow with root=<ref>$/);
    expect(r.text).not.toContain('"After"');
    expect(r.refs.length).toBe(r.shown.length);
  });

  it("tiny budget still ends with the truncation note", () => {
    const r = render(page(500), { maxTokens: 30, refs: source() });
    expect(r.tokens).toBeLessThanOrEqual(30);
    expect(r.text).toMatch(/… truncated, \d+ more nodes; narrow with root=<ref>$/);
  });

  it("no truncation when the page fits", () => {
    const r = render(page(10), { refs: source() });
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBe(0);
    expect(tokensOf(r.text)).toBe(r.tokens);
  });
});
