// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clickGateInfo, comboOptions, describeFields, keyGateInfo, resolveFileInput, submitInfo } from "../src/pagelib/forms";
import { matchKeys, type FieldDesc } from "../src/pure/labels";
import { MASK, keySensitivity, submitConfirmation, submitSensitivity } from "../src/pure/sensitive";

const FIX = join(__dirname, "../../../e2e/fixtures");
function load(html: string) {
  document.open();
  document.write(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  document.close();
}
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
/** Turn pagelib {el: i} into refs like the background does. */
function refs(v: any): FieldDesc[] {
  return v.fields.map((f: any) => ({ ...f, ref: `e${f.el}` }));
}

describe("describeFields", () => {
  it("returns every field with label, type, required, options and value", () => {
    load(fixture("signup.html"));
    const r = describeFields(null).value as any;
    const fields = refs(r);
    const by = (l: string) => fields.find((f) => f.label === l)!;
    expect(by("Full name")).toMatchObject({ type: "text", required: true, value: "" });
    expect(by("Country").options!.map((o) => o.label)).toEqual(["Choose…", "United States", "Canada", "Mexico"]);
    expect(by("Business")).toMatchObject({ type: "radio", group: "Account type", value: "business" });
    expect(fields.find((f) => f.name === "terms")).toMatchObject({ type: "checkbox", checked: false });
    expect(by("Company name").visible).toBe(false);
    expect(r.form.label).toBe("Step 1");
    // step 2 is hidden, so step 1 is "the only form"
    expect(fields.some((f) => f.label === "City")).toBe(false);
  });
  it("a ref inside the other form selects that form", () => {
    load(fixture("signup.html"));
    const r = describeFields(document.getElementById("city")).value as any;
    const fields = refs(r);
    expect(fields.map((f) => [f.label, f.type])).toEqual([
      ["Start date", "date"],
      ["About you", "contenteditable"],
      ["City", "combobox"],
    ]);
  });
  it("several visible forms and no ref -> error listing the forms", () => {
    load(fixture("login-search.html"));
    const r = describeFields(null).value as any;
    expect(r.error).toBe("several forms");
    expect(r.forms.map((f: any) => f.fields)).toEqual([2, 1]);
  });
  it("no forms -> the whole document", () => {
    load(`<label for="a">Alone</label><input id="a">`);
    expect(refs(describeFields(null).value).map((f) => f.label)).toEqual(["Alone"]);
  });
  it("masks password and card values", () => {
    load(`<form><label for="p">Password</label><input id="p" type="password" value="hunter2"><label for="c">Card number</label><input id="c" value="4242424242424242"><label for="n">Name</label><input id="n" value="Neo"></form>`);
    const f = refs(describeFields(null).value);
    expect(f.map((x) => x.value)).toEqual([MASK, MASK, "Neo"]);
    expect(JSON.stringify(f)).not.toContain("hunter2");
    expect(JSON.stringify(f)).not.toContain("4242");
    expect((describeFields(null).value as any).form.sensitive).toEqual(["password field", "payment card field"]);
  });
  it("duplicate-label fixture: matching reports both refs", () => {
    load(fixture("duplicate-labels.html"));
    const f = refs(describeFields(null).value);
    const [email, name] = matchKeys(["Email", "Name"], f);
    expect(email.error?.code).toBe("BAD_REQUEST");
    expect(email.error?.candidates).toHaveLength(2);
    expect(name.ref).toBeTruthy();
  });
});

describe("gate inputs", () => {
  it("click on a login form's submit control reaches gate (a)", () => {
    load(fixture("login-search.html"));
    const info = clickGateInfo(document.querySelector("#login button")!);
    expect(info).toMatchObject({ role: "button", name: "Sign in", isSubmit: true });
    expect(submitSensitivity(info)).toEqual([{ category: "a", reason: "submits a form with a password field" }]);
  });
  it("a keyword button outside a form reaches gate (b)", () => {
    load(fixture("checkout.html"));
    expect(submitSensitivity(clickGateInfo(document.getElementById("del")!))[0].category).toBe("b");
    const pay = clickGateInfo(document.querySelector("#pay button")!);
    expect(submitSensitivity(pay).map((d) => d.category)).toEqual(["a", "b"]);
  });
  it("Enter in the password field reaches gate (a); Enter in search does not", () => {
    load(fixture("login-search.html"));
    (document.getElementById("p") as HTMLInputElement).focus();
    expect(keySensitivity("Enter", keyGateInfo())).toHaveLength(1);
    (document.getElementById("q") as HTMLInputElement).focus();
    expect(keySensitivity("Enter", keyGateInfo())).toEqual([]);
  });
  it("submitInfo + confirmation masks values", () => {
    load(fixture("login-search.html"));
    (document.getElementById("u") as HTMLInputElement).value = "neo";
    (document.getElementById("p") as HTMLInputElement).value = "hunter2";
    const r = submitInfo(document.getElementById("u")).value as any;
    expect(r.submit).toBe(1);
    expect(r.el).toBe(0);
    expect(r.control).toBe("Sign in");
    const c = submitConfirmation({ control: r.control, fields: r.fields });
    expect(c.reasons.join()).toContain("Username: neo");
    expect(c.reasons.join()).toContain(`Password: ${MASK}`);
    expect(c.reasons.join()).not.toContain("hunter2");
  });
  it("submitInfo without ref and several forms lists them", () => {
    load(fixture("login-search.html"));
    expect((submitInfo(null).value as any).error).toBe("several forms");
  });
});

describe("combobox options and file inputs", () => {
  it("lists the popup's options", () => {
    load(`<input id="c" role="combobox" aria-controls="lb"><ul id="lb" role="listbox"><li role="option">Paris</li><li role="option">Parma</li></ul>`);
    const r = comboOptions(document.getElementById("c")!);
    expect(r.value.map((o) => o.label)).toEqual(["Paris", "Parma"]);
  });
  it("datalist options", () => {
    load(`<input id="c" list="dl"><datalist id="dl"><option value="Red"><option value="Blue"></datalist>`);
    expect(comboOptions(document.getElementById("c")!).value.map((o) => o.label)).toEqual(["Red", "Blue"]);
  });
  it("resolves the file input behind a control", () => {
    load(`<input id="f" type="file"><label id="l" for="f">Pick</label><div id="d"><input type="file" id="g"></div><button id="b">x</button>`);
    expect(resolveFileInput(document.getElementById("f")!).elements[0].id).toBe("f");
    expect(resolveFileInput(document.getElementById("l")!).elements[0].id).toBe("f");
    expect(resolveFileInput(document.getElementById("d")!).elements[0].id).toBe("g");
    expect(resolveFileInput(document.getElementById("b")!).value).toBeNull();
  });
});
