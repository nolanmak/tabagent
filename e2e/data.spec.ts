// #9 forms, #10 extraction, #11 files, #13 sensitive gates — through a real MCP client.
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test, expect, Harness } from "./fixture";
import { isWrapped, payload } from "./payload";

test.describe.configure({ mode: "default" });

/** Sensitive gates pass without prompting (pre-#13 setting name and the D17 dev flag). */
const passGates = (h: Harness) => h.trustFixtures({ devAllowSensitive: true, sensitiveAllowed: { [h.A]: true, [h.B]: true } });

test("form.describe returns a ref for every field, masked sensitive values", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/signup.html` });
  const d = payload(await h.ok(c, "form.describe"));
  expect(d.forms).toHaveLength(1);
  expect(d.forms[0].label).toBe("Step 1");
  for (const f of d.fields) expect(f.ref).toMatch(/^e\d+$/);
  const by = (l: string) => d.fields.find((f: any) => f.label === l);
  expect(by("Full name")).toMatchObject({ type: "text", required: true, value: "" });
  expect(by("Country").options).toEqual(["Choose…", "United States", "Canada", "Mexico"]);
  expect(by("Business")).toMatchObject({ type: "radio", group: "Account type" });
  expect(by("Company name").hidden).toBe(true);
  expect(by("Accept terms")).toMatchObject({ type: "checkbox", checked: false });

  await h.ok(c, "nav.goto", { url: `${h.A}/login-search.html` });
  const several = await h.call(c, "form.describe");
  expect(several.isError).toBe(true);
  expect(several.text).toContain("BAD_REQUEST");
  expect(several.text).toMatch(/2 forms: e\d+/);
  const snap = (await h.ok(c, "page.snapshot")).text;
  await h.ok(c, "act.fill", { ref: Harness.ref(snap, /textbox "Password"/), value: "hunter2" });
  const login = payload(await h.ok(c, "form.describe", { ref: Harness.ref(snap, /textbox "Username"/) }));
  expect(login.fields.find((f: any) => f.label === "Password").value).toBe("••••");
  expect(JSON.stringify(login)).not.toContain("hunter2");
  expect(login.forms[0].sensitive).toEqual(["password field"]);
});

test("multi-step signup: each step in <= 3 calls (describe, fill, submit)", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/signup.html` });
  let calls = 0;
  const step = async (tool: string, args: Record<string, unknown> = {}) => {
    calls++;
    return h.ok(c, tool, args);
  };

  // step 1: text, select, radio that reveals a field, checkbox
  await step("form.describe");
  const f1 = payload(await step("form.fill", { fields: { "Full name": "Ada Lovelace", Country: "Canada", "Account type": "Business", "Company name": "Analytical Engines", "Accept terms": true } }));
  expect(f1.failed).toEqual([]);
  expect(f1.filled.map((x: any) => x.key)).toEqual(["Full name", "Country", "Account type", "Company name", "Accept terms"]);
  await step("form.submit");
  expect(calls).toBeLessThanOrEqual(3);

  // step 2: date, contenteditable, async combobox
  calls = 0;
  const d2 = payload(await step("form.describe"));
  expect(d2.fields.map((f: any) => [f.label, f.type])).toEqual([
    ["Start date", "date"],
    ["About you", "contenteditable"],
    ["City", "combobox"],
  ]);
  const f2 = payload(await step("form.fill", { fields: { "Start date": "2026-03-01T09:00:00Z", "About you": "Writes programs for engines", City: "Paris" } }));
  expect(f2.failed).toEqual([]);
  await step("form.submit");
  expect(calls).toBeLessThanOrEqual(3);

  const out = payload(await h.ok(c, "page.text"));
  const result = JSON.parse(out.text.match(/\{.*\}/)[0]);
  expect(result).toEqual({ fullname: "Ada Lovelace", country: "ca", kind: "business", company: "Analytical Engines", terms: true, start: "2026-03-01", about: "Writes programs for engines", city: "Paris" });
});

