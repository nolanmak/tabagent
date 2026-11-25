// nolanmak/tabagent#64 (OpenAI Daybreak on platform.openai.com): a Radix form whose
// radios/checkboxes are <button role=…> plus a hidden required <input>, with labels in
// nearby text and a Continue button that stays disabled until everything is answered.
import { test, expect } from "./fixture";
import { payload } from "./payload";

test.describe.configure({ mode: "default" });

const stateOf = async (h: any, c: any) => ((await h.ok(c, "page.text", {})).text.match(/State: ([^\n"]+)/) ?? [])[1];

test("form.describe reports each Radix control once with its label and the hidden input's required/name", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/radix-form.html` });
  const d = payload(await h.ok(c, "form.describe"));
  expect(d.fields.map((f: any) => [f.label, f.type, f.required])).toEqual([
    ["Organization name", "text", true],
    ["Yes", "radio", true],
    ["No", "radio", true],
    ["I will use Codex in ChatGPT under the usage policies", "checkbox", true],
    ["I agree to share usage data with the research team", "checkbox", true],
    ["Website", "text", false],
  ]);
  expect(d.fields.some((f: any) => f.hidden)).toBe(false);
  expect(d.fields[3]).toMatchObject({ name: "surface-codex-chatgpt", checked: false });
});

test("form.blockers and the disabled-Continue hint name the missing fields; fixing them lets the form submit", async ({ h }) => {
  await h.trustFixtures();
  const c = await h.mcp();
  await h.ok(c, "nav.goto", { url: `${h.A}/radix-form.html` });
  const b = payload(await h.ok(c, "form.blockers"));
  expect(b.blockers.map((x: any) => [x.group ?? x.label, x.kind])).toEqual([
    ["Organization name", "empty"],
    ["Are you a government entity or acting on behalf of one?", "unselected"],
    ["I will use Codex in ChatGPT under the usage policies", "unchecked"],
    ["I agree to share usage data with the research team", "unchecked"],
  ]);
  expect(b.submit).toMatchObject({ label: "Continue", disabled: true });

  const click = await h.call(c, "act.click", { ref: b.submit.ref, timeout: 500 });
  expect(click.isError).toBe(true);
  expect(click.text).toContain("NOT_ACTIONABLE");
  expect(click.text).toContain("submit disabled");
  expect(click.text).toContain("I will use Codex in ChatGPT under the usage policies");

  const sub = await h.call(c, "form.submit", {});
  expect(sub.text).toContain('"Continue" is disabled');
  expect(sub.text).toContain("(unchecked)");

  // Fill by label; the checkboxes are set through the visible buttons and verified.
  const d = payload(await h.ok(c, "form.describe"));
  const ref = (l: string) => d.fields.find((f: any) => f.label === l).ref;
  const fill = payload(await h.ok(c, "form.fill", { fields: { "Organization name": "Example Co", [ref("No")]: true, [ref("I will use Codex in ChatGPT under the usage policies")]: true } }));
  expect(fill.failed).toEqual([]);
  expect(fill.filled.some((f: any) => f.unverified)).toBe(false);
  const chk = payload(await h.ok(c, "act.check", { ref: ref("I agree to share usage data with the research team"), checked: true }));
  expect(chk.result).toMatchObject({ checked: true, changed: true, verified: true });

  // An invalid website is reported with the page's own error text.
  await h.ok(c, "act.fill", { ref: ref("Website"), value: "example.com" });
  const b2 = payload(await h.ok(c, "form.blockers"));
  expect(b2.blockers).toEqual([expect.objectContaining({ label: "Website", kind: "invalid", message: "Enter a full URL starting with https://" })]);
  await h.ok(c, "act.fill", { ref: ref("Website"), value: "https://example.com" });

  const b3 = payload(await h.ok(c, "form.blockers"));
  expect(b3.blockers).toEqual([]);
  expect(b3.submit.disabled).toBe(false);
  await h.ok(c, "act.click", { ref: b3.submit.ref });
  expect(await stateOf(h, c)).toBe("submitted no");
});
