import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, Harness } from "./fixture";

test.describe.configure({ mode: "serial" });

test("form.describe + form.fill in one call + form.submit", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const d = await h.ok(c, "form.describe");
  const fields = JSON.parse(d.text.split("<untrusted-page-content>\n")[1].split("\n</untrusted-page-content>")[0]).fields;
  const labels = fields.map((f: any) => f.label);
  expect(labels).toEqual(expect.arrayContaining(["Email address", "Full name", "Country", "Free", "Pro", "Subscribe to newsletter", "Bio", "Start date"]));
  expect(fields.find((f: any) => f.label === "Email address").required).toBe(true);
  expect(fields.find((f: any) => f.label === "Country").options).toContain("Canada");

  const r = await h.ok(c, "form.fill", {
    fields: {
      "Email address": "neo@matrix.io",
      "Full name": "Thomas Anderson",
      Country: "Canada",
      Plan: "Pro",
      "Subscribe to newsletter": true,
      Bio: "Knows kung fu",
      "Start date": "2026-01-15",
      Nickname: "Neo",
    },
  });
  expect(r.json.failed).toBe(0);
  expect(r.json.filled).toBe(8);
  const bad = await h.ok(c, "form.fill", { fields: { "Favourite colour": "red" } });
  expect(bad.json.failed).toBe(1);
  expect(bad.json.fields[0].error).toContain("No field matching");

  const sub = await h.ok(c, "form.submit", {});
  void sub;
  const out = await h.ok(c, "page.find", { css: "#result" });
  const txt = (await h.ok(c, "page.text", {})).text;
  expect(txt).toContain('"email":"neo@matrix.io"');
  expect(txt).toContain('"fullname":"Thomas Anderson"');
  expect(txt).toContain('"country":"ca"');
  expect(txt).toContain('"plan":"pro"');
  expect(txt).toContain('"subscribe":true');
  expect(txt).toContain('"start":"2026-01-15"');
  expect(txt).toContain('"nickname":"Neo"');
  void out;
});

test("extract.table json/csv, extract.links", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const t = await h.ok(c, "extract.table");
  const body = JSON.parse(t.text.split("<untrusted-page-content>\n")[1].split("\n</untrusted-page-content>")[0]);
  expect(body.headers).toEqual(["Name", "Price", "Stock"]);
  expect(body.rows[0]).toEqual({ Name: "Apple", Price: "$1.50", Stock: "no" });
  expect(body.totalTables).toBe(2);
  const csv = await h.ok(c, "extract.table", { format: "csv" });
  expect(csv.text).toContain("Name,Price,Stock\nApple,$1.50,no");
  const second = await h.ok(c, "extract.table", { index: 1 });
  expect(second.text).toContain("tiny");
  const links = await h.ok(c, "extract.links", { filter: "/p/" });
  expect(links.text).toContain('"count":3');
});

test("extract.schema auto-detects repeated items", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const r = await h.ok(c, "extract.schema", {
    schema: { type: "array", items: { type: "object", properties: { title: { type: "string" }, price: { type: "number" }, link: { type: "string", format: "uri" } } } },
  });
  const body = JSON.parse(r.text.split("<untrusted-page-content>\n")[1].split("\n</untrusted-page-content>")[0]);
  expect(body.count).toBe(3);
  expect(body.data[0]).toEqual({ title: "Apple", price: 1.5, link: `${h.A}/p/apple` });
  expect(body.selectors.item).toContain("product-card");
  const single = await h.ok(c, "extract.schema", { schema: { type: "object", properties: { title: { type: "string" } } }, hint: ".product-card" });
  expect(single.text).toContain("Apple");
});

test("extract.paginate follows Next and dedupes", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const r = await h.ok(c, "extract.paginate", { extractor: "table", maxPages: 5 });
  const body = JSON.parse(r.text.split("<untrusted-page-content>\n")[1].split("\n</untrusted-page-content>")[0]);
  expect(body.count).toBe(9);
  expect(body.pages).toBe(3);
  expect(body.stopped).toBe("no next link");
  expect(body.rows.map((x: any) => x.Name)).toEqual(["Apple", "Banana", "Cherry", "Date", "Elder", "Fig", "Grape", "Honeydew", "Kiwi"]);
});

test("uploads (allowed dir only) and downloads (wait + read)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  const file = join(h.home, "uploads", "hello.txt");
  writeFileSync(file, "hello world");
  await h.ok(c, "nav.goto", { url: `${h.A}/upload.html` });
  const s = await h.ok(c, "page.snapshot");
  const finds = await h.ok(c, "page.find", { css: "input[type=file]" });
  const fileRef = finds.text.match(/"ref":"(e\d+)"/)![1];
  await h.ok(c, "act.upload", { ref: fileRef, paths: [file] });
  expect((await h.ok(c, "page.text", {})).text).toContain("hello.txt:11");
  const outside = join(h.home, "secret.txt");
  writeFileSync(outside, "nope");
  const denied = await h.call(c, "act.upload", { ref: fileRef, paths: [outside] });
  expect(denied.text).toContain("PERMISSION_DENIED");
  const notFile = await h.call(c, "act.upload", { ref: Harness.ref(s.text, /link "Download CSV"/), paths: [file] });
  expect(notFile.text).toContain("not a file input");

  const clk = await h.ok(c, "act.click", { ref: Harness.ref(s.text, /link "Download CSV"/) });
  void clk;
  const dl = await h.ok(c, "downloads.wait", { timeout: 15000 });
  expect(dl.json.state).toBe("complete");
  const list = await h.ok(c, "downloads.list");
  expect(list.text).toContain("data.csv");
  const read = await h.answerPrompt("once", () => h.ok(c, "downloads.read", { id: dl.json.id }));
  expect(read.title).toContain("read downloaded file");
  expect((read.result as any).text).toContain("widget,3");
});
