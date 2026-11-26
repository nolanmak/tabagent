import { describe, expect, it } from "vitest";
import { assertionsPass, classifyInput, chooseLocatorCandidate, normalizeCaptureEvent, replayBlockCode, replayBlockReason, shouldSkipDuplicate, type LocatorCandidate } from "../src/pure/workflow";

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

  it("self-heals a small label addition only with the same role and a clear margin", () => {
    const wanted = { role: "button", name: "Download statement", selector: "#old" };
    const candidates: LocatorCandidate[] = [
      { role: "button", name: "Download statement PDF", selector: "#new" },
      { role: "button", name: "Contact support", selector: "#other" },
    ];
    expect(chooseLocatorCandidate(wanted, candidates)).toMatchObject({ selector: "#new" });
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

  it("stops replay before secrets and irreversible-looking actions", () => {
    expect(replayBlockReason({ kind: "input", locator: { role: "textbox", name: "API token" }, value: { kind: "secret-ref", placeholder: "{{API_TOKEN}}" } })).toMatch(/secret/i);
    expect(replayBlockReason({ kind: "click", locator: { role: "button", name: "Transfer funds" } })).toMatch(/sensitive/i);
    expect(replayBlockReason({ kind: "click", locator: { role: "button", name: "Download report" } })).toBeNull();
  });

  it("defensively rejects a malformed recipe with a fixed credential value", () => {
    expect(replayBlockReason({ kind: "input", locator: { role: "textbox", name: "Password" }, value: { kind: "fixed", value: "not-a-real-secret" } })).toMatch(/sensitive/i);
  });

  it("uses stable, structured stop reasons", () => {
    expect(replayBlockCode({ kind: "input", locator: { role: "textbox", name: "Password" }, value: { kind: "omit" } })).toBe("SENSITIVE_ACTION");
    expect(replayBlockCode({ kind: "click" })).toBe("AMBIGUOUS_TARGET");
  });

  it("skips a recipe only when its reviewed dedupe key completed already", () => {
    expect(shouldSkipDuplicate("statement-2026-11", [{ dedupeKey: "statement-2026-10", state: "succeeded" }])).toBe(false);
    expect(shouldSkipDuplicate("statement-2026-11", [{ dedupeKey: "statement-2026-11", state: "failed" }])).toBe(false);
    expect(shouldSkipDuplicate("statement-2026-11", [{ dedupeKey: "statement-2026-11", state: "succeeded" }])).toBe(true);
  });

  it("requires every reviewed URL postcondition", () => {
    expect(assertionsPass([{ kind: "url_includes", value: "/reports" }], "https://app.example/reports/2026")).toBe(true);
    expect(assertionsPass([{ kind: "url_includes", value: "/reports" }], "https://app.example/settings")).toBe(false);
  });
});
