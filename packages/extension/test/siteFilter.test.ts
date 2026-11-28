import { describe, expect, it } from "vitest";
import { filterSites, siteHost } from "../src/pure/siteFilter";

const SITES: Record<string, { policy?: string }> = {
  "https://www.zeta.example": { policy: "read" },
  "https://app.mercury.com": { policy: "act" },
  "http://127.0.0.1:8080": {},
  "https://accounts.google.com": { policy: "full" },
  "https://mercury.com": { policy: "deny" },
};
const origins = (q: string) => filterSites(SITES, q).rows.map(([o]) => o);

describe("site list filter (#117)", () => {
  it("empty or blank query keeps every row, sorted by host", () => {
    for (const q of ["", "   "]) {
      const r = filterSites(SITES, q);
      expect(r.total).toBe(5);
      expect(r.rows.map(([o]) => o)).toEqual(["http://127.0.0.1:8080", "https://accounts.google.com", "https://app.mercury.com", "https://mercury.com", "https://www.zeta.example"]);
    }
  });

  it("keeps the entry value alongside its origin", () => {
    expect(filterSites(SITES, "zeta").rows).toEqual([["https://www.zeta.example", { policy: "read" }]]);
  });

  it("matches a substring of the bare host", () => {
    expect(origins("mercury")).toEqual(["https://app.mercury.com", "https://mercury.com"]);
    expect(origins("google.com")).toEqual(["https://accounts.google.com"]);
  });

  it("matches a substring of the full origin, including scheme and port", () => {
    expect(origins("http://")).toEqual(["http://127.0.0.1:8080"]);
    expect(origins(":8080")).toEqual(["http://127.0.0.1:8080"]);
    expect(origins("https://app.")).toEqual(["https://app.mercury.com"]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(origins("  MERCURY.Com ")).toEqual(["https://app.mercury.com", "https://mercury.com"]);
  });

  it("returns no rows but the full total when nothing matches", () => {
    expect(filterSites(SITES, "nope")).toEqual({ rows: [], total: 5 });
  });

  it("handles an empty site map", () => {
    expect(filterSites({}, "x")).toEqual({ rows: [], total: 0 });
  });

  it("sorts same-host origins by full origin and tolerates unparseable keys", () => {
    const r = filterSites({ "https://a.test:9": {}, "not a url": {}, "http://a.test": {}, "https://a.test": {} }, "");
    expect(r.rows.map(([o]) => o)).toEqual(["http://a.test", "https://a.test", "https://a.test:9", "not a url"]);
  });

  it("siteHost returns the hostname, or the lowercased key when it is not a URL", () => {
    expect(siteHost("https://App.Mercury.com:443")).toBe("app.mercury.com");
    expect(siteHost("Not A URL")).toBe("not a url");
  });
});
