import { describe, expect, it } from "vitest";
import { capMatches, describeWait, InflightCounter, NAV_WAIT_DEFAULT_MS, normalizeFind, normalizeWait, pollUntil, urlMatcher } from "../src/background/wait";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
};

describe("nav.wait (#26)", () => {
  it("defaults: 30s timeout, capped at 120s; value required for value kinds", () => {
    expect(normalizeWait({ for: "load" })).toEqual({ kind: "load", value: undefined, timeout: NAV_WAIT_DEFAULT_MS });
    expect(normalizeWait({ for: "networkidle", timeout: 999_999 }).timeout).toBe(120_000);
    for (const k of ["selector", "text", "url", "fn"]) expect(codeOf(() => normalizeWait({ for: k }))).toBe("BAD_REQUEST");
    expect(codeOf(() => normalizeWait({ for: "nope" }))).toBe("BAD_REQUEST");
    expect(describeWait({ kind: "text", value: "Ready", timeout: 1 })).toBe('text "Ready"');
  });

  it("url: substring vs /regex/; invalid regex -> BAD_REQUEST", () => {
    expect(urlMatcher("step=2")("http://x/wait.html?step=2")).toBe(true);
    expect(urlMatcher("step=3")("http://x/wait.html?step=2")).toBe(false);
    // only slash-wrapped values are regexes
    expect(urlMatcher("/wait\\.html\\?step=\\d$/")("http://x/wait.html?step=2")).toBe(true);
    expect(urlMatcher("/wait.html")("http://x/wait.html")).toBe(true);
    expect(urlMatcher("/^https:/")("http://x/p/apple")).toBe(false); // slash-wrapped = regex
    expect(codeOf(() => urlMatcher("/([a-/"))).toBe("BAD_REQUEST");
    expect(codeOf(() => normalizeWait({ for: "url", value: "/(/" }))).toBe("BAD_REQUEST");
  });

  it("pollUntil: resolves once true, times out false, treats errors as not yet", async () => {
    const c = fakeClock();
    let n = 0;
    expect(await pollUntil(() => ++n >= 3, 1000, c, 100)).toBe(true);
    expect(c.now()).toBe(200);
    expect(await pollUntil(() => false, 450, c, 100)).toBe(false);
    let k = 0;
    expect(
      await pollUntil(
        () => {
          if (++k < 2) throw new Error("navigating");
          return true;
        },
        1000,
        c,
      ),
    ).toBe(true);
  });

  it("networkidle: resolves 500ms after the in-flight count reaches zero; a new request resets the window", async () => {
    const c = fakeClock();
    const net = new InflightCounter(c);
    net.start("a");
    c.advance(300);
    expect(net.isIdle(500)).toBe(false);
    net.end("a");
    c.advance(400);
    expect(net.isIdle(500)).toBe(false);
    net.start("b");
    c.advance(200);
    net.end("b");
    c.advance(499);
    expect(net.isIdle(500)).toBe(false);
    c.advance(1);
    expect(net.isIdle(500)).toBe(true);
    // waitIdle with the fake clock
    net.start("c");
    const p = net.waitIdle(500, 300, c);
    expect(await p).toBe(false);
    net.endWhere((id) => id === "c");
    expect(await net.waitIdle(500, 2000, c)).toBe(true);
  });

  it("ignores requests stuck longer than stuckMs; clear()", () => {
    const c = fakeClock();
    const net = new InflightCounter(c, 1000);
    net.start("long-poll");
    c.advance(1500);
    expect(net.count()).toBe(0);
    net.start("x");
    expect(net.ids()).toEqual(["x"]);
    net.clear();
    expect(net.count()).toBe(0);
    net.end("missing");
  });
});

describe("page.find params (#26)", () => {
  it("accepts {by, value, name?, root?}", () => {
    expect(normalizeFind({ by: "role", value: "button", name: "Save", root: "e4" })).toEqual({ by: "role", value: "button", name: "Save", root: "e4" });
    for (const by of ["text", "role", "label", "css", "xpath"]) expect(normalizeFind({ by, value: "v" }).by).toBe(by);
    expect(codeOf(() => normalizeFind({ by: "magic", value: "x" }))).toBe("BAD_REQUEST");
    expect(codeOf(() => normalizeFind({ by: "css", value: "" }))).toBe("BAD_REQUEST");
    expect(codeOf(() => normalizeFind({}))).toBe("BAD_REQUEST");
  });

  it("accepts the spike's {text|role|label|css|xpath} shape", () => {
    expect(normalizeFind({ css: "li" })).toEqual({ by: "css", value: "li", name: undefined, root: undefined });
    expect(normalizeFind({ role: "heading", name: "Details" })).toEqual({ by: "role", value: "heading", name: "Details", root: undefined });
    expect(normalizeFind({ name: "Save" })).toEqual({ by: "text", value: "Save", root: undefined });
  });

  it("caps at 20 with a truncated flag; empty is not an error", () => {
    const m = (i: number) => ({ ref: `e${i}`, role: "link", name: `L${i}` });
    const r = capMatches([Array.from({ length: 15 }, (_, i) => m(i)), Array.from({ length: 10 }, (_, i) => m(100 + i))]);
    expect(r.matches).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(r.matches[15].ref).toBe("e100");
    expect(capMatches([[]])).toEqual({ matches: [], truncated: false });
  });
});
