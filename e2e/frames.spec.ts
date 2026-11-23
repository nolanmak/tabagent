// #19 iframes + shadow DOM across snapshot and actions.
import { test, expect } from "./fixture";
import { refIn, view } from "./view";

test.describe.configure({ mode: "serial" });

const settle = () => new Promise((r) => setTimeout(r, 400));

test("same-origin and cross-origin iframes: snapshot includes their controls; click and type work in each", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/frames.html?cross=${encodeURIComponent(h.B)}` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await settle();
  const s = view(await h.ok(c, "page.snapshot")).snap;
  expect(s).toContain('iframe "Same origin frame"');
  expect(s).toContain('iframe "Cross origin frame"');
  const inputs = s.split("\n").filter((l) => /textbox "Frame input"/.test(l)).map((l) => l.match(/ref=(e\d+)/)![1]);
  expect(inputs).toHaveLength(2);

  for (const [which, input] of [["same", inputs[0]], ["cross", inputs[1]]] as const) {
    const r = view(await h.ok(c, "act.click", { ref: refIn(s, new RegExp(`button "Frame button ${which}"`)) }));
    expect(r.json.snapshotDiff).toContain(`pressed in ${which}`);
    const t = view(await h.ok(c, "act.type", { ref: input, text: `typed ${which}` }));
    expect(t.json.snapshotDiff).toContain(`value="typed ${which}"`);
  }
  // page.find searches same- and cross-origin frames
  const f = view(await h.ok(c, "page.find", { by: "css", value: "#fi" })).json;
  expect(f.matches.map((m: any) => m.ref).sort()).toEqual([...inputs].sort());
});

test("nested, scrolled cross-origin frames: coordinates are translated to the top-level viewport", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/nested.html?cross=${encodeURIComponent(h.B)}` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await settle();
  // scroll the top page so the outer frame is partly off-screen
  await h.ok(c, "act.scroll", { dy: 200 });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  expect(s).toMatch(/iframe "Outer frame"[\s\S]*iframe "Inner frame"[\s\S]*button "Frame button inner"/);
  const r = view(await h.ok(c, "act.click", { ref: refIn(s, /button "Frame button inner"/) }));
  expect(r.json.snapshotDiff).toContain("pressed in inner");
  await h.ok(c, "act.type", { ref: refIn(s, /textbox "Frame input"/), text: "deep inside" });
  expect(view(await h.ok(c, "page.snapshot")).snap).toContain('value="deep inside"');
});

test("a frame that navigates makes its refs REF_STALE; the parent's refs stay valid", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/frames.html?cross=${encodeURIComponent(h.B)}` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await settle();
  const s = view(await h.ok(c, "page.snapshot")).snap;
  const inner = refIn(s, /button "Frame button same"/);
  const reload = refIn(s, /button "Reload same frame"/);
  await h.ok(c, "act.click", { ref: reload });
  await settle();
  const stale = await h.call(c, "act.click", { ref: inner });
  expect(stale.text).toContain("REF_STALE");
  // the parent's button still works
  await h.ok(c, "act.click", { ref: reload });
  // and a fresh snapshot gives the reloaded frame new refs
  const s2 = view(await h.ok(c, "page.snapshot")).snap;
  expect(refIn(s2, /button "Frame button same"/)).not.toBe(inner);
});

test("a denied-origin frame is a one-line placeholder with no refs", async ({ h }) => {
  await h.setPolicies({ [h.A]: "full", [h.B]: "deny" }, { devAllowSensitive: true });
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/frames.html?cross=${encodeURIComponent(h.B)}` });
  await h.ok(c, "nav.wait", { for: "networkidle" });
  await settle();
  const s = view(await h.ok(c, "page.snapshot")).snap;
  expect(s).toMatch(/- iframe "Cross origin frame" \(content hidden: http:\/\/127\.0\.0\.1:\d+ is denied by site policy\)/);
  expect(s).not.toContain("Frame button cross");
  expect(s).toContain("Frame button same");
  // page.find does not reach into the denied frame either
  const f = view(await h.ok(c, "page.find", { by: "css", value: "#fb" })).json;
  expect(f.matches).toHaveLength(1);
  await h.trustFixtures();
});

test("open shadow DOM: snapshot pierces it; fill and click work inside", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/shadow.html` });
  const s = view(await h.ok(c, "page.snapshot")).snap;
  await h.ok(c, "act.fill", { ref: refIn(s, /textbox "Shadow input"/), value: "deep" });
  await h.ok(c, "act.click", { ref: refIn(s, /button "Shadow button"/) });
  expect(view(await h.ok(c, "page.text", {})).all).toContain("shadow:deep");
  const f = view(await h.ok(c, "page.find", { by: "css", value: "#sb" })).json;
  expect(f.matches[0].name).toBe("Shadow button");
  expect(f.matches[0].ref).toBe(refIn(s, /button "Shadow button"/));
});
