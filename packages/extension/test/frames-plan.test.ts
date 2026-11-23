import { describe, expect, it } from "vitest";
import { ancestry, contentOffset, frameKey, splitKey, translate, translateBox } from "../src/background/frames";
import { marksInView, MAX_CAPTURE_HEIGHT, planCapture } from "../src/background/screenshot-plan";

describe("frame coordinate translation (#19)", () => {
  it("adds border and padding of the owner iframe", () => {
    const o = contentOffset({ rect: { left: 100, top: 300 }, clientLeft: 7, clientTop: 7, paddingLeft: 5, paddingTop: 5 });
    expect(o).toEqual({ x: 112, y: 312, scale: 1 });
    expect(translate({ x: 10, y: 20 }, [o])).toEqual({ x: 122, y: 332 });
  });

  it("nested, scrolled frames compose innermost first", () => {
    // outer iframe sits at y=300 in the top page, but the top page is scrolled by 250
    const outer = contentOffset({ rect: { left: 8, top: 300 - 250 }, clientLeft: 7, clientTop: 7, paddingLeft: 5, paddingTop: 5 });
    // inner iframe inside the outer frame, the outer frame's document is scrolled by 40
    const inner = contentOffset({ rect: { left: 10, top: 60 - 40 }, clientLeft: 3, clientTop: 3, paddingLeft: 0, paddingTop: 0 });
    const p = translate({ x: 30, y: 15 }, [inner, outer]);
    expect(p).toEqual({ x: 8 + 12 + 10 + 3 + 30, y: 50 + 12 + 20 + 3 + 15 });
  });

  it("applies scale and translates boxes", () => {
    const o = contentOffset({ rect: { left: 0, top: 0 }, clientLeft: 2, clientTop: 2, paddingLeft: 0, paddingTop: 0, scale: 2 });
    expect(o).toEqual({ x: 4, y: 4, scale: 2 });
    expect(translateBox({ x: 1, y: 1, w: 10, h: 5 }, [o])).toEqual({ x: 6, y: 6, w: 20, h: 10 });
  });

  it("ancestry and keys", () => {
    const frames = [{ key: "|top" }, { key: "S1|a", parentKey: "|top" }, { key: "S2|b", parentKey: "S1|a" }];
    expect(ancestry(frames, "S2|b")).toEqual(["S2|b", "S1|a"]);
    expect(ancestry(frames, "|top")).toEqual([]);
    expect(frameKey(undefined, "F")).toBe("|F");
    expect(splitKey("S1|a")).toEqual(["S1", "a"]);
    expect(splitKey("|top")).toEqual([undefined, "top"]);
  });
});

describe("screenshot planning (#8)", () => {
  const m = { viewport: { w: 1200, h: 800, pageX: 0, pageY: 400 }, content: { w: 1200, h: 3000 } };

  it("viewport: no clip", () => {
    expect(planCapture("viewport", m)).toEqual({ captureBeyondViewport: false, width: 1200, height: 800 });
  });

  it("clip rectangle computed from a ref's box (page coordinates)", () => {
    const p = planCapture("ref", m, { x: 20, y: 30, w: 80.4, h: 19.6 });
    expect(p.clip).toEqual({ x: 20, y: 430, width: 80, height: 20, scale: 1 });
    expect([p.width, p.height]).toEqual([80, 20]);
    expect(() => planCapture("ref", m)).toThrow();
  });

  it("full page, and the 16,000px cap with a note", () => {
    const p = planCapture("full", m);
    expect(p.clip).toEqual({ x: 0, y: 0, width: 1200, height: 3000, scale: 1 });
    expect(p.note).toBeUndefined();
    const tall = planCapture("full", { ...m, content: { w: 1200, h: 25000 } });
    expect(tall.height).toBe(MAX_CAPTURE_HEIGHT);
    expect(tall.note).toContain("capped at 16000px");
    const el = planCapture("ref", m, { x: 0, y: 0, w: 10, h: 20000 });
    expect(el.height).toBe(MAX_CAPTURE_HEIGHT);
    expect(el.note).toContain("capped");
  });

  it("marks list equals the refs in view", () => {
    const marks = marksInView(
      [
        { ref: "e1", box: { x: 10, y: 10, w: 50, h: 20 } },
        { ref: "e2", box: { x: 10, y: 900, w: 50, h: 20 } },
        { ref: "e3", box: null },
        { ref: "e4", box: { x: -100, y: 10, w: 50, h: 20 } },
        { ref: "e5", box: { x: 1190, y: 790, w: 50, h: 20 } },
        { ref: "e6", box: { x: 0, y: 0, w: 0, h: 0 } },
      ],
      { w: 1200, h: 800 },
    );
    expect(marks.map((x) => x.label)).toEqual(["e1", "e5"]);
    expect(marksInView([{ ref: "a", box: { x: 0, y: 0, w: 1, h: 1 } }, { ref: "b", box: { x: 0, y: 0, w: 1, h: 1 } }], { w: 10, h: 10 }, 1)).toHaveLength(1);
  });
});
