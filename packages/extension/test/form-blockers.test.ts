// @vitest-environment happy-dom
// nolanmak/tabagent#64: Radix-style forms (OpenAI Daybreak). Labels for custom controls,
// one field per hidden-input twin, and form.blockers: why a form can't submit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFields, fieldInfo, formBlockers, submitLike } from "../src/pagelib/forms";
import { getChecked } from "../src/pagelib/index";

const FIX = join(__dirname, "../../../e2e/fixtures");
/** happy-dom has no UA stylesheet: give [hidden] its display:none like Chrome does. */
const UA = "<style>[hidden]{display:none}</style>";
function load(html: string) {
  document.open();
  document.write(UA + html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  document.close();
}
const radix = () => load(readFileSync(join(FIX, "radix-form.html"), "utf8"));
const $ = (s: string) => document.querySelector(s)!;

/** What the page's script does on a click: flip the button and mirror it into the hidden input. */
function setAria(id: string, on: boolean) {
  const b = document.getElementById(id)!;
  b.setAttribute("aria-checked", String(on));
  (b.nextElementSibling as HTMLInputElement).checked = on;
}

type F = { el: number; label: string | null; type: string; required?: boolean; name?: string | null; group?: string; checked?: boolean; value?: string };
function fields() {
  const r = describeFields(null);
  const v = r.value as { fields: F[] };
  return v.fields.map((f) => ({ ...f, node: r.elements[f.el] as Element }));
}

describe("labels for custom controls", () => {
  it("label[for] on an ARIA button, the row's own text, and the field container's text", () => {
    radix();
    const f = fields();
    const by = (id: string) => f.find((x) => x.node.id === id)!;
    expect(by("gov-yes").label).toBe("Yes");
    expect(by("gov-no").label).toBe("No");
    expect(by("codex").label).toBe("I will use Codex in ChatGPT under the usage policies");
    expect(by("share").label).toBe("I agree to share usage data with the research team");
    expect(by("gov-yes").group).toBe("Are you a government entity or acting on behalf of one?");
  });

  it("adjacent text when the container holds other controls", () => {
    load(`<form><div role="group"><button type="button" role="checkbox" aria-checked="false" id="a"></button> Email updates <button type="button" role="checkbox" aria-checked="false" id="b"></button><span>SMS updates</span></div></form>`);
    const f = fields();
    expect(f.map((x) => x.label)).toEqual(["Email updates", "SMS updates"]);
  });

  it("aria-labelledby and aria-label still win; long wrapper text is clipped", () => {
    load(`<form><span id="cap">Named by id</span><div><button type="button" role="checkbox" aria-labelledby="cap" aria-checked="false"></button><span>Not this</span></div><div><button type="button" role="switch" aria-label="Dark mode" aria-checked="false"></button></div><div><button type="button" role="checkbox" aria-checked="false"></button><span>${"word ".repeat(80)}</span></div></form>`);
    const f = fields();
    expect(f[0].label).toBe("Named by id");
    expect(f[1].label).toBe("Dark mode");
    expect(f[2].label!.length).toBeLessThanOrEqual(201);
    expect(f[2].label!.endsWith("…")).toBe(true);
  });

  it("does not borrow text from a container shared with another field", () => {
    load(`<form><div><p>Contact</p><input name="a"><input name="b"></div></form>`);
    expect(fields().map((x) => x.label)).toEqual([null, null]);
  });
});

describe("twin collapse (hidden native input mirroring an ARIA control)", () => {
  it("reports each Radix control once, under the visible button's ref, with required/name from the input", () => {
    radix();
    const f = fields();
    expect(f.some((x) => x.node.tagName === "INPUT" && (x.node as HTMLInputElement).type !== "text" && x.node.getAttribute("aria-hidden") === "true")).toBe(false);
    expect(f.map((x) => x.node.id)).toEqual(["org", "gov-yes", "gov-no", "codex", "share", "site"]);
    const codex = f.find((x) => x.node.id === "codex")!;
    expect(codex).toMatchObject({ type: "checkbox", required: true, name: "surface-codex-chatgpt", checked: false, value: "on" });
    expect(f.find((x) => x.node.id === "gov-no")).toMatchObject({ type: "radio", required: true, name: "governmentSupport", value: "no" });
  });

  it("checked follows the page's state; fieldInfo on the visible ref merges the twin", () => {
    radix();
    setAria("codex", true);
    expect(fields().find((x) => x.node.id === "codex")!.checked).toBe(true);
    expect(fieldInfo($("#codex")).value).toMatchObject({ required: true, name: "surface-codex-chatgpt", checked: true });
  });

  it("getChecked on an ARIA control without aria-checked reads its hidden input", () => {
    load(`<div><div role="checkbox" id="c"></div><input type="checkbox" aria-hidden="true" tabindex="-1" name="x"></div>`);
    expect(getChecked($("#c"))).toBe(false);
    ($("input") as HTMLInputElement).checked = true;
    expect(getChecked($("#c"))).toBe(true);
  });

  it("a hidden native checkbox next to an unrelated ARIA radio is not a twin", () => {
    load(`<form><div role="radio" aria-checked="false">A</div><input type="checkbox" name="solo" aria-hidden="true"></form>`);
    expect(fields()).toHaveLength(2);
  });
});

describe("formBlockers", () => {
  type B = { el: number; label: string | null; group?: string; kind: string; message: string };
  function blockers(self: Element | null = null) {
    const r = formBlockers(self);
    const v = r.value as { form: { el: number } | null; submit: { el: number; label: string; disabled: boolean } | null; blockers: B[] };
    return { ...v, list: v.blockers.map((b) => ({ ...b, node: r.elements[b.el] as Element })), els: r.elements };
  }

  it("lists every unanswered required field of the Radix form and the disabled Continue", () => {
    radix();
    const b = blockers();
    expect(b.list.map((x) => [x.node.id, x.kind])).toEqual([
      ["org", "empty"],
      ["gov-yes", "unselected"],
      ["codex", "unchecked"],
      ["share", "unchecked"],
    ]);
    expect(b.list[1].group).toBe("Are you a government entity or acting on behalf of one?");
    expect(b.list[2].label).toBe("I will use Codex in ChatGPT under the usage policies");
    expect(b.submit).toMatchObject({ label: "Continue", disabled: true });
    expect((b.els[b.submit!.el] as Element).id).toBe("go");
    expect((b.els[b.form!.el] as Element).id).toBe("apply");
  });

  it("answers clear their blockers; a ref on the submit button picks its form", () => {
    radix();
    ($("#org") as HTMLInputElement).value = "Example Co";
    setAria("gov-no", true);
    setAria("codex", true);
    const b = blockers($("#go"));
    expect(b.list.map((x) => x.node.id)).toEqual(["share"]);
    setAria("share", true);
    expect(blockers($("#go")).list).toEqual([]);
  });

  it("aria-invalid fields carry the page's error text (aria-describedby)", () => {
    radix();
    $("#site").setAttribute("aria-invalid", "true");
    ($("#site-err") as HTMLElement).hidden = false;
    const site = blockers().list.find((x) => x.node.id === "site")!;
    expect(site).toMatchObject({ kind: "invalid", label: "Website", message: "Enter a full URL starting with https://" });
  });

  it("aria-invalid finds a nearby error element when nothing is linked", () => {
    load(`<form><div><label for="e">Email</label><input id="e" aria-invalid="true"><div role="alert">That email is taken</div></div><button>Go</button></form>`);
    expect(blockers().list[0]).toMatchObject({ kind: "invalid", label: "Email", message: "That email is taken" });
  });

  it("native validity failures: type, pattern, length", () => {
    load(`<form><label>Mail <input type="email" value="nope"></label><label>Zip <input pattern="\\d{5}" value="abc"></label><label>Code <input minlength="4" value="ab"></label><button>Go</button></form>`);
    const kinds = blockers().list.map((x) => [x.label, x.kind]);
    expect(kinds.slice(0, 2)).toEqual([
      ["Mail", "type"],
      ["Zip", "pattern"],
    ]);
  });

  it("native radio groups and required checkboxes; disabled and display:none fields are skipped", () => {
    load(`<form><fieldset><legend>Plan</legend><label><input type="radio" name="p" value="a" required> A</label><label><input type="radio" name="p" value="b"> B</label></fieldset><label><input type="checkbox" required> Accept</label><input required disabled aria-label="Off"><div hidden><input required aria-label="Later"></div><button>Go</button></form>`);
    const b = blockers();
    expect(b.list.map((x) => [x.label ?? x.group, x.kind])).toEqual([
      ["A", "unselected"],
      ["Accept", "unchecked"],
    ]);
    expect(b.list[0].group).toBe("Plan");
    expect(b.submit).toMatchObject({ label: "Go", disabled: false });
  });

  it("ARIA required radiogroup with nothing selected and no native inputs", () => {
    load(`<div><p id="q">Size</p><div role="radiogroup" aria-labelledby="q" aria-required="true"><div role="radio" aria-checked="false">S</div><div role="radio" aria-checked="false">L</div></div><div role="button" aria-disabled="true">Next</div></div>`);
    const b = blockers();
    expect(b.list.map((x) => [x.group, x.kind])).toEqual([["Size", "unselected"]]);
    expect(b.submit).toMatchObject({ label: "Next", disabled: true });
  });

  it("no ref: the form holding focus wins over the others", () => {
    load(`<form id="a"><input required aria-label="Search"><button>Search</button></form><form id="b"><input required aria-label="Name" id="n"><button>Save</button></form>`);
    ($("#n") as HTMLInputElement).focus();
    const b = blockers();
    expect((b.els[b.form!.el] as Element).id).toBe("b");
    expect(b.list.map((x) => x.label)).toEqual(["Name"]);
  });
});

describe("submitLike", () => {
  it("submit buttons in a form and Continue/Next-style buttons", () => {
    radix();
    expect(submitLike($("#go"))).toBe(true);
    expect(submitLike($("#codex"))).toBe(false);
    load(`<div><button type="button">Continue</button><button>Cancel</button><div role="button">Next step</div></div>`);
    const [cont, cancel] = Array.from(document.querySelectorAll("button"));
    expect(submitLike(cont)).toBe(true);
    expect(submitLike(cancel)).toBe(false);
    expect(submitLike($("[role=button]"))).toBe(true);
  });
});
