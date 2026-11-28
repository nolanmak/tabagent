// @vitest-environment happy-dom
// #159: keyboard focus survives a list re-render (the chat rail, the picker and the panel's agent rows rewrite
// their markup on age ticks and status changes). Focus is put back on the same agent's element.
import { beforeEach, describe, expect, it } from "vitest";
import { keepFocus, markFocus, restoreFocus } from "../src/pure/focusKeep";

const rail = (ids: string[], meta = "1m") => ids.map((id) => `<li><a href="#${id}" data-rail-agent="${id}">${id} · ${meta}</a></li>`).join("");
const rows = (ids: string[], meta = "1m") => ids.map((id) => `<li tabindex="0" data-agent-id="${id}">${id} · ${meta} <button data-quick-send="${id}">Quick send</button> <a href="#x">Open</a></li>`).join("");

let box: HTMLUListElement;
beforeEach(() => {
  document.body.innerHTML = `<button id="outside">x</button><ul id="box"></ul>`;
  box = document.getElementById("box") as HTMLUListElement;
});

describe("markFocus / restoreFocus", () => {
  it("restores focus on the same agent's link after the markup is rewritten", () => {
    box.innerHTML = rail(["a", "b:1", 'c"q']);
    (box.querySelector('[data-rail-agent="b:1"]') as HTMLElement).focus();
    const mark = markFocus(box, "data-rail-agent", document.activeElement);
    expect(mark).toEqual({ key: "b:1", part: null });
    box.innerHTML = rail(["b:1", "a", 'c"q'], "2m");
    expect(document.activeElement).toBe(document.body);
    expect(restoreFocus(box, "data-rail-agent", mark)).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.railAgent).toBe("b:1");
    expect(document.activeElement!.textContent).toContain("2m");
  });

  it("works with ids that need escaping in a selector", () => {
    box.innerHTML = rail(['c"q']);
    (box.querySelector("a") as HTMLElement).focus();
    const mark = markFocus(box, "data-rail-agent", document.activeElement);
    box.innerHTML = rail(['c"q'], "3m");
    expect(restoreFocus(box, "data-rail-agent", mark)).toBe(true);
    expect(document.activeElement).toBe(box.querySelector("a"));
  });

  it("a focused control inside the row (Quick send) comes back to that control", () => {
    box.innerHTML = rows(["x", "y"]);
    (box.querySelector('[data-quick-send="y"]') as HTMLElement).focus();
    const mark = markFocus(box, "data-agent-id", document.activeElement);
    expect(mark).toEqual({ key: "y", part: "data-quick-send" });
    box.innerHTML = rows(["x", "y"], "9m");
    restoreFocus(box, "data-agent-id", mark);
    expect(document.activeElement).toBe(box.querySelector('[data-quick-send="y"]'));
  });

  it("a focused element without data attributes is found again by tag name", () => {
    box.innerHTML = rows(["x"]);
    (box.querySelector("a") as HTMLElement).focus();
    const mark = markFocus(box, "data-agent-id", document.activeElement);
    expect(mark).toEqual({ key: "x", part: "a" });
    box.innerHTML = rows(["x"], "2m");
    restoreFocus(box, "data-agent-id", mark);
    expect(document.activeElement).toBe(box.querySelector("a"));
  });

  it("nothing to do when focus is elsewhere, or the agent is gone (focus is not stolen)", () => {
    box.innerHTML = rail(["a"]);
    (document.getElementById("outside") as HTMLElement).focus();
    expect(markFocus(box, "data-rail-agent", document.activeElement)).toBeNull();
    expect(markFocus(box, "data-rail-agent", null)).toBeNull();
    expect(restoreFocus(box, "data-rail-agent", null)).toBe(false);
    (box.querySelector("a") as HTMLElement).focus();
    const mark = markFocus(box, "data-rail-agent", document.activeElement);
    box.innerHTML = rail(["b"]);
    expect(restoreFocus(box, "data-rail-agent", mark)).toBe(false);
  });

  it("an element in the container that is not inside a keyed row is not tracked", () => {
    box.innerHTML = `<li><button id="plain">p</button></li>`;
    (document.getElementById("plain") as HTMLElement).focus();
    expect(markFocus(box, "data-rail-agent", document.activeElement)).toBeNull();
  });
});

describe("keepFocus", () => {
  it("wraps a rewrite: focus stays on the same agent", () => {
    box.innerHTML = rail(["a", "b"]);
    (box.querySelector('[data-rail-agent="b"]') as HTMLElement).focus();
    keepFocus(box, "data-rail-agent", () => (box.innerHTML = rail(["b", "a"], "5m")));
    expect((document.activeElement as HTMLElement).dataset.railAgent).toBe("b");
  });
});
