import { describe, expect, it, vi } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import { paginate, type PageOps } from "../src/pure/paginate";

/** A fake site: pages[i] = rows on page i; next on page i goes to page i+1 unless overridden. */
function site(pages: string[][], o: { disabledOn?: number; noNextOn?: number; sameUrlOn?: number; failOn?: number; denyUrl?: string } = {}) {
  let cur = 0;
  const authorize = vi.fn(async (url: string, _level: "read" | "act") => {
    if (o.denyUrl && url.includes(o.denyUrl)) throw new TabAgentError("PERMISSION_DENIED", `denied ${url}`);
  });
  const ops: PageOps = {
    url: async () => (o.sameUrlOn != null && cur > o.sameUrlOn ? `http://a.test/p${o.sameUrlOn}` : `http://a.test/p${cur}`),
    extract: async () => {
      if (o.failOn === cur) throw new TabAgentError("TIMEOUT", "page did not load");
      return pages[cur] ?? [];
    },
    findNext: async () => {
      if (cur === pages.length - 1 || o.noNextOn === cur) return null;
      return { ref: `e${cur}`, disabled: o.disabledOn === cur, href: `http://a.test/p${cur + 1}` };
    },
    click: async () => {
      cur++;
    },
    authorize,
  };
  return { ops, authorize };
}

const four = [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]];

describe("extract.paginate (D33)", () => {
  it("collects every page and stops when there is no next control", async () => {
    const { ops } = site(four);
    const r = await paginate(ops, { maxPages: 10 });
    expect(r.rows).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(r.pages).toBe(4);
    expect(r.stopped).toBe("no next control");
    expect(r.urls).toEqual(["http://a.test/p0", "http://a.test/p1", "http://a.test/p2", "http://a.test/p3"]);
  });
  it("stops at maxPages (default 5)", async () => {
    const { ops } = site(four);
    const r = await paginate(ops, { maxPages: 2 });
    expect(r.rows).toEqual(["a", "b", "c", "d"]);
    expect(r.stopped).toBe("maxPages reached");
    const many = site(Array.from({ length: 9 }, (_, i) => [String(i)]));
    expect((await paginate(many.ops, {})).pages).toBe(5);
  });
  it("stops on missing next", async () => {
    const { ops } = site(four, { noNextOn: 1 });
    const r = await paginate(ops, {});
    expect(r.pages).toBe(2);
    expect(r.stopped).toBe("no next control");
  });
  it("stops on a disabled next", async () => {
    const { ops } = site(four, { disabledOn: 2 });
    const r = await paginate(ops, {});
    expect(r.pages).toBe(3);
    expect(r.stopped).toBe("next control is disabled");
  });
  it("stops on an unchanged URL", async () => {
    const { ops } = site(four, { sameUrlOn: 1 });
    const r = await paginate(ops, {});
    expect(r.stopped).toBe("URL did not change");
    expect(r.pages).toBe(2);
  });
  it("stops on an all-duplicate page", async () => {
    const { ops } = site([["a", "b"], ["c"], ["a", "c"], ["z"]]);
    const r = await paginate(ops, {});
    expect(r.rows).toEqual(["a", "b", "c"]);
    expect(r.stopped).toBe("page had only duplicate rows");
    expect(r.pages).toBe(3);
  });
  it("dedupes object rows", async () => {
    const { ops } = site([[{ n: 1 }, { n: 2 }], [{ n: 2 }, { n: 3 }]]);
    expect((await paginate(ops, {})).rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
  it("a failure on page 3 returns pages 1-2 plus the error", async () => {
    const { ops } = site(four, { failOn: 2 });
    const r = await paginate(ops, {});
    expect(r.rows).toEqual(["a", "b", "c", "d"]);
    expect(r.pages).toBe(2);
    expect(r.error).toEqual({ code: "TIMEOUT", message: "page did not load" });
    expect(r.stopped).toBe("error");
  });
  it("each hop calls authorize (act for the click, read for the target)", async () => {
    const { ops, authorize } = site(four);
    await paginate(ops, { maxPages: 3 });
    expect(authorize.mock.calls).toEqual([
      ["http://a.test/p1", "read"],
      ["http://a.test/p0", "act"],
      ["http://a.test/p1", "read"],
      ["http://a.test/p2", "read"],
      ["http://a.test/p1", "act"],
      ["http://a.test/p2", "read"],
    ]);
  });
  it("a hop to a denied origin stops with PERMISSION_DENIED and keeps earlier pages", async () => {
    const { ops } = site(four, { denyUrl: "p2" });
    const clicked = vi.spyOn(ops, "click");
    const r = await paginate(ops, {});
    expect(r.pages).toBe(2);
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