test("form.fill partial failure: unknown label, bad value, duplicate labels", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/duplicate-labels.html` });
  const r = payload(await h.ok(c, "form.fill", { fields: { Email: "a@b.c", Name: "Neo", "Favourite colour": "red" } }));
  expect(r.filled.map((x: any) => x.key)).toEqual(["Name"]);
  const dup = r.failed.find((x: any) => x.key === "Email");
  expect(dup.code).toBe("BAD_REQUEST");
  const refs = dup.message.match(/e\d+/g);
  expect(refs).toHaveLength(2);
  expect(r.failed.find((x: any) => x.key === "Favourite colour").code).toBe("NOT_FOUND");
  // refs from the error fill each one
  const ok = payload(await h.ok(c, "form.fill", { fields: { [refs[0]]: "bill@x.io", [refs[1]]: "ship@x.io" } }));
  expect(ok.failed).toEqual([]);
  const d = payload(await h.ok(c, "form.describe"));
  expect(d.fields.filter((f: any) => f.label === "Email").map((f: any) => f.value)).toEqual(["bill@x.io", "ship@x.io"]);

  await h.ok(c, "nav.goto", { url: `${h.A}/signup.html` });
  const bad = payload(await h.ok(c, "form.fill", { fields: { Country: "Atlantis", "Accept terms": "maybe" } }));
  expect(bad.failed.map((x: any) => [x.key, x.code])).toEqual([
    ["Country", "NOT_FOUND"],
    ["Accept terms", "BAD_REQUEST"],
  ]);
});

test("legacy form fixture fills by accessible name", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  const r = payload(
    await h.ok(c, "form.fill", {
      fields: { "Email address": "neo@matrix.io", "Full name": "Thomas Anderson", Country: "Canada", Plan: "Pro", "Subscribe to newsletter": true, Bio: "Knows kung fu", "Start date": "2026-01-15", Controlled: "Neo" },
    }),
  );
  expect(r.failed).toEqual([]);
  expect(r.filled).toHaveLength(8);
  await h.ok(c, "form.submit");
  const txt = payload(await h.ok(c, "page.text")).text;
  for (const s of ['"email":"neo@matrix.io"', '"country":"ca"', '"plan":"pro"', '"subscribe":true', '"start":"2026-01-15"', '"nickname":"Neo"']) expect(txt).toContain(s);
});

test("sensitive submits prompt by every path; denying leaves the page unchanged", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/login-search.html` });
  const snap = (await h.ok(c, "page.snapshot")).text;
  const user = Harness.ref(snap, /textbox "Username"/);
  const pass = Harness.ref(snap, /textbox "Password"/);
  await h.ok(c, "form.fill", { fields: { [user]: "neo", [pass]: "hunter2" } });
  const status = async () => payload(await h.ok(c, "page.text")).text;

  // form.submit
  const sub = await h.answerPrompt("deny", () => h.call(c, "form.submit", { ref: user }));
  expect((sub.result as any).text).toContain("PERMISSION_DENIED");
  expect(`${sub.title} ${sub.reasons}`).toContain("Sign in");
  expect(sub.reasons).toContain("password field");
  expect(sub.reasons).toContain("Username: neo");
  expect(sub.reasons).not.toContain("hunter2");
  expect(await status()).toContain("IDLE");
  // Enter inside the form
  const ent = await h.answerPrompt("deny", () => h.call(c, "act.press", { key: "Enter", ref: pass }));
  expect((ent.result as any).text).toContain("PERMISSION_DENIED");
  expect(await status()).toContain("IDLE");
  // click on its submit control
  const clk = await h.answerPrompt("deny", () => h.call(c, "act.click", { ref: Harness.ref(snap, /button "Sign in"/) }));
  expect((clk.result as any).text).toContain("PERMISSION_DENIED");
  expect(await status()).toContain("IDLE");
  // a search form's Enter is not gated
  await h.ok(c, "act.type", { ref: Harness.ref(snap, /searchbox "Search"/), text: "tabs", submit: true });
  expect(await status()).toContain("SEARCHED");
  // allowing once submits
  const allow = await h.answerPrompt("once", () => h.ok(c, "form.submit", { ref: user }));
  expect(allow.result).toBeTruthy();
  expect(await status()).toContain("SUBMITTED neo");

  // card form and a Delete account button
  await h.ok(c, "nav.goto", { url: `${h.A}/checkout.html` });
  const s2 = (await h.ok(c, "page.snapshot")).text;
  await h.ok(c, "form.fill", { fields: { "Card number": "4242 4242 4242 4242", "Name on card": "Neo" } });
  const card = await h.answerPrompt("deny", () => h.call(c, "form.submit"));
  expect((card.result as any).text).toContain("PERMISSION_DENIED");
  expect(card.reasons).toContain("payment card field");
  expect(card.reasons).not.toContain("4242");
  const del = await h.answerPrompt("deny", () => h.call(c, "act.click", { ref: Harness.ref(s2, /button "Delete account"/) }));
  expect((del.result as any).text).toContain("PERMISSION_DENIED");
  expect(await status()).toContain("UNPAID");
});

