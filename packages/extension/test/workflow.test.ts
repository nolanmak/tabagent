import { describe, expect, it } from "vitest";
import { classifyInput, chooseLocatorCandidate, normalizeCaptureEvent, type LocatorCandidate } from "../src/pure/workflow";

describe("workflow capture (#68, #69)", () => {
  it("redacts secrets and retains a semantic locator instead of a raw DOM snapshot", () => {
    const step = normalizeCaptureEvent({
      kind: "input",
      url: "https://app.example/settings",
      target: { role: "textbox", name: "API token", selector: "#token", value: "super-secret" },
    });
    expect(step).toEqual({
      kind: "input",
      url: "https://app.example/settings",
      locator: { role: "textbox", name: "API token", selector: "#token" },
      value: { kind: "secret-ref", placeholder: "{{API_TOKEN}}" },
    });
  });

  it("omits password, card and MFA inputs rather than storing them", () => {
    expect(classifyInput("Password", "hunter2")).toEqual({ kind: "omit" });
    expect(classifyInput("Credit card", "4111111111111111")).toEqual({ kind: "omit" });
    expect(classifyInput("Search", "wireless headphones")).toEqual({ kind: "fixed", value: "wireless headphones" });
  });

  it("self-heals only an unambiguous high-confidence semantic match", () => {
    const wanted = { role: "button", name: "Download statement", selector: "#old" };
    const candidates: LocatorCandidate[] = [
      { role: "button", name: "Download statement", selector: "#new", context: "Statements" },
      { role: "button", name: "Download all statements", selector: "#other", context: "Statements" },
    ];
    expect(chooseLocatorCandidate(wanted, candidates)).toMatchObject({ selector: "#new", score: expect.any(Number) });
  });

  it("does not self-heal an ambiguous or low-confidence target", () => {
    const wanted = { role: "button", name: "Download", selector: "#old" };
    const same: LocatorCandidate[] = [
      { role: "button", name: "Download", selector: "#one" },
      { role: "button", name: "Download", selector: "#two" },
    ];
    expect(chooseLocatorCandidate(wanted, same)).toBeNull();
    expect(chooseLocatorCandidate(wanted, [{ role: "link", name: "Contact us", selector: "#contact" }])).toBeNull();
  });
});
