// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extractLinks, extractSchema, extractTable, markdown, nextControl, storage, text } from "../src/pagelib/extract";
import { csvCell, toCsv } from "../src/pure/csv";

const FIX = join(__dirname, "../../../e2e/fixtures");
const GOLD = join(__dirname, "golden");

function load(html: string, url = "http://shop.test/dir/page.html") {
  // happy-dom: set the URL first so relative links resolve against it.
  (window as any).happyDOM?.setURL?.(url);
  document.open();
  document.write(html.replace(/<script(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, ""));
  document.close();
}
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("page.markdown / page.text", () => {
  beforeEach(() => load(fixture("news.html"), "http://news.test/2026/field-notes"));
  it("article fixture -> golden markdown, without nav/ads/footer/aside", () => {
    const r = markdown(null);
    expect(r.markdown).toBe(readFileSync(join(GOLD, "news.md"), "utf8").trimEnd());
    expect(r.title).toBe("Field notes: tabs that think");
    for (const bad of ["World", "Tech", "Buy cheap widgets", "Sponsored", "Privacy", "Other story", "Daily Fixture", "Hidden paragraph", "Also hidden"]) expect(r.markdown).not.toContain(bad);
  });
  it("links in markdown are absolute", () => {
    expect(markdown(null).markdown).toContain("[design notes](http://news.test/docs/design)");
  });
  it("maxChars truncates and says so", () => {
    const r = markdown(null, 50);
    expect(r.markdown.length).toBe(50);
    expect(r.truncated).toBe(true);
  });
  it("page.text is the main content's text, no markup", () => {
    const r = text(null);
    expect(r.text).toContain("Field notes: tabs that think");
    expect(r.text).toContain("Browser agents read pages through an accessibility tree, not pixels.");
    expect(r.text).not.toMatch(/[#*`[\]]/);
    expect(r.text).not.toContain("Privacy");
    expect(r.text).not.toContain("Buy cheap widgets");
    expect(r.text).not.toContain("Hidden paragraph");
  });
  it("page.text of an element", () => {
    expect(text(document.querySelector("blockquote")).text).toBe("Refs are cheap; selectors are brittle.");
  });
});

describe("extract.table", () => {
  it("<table> with thead", () => {
    load(`<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>`);
    const t = extractTable(null) as any;
    expect(t.headers).toEqual(["Name", "Qty"]);
    expect(t.rows).toEqual([{ Name: "a", Qty: "1" }, { Name: "b", Qty: "2" }]);
  });
  it("table without thead: first all-th row is the header", () => {
    load(`<table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr></table>`);
    expect((extractTable(null) as any).rows).toEqual([{ K: "x", V: "1" }]);
  });
  it("table with no header row gets col1..n", () => {
    load(`<table><tr><td>x</td><td>1</td></tr><tr><td>y</td><td>2</td></tr></table>`);
    const t = extractTable(null) as any;
    expect(t.headers).toEqual(["col1", "col2"]);
    expect(t.rows).toHaveLength(2);
  });
  it("ARIA grid", () => {
    load(`<div role="grid"><div role="row"><span role="columnheader">City</span><span role="columnheader">Pop</span></div>
      <div role="row"><span role="gridcell">Oslo</span><span role="gridcell">700k</span></div>
      <div role="row"><span role="rowheader">Rome</span><span role="gridcell">2.8M</span></div></div>`);
    expect((extractTable(null) as any).rows).toEqual([{ City: "Oslo", Pop: "700k" }, { City: "Rome", Pop: "2.8M" }]);
  });
  it("colspan and rowspan", () => {
    load(`<table><thead><tr><th>Item</th><th colspan="2">Price</th></tr></thead>
      <tbody><tr><td rowspan="2">Tea</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr><tr><td colspan="3">Total</td></tr></tbody></table>`);
    const t = extractTable(null) as any;
    expect(t.headers).toEqual(["Item", "Price", "Price_2"]);
    expect(t.rows).toEqual([
      { Item: "Tea", Price: "1", Price_2: "2" },
      { Item: "Tea", Price: "3", Price_2: "4" },
      { Item: "Total", Price: "", Price_2: "" },
    ]);
  });
  it("picks the largest table unless ref/index given", () => {
    load(`<table id="s"><tr><td>tiny</td></tr></table><table id="b"><tr><th>A</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table>`);
    const t = extractTable(null) as any;
    expect(t.tableIndex).toBe(1);
    expect(t.totalTables).toBe(2);
    expect((extractTable(null, 0) as any).rows).toEqual([{ col1: "tiny" }]);
    expect((extractTable(document.getElementById("s")) as any).rows).toEqual([{ col1: "tiny" }]);
    expect(extractTable(null, 5)).toHaveProperty("error");
  });
  it("no table -> error", () => {
    load(`<p>none</p>`);
    expect(extractTable(null)).toHaveProperty("error");
  });
  it("1000-row cap sets truncated", () => {
    load(`<table><tr><th>n</th></tr>${Array.from({ length: 1005 }, (_, i) => `<tr><td>${i}</td></tr>`).join("")}</table>`);
    const t = extractTable(null) as any;
    expect(t.rows).toHaveLength(1000);
    expect(t.truncated).toBe(true);
    expect(t.totalRows).toBe(1005);
    load(`<table><tr><th>n</th></tr><tr><td>1</td></tr></table>`);
    expect((extractTable(null) as any).truncated).toBeUndefined();
  });
  it("CSV escaping", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(" pad")).toBe('" pad"');
    expect(csvCell(null)).toBe("");
    expect(toCsv(["A", "B"], [{ A: "1", B: "x,y" }, { A: "2" }])).toBe('A,B\n1,"x,y"\n2,');
  });
});

describe("extract.links", () => {
  it("relative -> absolute, duplicates removed, javascript: and hidden skipped", () => {
    load(`<a href="/a">A</a><a href="b.html">B</a><a href="http://shop.test/a">A again</a><a href="javascript:void 0">JS</a>
      <a href="https://other.test/x">X</a><div hidden><a href="/hidden">H</a></div><a href="#top">Top</a>`);
    const r = extractLinks(null);
    expect(r.links).toEqual([
      { text: "A", href: "http://shop.test/a" },
      { text: "B", href: "http://shop.test/dir/b.html" },
      { text: "X", href: "https://other.test/x" },
      { text: "Top", href: "http://shop.test/dir/page.html#top" },
    ]);
  });
  it("root limits the scope; filter and limit apply", () => {
    load(`<nav id="n"><a href="/n1">N1</a><a href="/n2">N2</a></nav><main><a href="/m">M</a></main>`);
    expect(extractLinks(document.getElementById("n")).links.map((l) => l.text)).toEqual(["N1", "N2"]);
    expect(extractLinks(null, "/m").links.map((l) => l.text)).toEqual(["M"]);
    const lim = extractLinks(null, undefined, 1);
    expect(lim.links).toHaveLength(1);
    expect(lim.truncated).toBe(true);
  });
});

describe("extract.schema (D33)", () => {
  it("JSON-LD product page", () => {
    load(fixture("product.html"));
    const r = extractSchema({});
    expect(r.source).toBe("json-ld");
    expect(r.data[0]).toMatchObject({ "@type": "Product", name: "Acme Rocket Skates", sku: "RS-42" });
    const typed = extractSchema({ schema: { type: "object", properties: { name: { type: "string" }, price: { type: "number" }, brand: { type: "string" } } } });
    expect(typed.data).toEqual([{ name: "Acme Rocket Skates", price: 199.99, brand: "Acme" }]);
    expect(typed.selectors.fields).toEqual({ name: "name", price: "offers.price", brand: "brand" });
    const again = extractSchema({ schema: { type: "object", properties: { name: { type: "string" }, price: { type: "number" }, brand: { type: "string" } } }, selectors: typed.selectors });
    expect(again.data).toEqual(typed.data);
  });
  it("microdata page", () => {
    load(fixture("microdata.html"), "http://shop.test/w");
    const schema = { type: "object", properties: { name: { type: "string" }, price: { type: "number" }, url: { type: "string" }, image: { type: "string" } } };
    const r = extractSchema({ schema });
    expect(r.source).toBe("microdata");
    expect(r.data).toEqual([{ name: "Widget Pro", price: 12.5, url: "http://shop.test/p/widget", image: "http://shop.test/img/widget.png" }]);
    const again = extractSchema({ schema, selectors: r.selectors });
    expect(again.data).toEqual(r.data);
  });
  it("repeated-card listing", () => {
    load(`<main><ul>${["One", "Two", "Three"].map((n, i) => `<li class="card"><h3 class="card-title">${n}</h3><span class="card-price">$${i + 1}.50</span><a class="card-link" href="/p/${n.toLowerCase()}">View</a></li>`).join("")}</ul>
      <ul><li>nav a</li><li>nav b</li></ul></main>`);
    const schema = { type: "array", items: { type: "object", properties: { title: { type: "string" }, price: { type: "number" }, link: { type: "string", format: "uri" } } } };
    const r = extractSchema({ schema });
    expect(r.source).toBe("repeated");
    expect(r.data).toEqual([
      { title: "One", price: 1.5, link: "http://shop.test/p/one" },
      { title: "Two", price: 2.5, link: "http://shop.test/p/two" },
      { title: "Three", price: 3.5, link: "http://shop.test/p/three" },
    ]);
    expect(r.selectors.item).toBe("li.card");
    const again = extractSchema({ schema, selectors: r.selectors });
    expect(again.data).toEqual(r.data);
    expect(again.source).toBe("selectors");
  });
  it("label/value pairs and headings", () => {
    load(`<div class="row"><h2>Alpha</h2><dl><dt>Price</dt><dd>$3</dd></dl></div><div class="row"><h2>Beta</h2><dl><dt>Price</dt><dd>$4</dd></dl></div>`);
    const r = extractSchema({ schema: { type: "array", items: { properties: { name: { type: "string" }, price: { type: "number" } } } } });
    expect(r.data).toEqual([{ name: "Alpha", price: 3 }, { name: "Beta", price: 4 }]);
  });
  it("hint gives the item selector", () => {
    load(`<div class="x"><b class="title">A</b></div><div class="x"><b class="title">B</b></div>`);
    const r = extractSchema({ schema: { type: "object", properties: { title: { type: "string" } } }, hint: ".x" });
    expect(r.data).toEqual([{ title: "A" }, { title: "B" }]);
  });
  it("no match returns empty data, not an error", () => {
    load(`<p>Nothing structured here.</p>`);
    expect(extractSchema({ schema: { type: "array", items: { properties: { price: { type: "number" } } } } })).toEqual({ data: [], selectors: { fields: {} }, source: "none" });
    expect(extractSchema({}).data).toEqual([]);
  });
});

describe("pagination next control", () => {
  it("finds rel=next, reports href and disabled state", () => {
    load(`<a href="?page=1">Previous</a><a rel="next" href="?page=3">Next</a>`, "http://shop.test/list?page=2");
    expect(nextControl(null).value).toEqual({ el: 0, disabled: false, href: "http://shop.test/list?page=3" });
    load(`<a aria-disabled="true">Next</a>`);
    expect(nextControl(null).value?.disabled).toBe(true);
    load(`<button disabled>Next page</button>`);
    expect(nextControl(null).value).toMatchObject({ disabled: true, href: null });
    load(`<a href="/x">Older</a>`);
    expect(nextControl(null).value).toBeNull();
    load(`<a class="pg" href="/x">Older</a>`);
    expect(nextControl(null, ".pg").value?.href).toBe("http://shop.test/x");
  });
});

describe("storage.get", () => {
  it("returns local and session entries for the origin", () => {
    localStorage.clear();
    localStorage.setItem("theme", "dark");
    sessionStorage.setItem("tab", "one");
    expect(storage(null, "local")).toMatchObject({ kind: "local", entries: { theme: "dark" }, count: 1 });
    expect(storage(null, "session").entries).toEqual({ tab: "one" });
  });
});
