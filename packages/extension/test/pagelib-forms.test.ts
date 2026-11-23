// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clickGateInfo, keyGateInfo } from "../src/pagelib/forms";
import { keySensitivity, submitSensitivity } from "../src/pure/sensitive";

const FIX = join(__dirname, "../../../e2e/fixtures");
function load(html: string) {
  document.open();
  document.write(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  document.close();
}
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");

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
});
