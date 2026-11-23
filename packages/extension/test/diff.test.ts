import { describe, expect, it } from "vitest";
import { Baselines, diff } from "../src/background/diff";
import { render } from "../src/background/snapshot";
import { ax, list, source } from "./helpers";

describe("diff (D24)", () => {
  const a = ["- main", '  - button "Save" [ref=e1]', '  - textbox "Name" [ref=e2] value=""', '  - link "Help" [ref=e3]'];

  it("added / removed / changed lines", () => {
    const b = ["- main", '  - button "Saved" [ref=e1]', '  - textbox "Name" [ref=e2] value="Ada"', '  - checkbox "Agree" [ref=e4] checked=false'];
    const d = diff(a, b);
    expect(d.text.split("\n")).toEqual(['- - link "Help" [ref=e3]', '~ - button "Saved" [ref=e1]', '~ - textbox "Name" [ref=e2] value="Ada"', '+ - checkbox "Agree" [ref=e4] checked=false']);
    expect([d.added, d.removed, d.changed]).toEqual([1, 1, 2]);
  });

  it("pairs unreferenced lines by role and name", () => {
    const d = diff(['- heading "A" level=1'], ['- heading "A" level=2']);
    expect(d.text).toBe('~ - heading "A" level=2');
  });

  it("unchanged -> empty diff", () => {
    const d = diff(a, [...a]);
    expect(d.text).toBe("");
    expect(d.added + d.removed + d.changed).toBe(0);
  });

  it("caps long diffs", () => {
    const b = Array.from({ length: 500 }, (_, i) => `- link "L${i}" [ref=e${100 + i}]`);
    const d = diff([], b, { maxChars: 400 });
    expect(d.text.length).toBeLessThan(500);
    expect(d.text).toMatch(/… \d+ more changed lines; take a page.snapshot$/);
  });

  it("huge inputs fall back to set difference", () => {
    const x = Array.from({ length: 2500 }, (_, i) => `- a "${i}"`);
    const y = Array.from({ length: 2500 }, (_, i) => `- a "${i + 1}"`);
    const d = diff(x, y);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
  });
});

describe("Baselines", () => {
  it("no baseline -> no diff; every delivery advances; navigation clears", () => {
    const b = new Baselines();
    expect(b.deliver("s", 1, ["- a"])).toBeNull();
    expect(b.deliver("s", 1, ["- a", "- b"])!.text).toBe("+ - b");
    expect(b.deliver("s", 1, ["- a", "- b"])!.text).toBe("");
    // per session and per tab
    expect(b.deliver("other", 1, ["- a"])).toBeNull();
    expect(b.deliver("s", 2, ["- a"])).toBeNull();
    b.clearTab(1);
    expect(b.get("s", 1)).toBeUndefined();
    expect(b.get("other", 1)).toBeUndefined();
    expect(b.get("s", 2)).toEqual(["- a"]);
    b.clearSession("s");
    expect(b.get("s", 2)).toBeUndefined();
    b.set("x", 1, ["- q"]);
    b.clear("x", 1);
    expect(b.get("x", 1)).toBeUndefined();
  });
});

describe("diff over collapsed snapshots (#20)", () => {
  const page = (n: number) => ax(["RootWebArea", "p", [["main", undefined, [list(n, (i) => ["listitem", undefined, [["link", `Row ${i}`]]])]]]]);

  it("unchanged page -> empty diff; items collapsed in the baseline are not reported as removed", () => {
    const nodes = page(300);
    const src = source();
    const one = render(nodes, { maxTokens: 400, refs: src });
    const two = render(nodes, { maxTokens: 400, refs: src });
    expect(diff(one.lines, two.lines).text).toBe("");
    // a change elsewhere: only the new button is added, collapsed rows aren't noise
    const main = nodes.find((n) => n.role?.value === "main")!;
    nodes.push({ nodeId: "new-btn", role: { value: "button" }, name: { value: "New" }, backendDOMNodeId: 1, parentId: main.nodeId });
    main.childIds!.push("new-btn");
    const three = render(nodes, { maxTokens: 400, refs: src });
    const d = diff(two.lines, three.lines);
    expect(d.removed).toBe(0);
    expect(d.text).toMatch(/^\+ - button "New"/m);
  });

  it("collapsed-then-expanded items are reported as added", () => {
    const nodes = page(40);
    const src = source();
    const collapsed = render(nodes, { maxTokens: 120, refs: src });
    expect(collapsed.collapsed).toBe(1);
    const expanded = render(nodes, { maxTokens: 6000, refs: src });
    const d = diff(collapsed.lines, expanded.lines);
    expect(d.added).toBe(36);
    expect(d.text).toMatch(/^- - … 36 more listitem items/m);
    expect(d.text).not.toMatch(/^- - link/m);
  });
});