test("page.markdown and page.text: main content only", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/news.html` });
  const r = await h.ok(c, "page.markdown");
  expect(isWrapped(r.text, "# Field notes: tabs that think")).toBe(true);
  const md = payload(r);
  expect(md.markdown).toContain("## Why refs matter");
  expect(md.markdown).toContain(`[design notes](${h.A}/docs/design)`);
  expect(md.markdown).toContain("| snapshot | 1200 |");
  for (const bad of ["World", "Buy cheap widgets", "Sponsored", "Privacy", "Other story", "Hidden paragraph"]) expect(md.markdown).not.toContain(bad);
  const t = payload(await h.ok(c, "page.text"));
  expect(t.text).toContain("Browser agents read pages through an accessibility tree, not pixels.");
  expect(t.text).not.toContain("Privacy");
});

test("extract.table json/csv and extract.links", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const t = payload(await h.ok(c, "extract.table"));
  expect(t.headers).toEqual(["Name", "Price", "Stock"]);
  expect(t.rows[0]).toEqual({ Name: "Apple", Price: "$1.50", Stock: "no" });
  expect(t.totalTables).toBe(2);
  const csv = payload(await h.ok(c, "extract.table", { format: "csv" }));
  expect(csv.csv).toContain("Name,Price,Stock\nApple,$1.50,no");
  expect(JSON.stringify(payload(await h.ok(c, "extract.table", { index: 1 })))).toContain("tiny");
  const links = payload(await h.ok(c, "extract.links", { filter: "/p/" }));
  expect(links.links.map((l: any) => l.href)).toEqual([`${h.A}/p/apple`, `${h.A}/p/banana`, `${h.A}/p/cherry`]);
});

test("extract.schema: JSON-LD product page, repeated cards, selectors round-trip", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/product.html` });
  const p = payload(await h.ok(c, "extract.schema", { schema: { type: "object", properties: { name: { type: "string" }, price: { type: "number" }, sku: { type: "string" } } } }));
  expect(p.data).toEqual([{ name: "Acme Rocket Skates", price: 199.99, sku: "RS-42" }]);

  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  const schema = { type: "array", items: { type: "object", properties: { title: { type: "string" }, price: { type: "number" }, link: { type: "string", format: "uri" } } } };
  const r = payload(await h.ok(c, "extract.schema", { schema }));
  expect(r.data).toHaveLength(3);
  expect(r.data[0]).toEqual({ title: "Apple", price: 1.5, link: `${h.A}/p/apple` });
  expect(r.selectors.item).toContain("product-card");
  const again = payload(await h.ok(c, "extract.schema", { schema, selectors: r.selectors }));
  expect(again.data).toEqual(r.data);
  const none = payload(await h.ok(c, "extract.schema", { schema: { type: "array", items: { properties: { isbn: { type: "string" } } } } }));
  expect(none.data).toEqual([]);
});

test("extract.paginate over a 4-page listing stops on the disabled next control", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/listing.html` });
  const r = payload(await h.ok(c, "extract.paginate", { extractor: "table", maxPages: 5 }));
  expect(r.pages).toBe(4);
  expect(r.count).toBe(12);
  expect(r.rows.map((x: any) => x.Name)).toEqual(Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`));
  expect(r.stopped).toBe("next control is disabled");
  const capped = payload(await h.ok(c, "extract.paginate", { extractor: "links", maxPages: 1 }));
  expect(capped.pages).toBe(1);
  expect(capped.stopped).toBe("maxPages reached");
  // the tab is left on the last page
  await h.ok(c, "nav.goto", { url: `${h.A}/listing.html?page=3` });
  const two = payload(await h.ok(c, "extract.paginate", { extractor: "schema", schema: { type: "array", items: { properties: { title: { type: "string" }, price: { type: "number" } } } }, next: "#next" }));
  expect(two.data.map((x: any) => x.title)).toEqual(["Item 7", "Item 8", "Item 9", "Item 10", "Item 11", "Item 12"]);
  expect(payload(await h.ok(c, "page.text")).text).toContain("page 4 of 4");
});

