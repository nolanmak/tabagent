// #61 Part B: the phone page markup.
import { describe, expect, it } from "vitest";
import { endedPage, handoffPage } from "../src/handoff/page";

const entry = { id: "a".repeat(32), sessionLabel: "jar<vis>", origin: "https://id.example", reason: `Selfie <img src=x onerror="alert(1)"> & go` } as any;

describe("handoff page", () => {
  it("escapes agent-supplied text (reason, label)", () => {
    const html = handoffPage(entry, "N0NCE");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Selfie &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; go");
    expect(html).toContain("jar&lt;vis&gt;");
    expect(html).toContain("id.example");
  });

  it("has one nonce'd script that parses, no inline handlers, no address bar or eval", () => {
    const html = handoffPage(entry, "N0NCE");
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script nonce="N0NCE">']);
    expect(html).not.toMatch(/<[^>]*\son\w+=/);
    const js = html.split('<script nonce="N0NCE">')[1].split("</script>")[0];
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toMatch(/\beval\(|new Function|location\.(href|assign)\s*=/);
    // only the four handoff endpoints are fetched
    const fetched = [...js.matchAll(/fetch\(base \+ "([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(fetched)]).toEqual(["/claim", "/end", "/frame", "/input"]);
    expect(html).toContain('name="viewport"');
  });

  it("the ended page is static", () => {
    const html = endedPage("N");
    expect(html).not.toContain("<script");
    expect(html).toMatch(/not valid/);
  });
});
