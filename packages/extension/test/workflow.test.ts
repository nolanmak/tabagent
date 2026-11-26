import { describe, expect, it } from "vitest";
import { assertionsPass, classifyInput, chooseLocatorCandidate, normalizeCaptureEvent, repairCanPersist, replayBlockCode, replayBlockReason, resolveReplayInput, shouldSkipDuplicate, type LocatorCandidate } from "../src/pure/workflow";

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

  it("normalizes a select event with its chosen options", () => {
    expect(normalizeCaptureEvent({ kind: "select", url: "https://app.example/reports", target: { role: "combobox", name: "Report period" }, values: ["2026-11"] } as any)).toMatchObject({
      kind: "select",
      url: "https://app.example/reports",
      locator: { role: "combobox", name: "Report period" },
      options: ["2026-11"],
    });
  });

  it("normalizes a safe recorded wait but never needs page JavaScript", () => {
    expect(normalizeCaptureEvent({ kind: "wait", waitFor: "text", waitValue: "Report ready", timeoutMs: 5000 } as any)).toMatchObject({ kind: "wait", waitFor: "text", waitValue: "Report ready", timeoutMs: 5000 });
  });

  it("captures downloads as metadata-only checkpoints", () => {
    const step = normalizeCaptureEvent({ kind: "download", download: { extension: "csv", mime: "text/csv", bytes: 42 }, timeoutMs: 5000 });
    expect(step).toEqual({ kind: "download", download: { extension: "csv", mime: "text/csv", bytes: 42 }, timeoutMs: 5000 });
    expect(JSON.stringify(step)).not.toMatch(/filename|https?:/i);
    expect(replayBlockReason(step)).toBeNull();
    expect(replayBlockReason({ kind: "download" })).toMatch(/metadata/i);
  });

  it("resolves a reviewed input parameter only from a supplied run input", () => {
    expect(resolveReplayInput({ kind: "parameter", placeholder: "{{REPORT_PERIOD}}" }, { "{{REPORT_PERIOD}}": "2026-11" })).toBe("2026-11");
    expect(resolveReplayInput({ kind: "parameter", placeholder: "{{REPORT_PERIOD}}" }, {})).toBeNull();
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

  it("rejects an unknown persisted step kind before replay", () => {
    expect(replayBlockReason({ kind: "eval" } as any)).toMatch(/unknown/i);
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

  it("only persists a repair from a postcondition-verified run", () => {
    expect(repairCanPersist("succeeded")).toBe(true);
    expect(repairCanPersist("blocked")).toBe(false);
    expect(repairCanPersist("failed")).toBe(false);
  });
});
