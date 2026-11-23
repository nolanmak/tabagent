import { describe, expect, it } from "vitest";
import { Baselines, diff } from "../src/background/diff";

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