test("extract.paginate: a hop to a denied origin stops with the pages so far", async ({ h }) => {
  await h.setPolicies({ [h.A]: "full", [h.B]: "deny" }, { devAllowSensitive: true, paused: false });
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/table.html` });
  // point the page's Next link at the denied origin
  await h.ok(c, "nav.wait", { for: "fn", value: `(document.getElementById("next").setAttribute("href", ${JSON.stringify(h.B)} + "/table.html?page=2"), true)`, timeout: 5000 });
  const r = payload(await h.ok(c, "extract.paginate", { extractor: "table" }));
  expect(r.pages).toBe(1);
  expect(r.error.code).toBe("PERMISSION_DENIED");
  expect(r.rows).toHaveLength(3);
});

test("act.upload: file input, a button that opens a chooser, refusals", async ({ h }) => {
  await passGates(h);
  const c = await h.mcp();
  const file = join(h.home, "uploads", "hello.txt");
  writeFileSync(file, "hello world");
  await h.ok(c, "nav.goto", { url: `${h.A}/upload.html` });
  const s = (await h.ok(c, "page.snapshot")).text;
  const fileRef = Harness.ref(s, /button "Attachment"/);
  await h.ok(c, "act.upload", { ref: fileRef, paths: [file] });
  expect(payload(await h.ok(c, "page.text")).text).toContain("hello.txt:11");
  await h.ok(c, "act.upload", { ref: Harness.ref(s, /button "Choose avatar"/), paths: [file] });
  expect(payload(await h.ok(c, "page.text")).text).toContain("avatar hello.txt:11");

  const outside = join(h.home, "secret.txt");
  writeFileSync(outside, "nope");
  expect((await h.call(c, "act.upload", { ref: fileRef, paths: [outside] })).text).toContain("PERMISSION_DENIED");
  const link = join(h.home, "uploads", "link.txt");
  symlinkSync(outside, link);
  expect((await h.call(c, "act.upload", { ref: fileRef, paths: [link] })).text).toContain("PERMISSION_DENIED");
  expect((await h.call(c, "act.upload", { ref: fileRef, paths: [join(h.home, "uploads", "missing.txt")] })).text).toContain("NOT_FOUND");
  const notFile = await h.call(c, "act.upload", { ref: Harness.ref(s, /button "Plain button"/), paths: [file] });
  expect(notFile.text).toContain("NOT_ACTIONABLE");
});

test("downloads: click reports it, wait/list/read text and binary, other ids refused", async ({ h }) => {
  await passGates(h);
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/downloads.html` });
  const s = (await h.ok(c, "page.snapshot")).text;
  const clk = payload(await h.ok(c, "act.click", { ref: Harness.ref(s, /link "Download notes"/) }));
  const reported = clk.downloads ?? [];
  const dl = payload(await h.ok(c, "downloads.wait", { timeout: 15000 }));
  expect(dl.state).toBe("complete");
  expect(dl.url).toBe(`${h.A}/files/notes.txt`);
  if (reported.length) expect(reported[0].id).toBe(dl.id);
  const txt = payload(await h.ok(c, "downloads.read", { id: dl.id }));
  expect(txt.text ?? txt.content).toContain("hello from a text file");

  await h.ok(c, "act.click", { ref: Harness.ref(s, /link "Download binary"/) });
  const bin = payload(await h.ok(c, "downloads.wait", { timeout: 15000 }));
  const b = payload(await h.ok(c, "downloads.read", { id: bin.id }));
  expect(b.encoding).toBe("base64");
  expect(Buffer.from(b.data ?? b.content, "base64").length).toBe(4096);

  const list = payload(await h.ok(c, "downloads.list"));
  expect(list.downloads.map((d: any) => d.id).sort()).toEqual([dl.id, bin.id].sort());

  // another session sees none of them and cannot read them
  const other = await h.mcp({ label: "other-agent" });
  expect(payload(await h.ok(other, "downloads.list")).downloads).toEqual([]);
  expect((await h.call(other, "downloads.read", { id: dl.id })).text).toContain("NOT_FOUND");
  // a download the user starts is not the session's
  const userPage = await h.ctx.newPage();
  await userPage.goto(`${h.A}/downloads.html`);
  const [ud] = await Promise.all([userPage.waitForEvent("download"), userPage.click("#csv")]);
  await ud.path();
  await userPage.close();
  expect(payload(await h.ok(c, "downloads.list")).downloads).toHaveLength(2);
});

test("downloads.read asks the user", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/downloads.html` });
  const s = (await h.ok(c, "page.snapshot")).text;
  await h.ok(c, "act.click", { ref: Harness.ref(s, /link "Download CSV"/) });
  const dl = payload(await h.ok(c, "downloads.wait", { timeout: 15000 }));
  const read = await h.answerPrompt("once", () => h.ok(c, "downloads.read", { id: dl.id }));
  expect(`${read.title} ${read.reasons}`).toContain("downloaded file");
  expect(JSON.stringify(payload(read.result as any))).toContain("widget,3");
});
