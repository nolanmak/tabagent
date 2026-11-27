import { describe, expect, it } from "vitest";
import { agentCaptureEvent, exactNameMatch, assertionsPass, classifyInput, chooseLocatorCandidate, normalizeCaptureEvent, repairCanPersist, replayBlockCode, replayBlockReason, resolveDedupeKey, resolveReplayInput, shouldSkipDuplicate, type LocatorCandidate } from "../src/pure/workflow";

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

  it("resolves an idempotency key from declared run inputs", () => {
    expect(resolveDedupeKey("statement-{{PERIOD}}", { "{{PERIOD}}": "2026-11" })).toBe("statement-2026-11");
    expect(resolveDedupeKey("statement-{{PERIOD}}", {})).toBeNull();
    expect(resolveDedupeKey("static-key", {})).toBe("static-key");
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

  describe("agent capture mapping (HN/arXiv/X live tests)", () => {
    const url = "https://arxiv.org/search/";
    const box = { role: "textbox", name: "Search term or terms" };
    it("captures act.fill like act.type", () => {
      expect(agentCaptureEvent("act.fill", { ref: "e8", value: "LLM agents" }, url, box)).toEqual({ kind: "input", url, target: { ...box, value: "LLM agents" } });
      expect(agentCaptureEvent("act.type", { ref: "e8", text: "LLM agents" }, url, box)).toEqual({ kind: "input", url, target: { ...box, value: "LLM agents" } });
    });
    it("captures act.fill on a select as a select step", () => {
      const field = { role: "combobox", name: "Field" };
      expect(agentCaptureEvent("act.fill", { ref: "e9", value: "Title" }, url, field)).toEqual({ kind: "select", url, target: field, values: ["Title"] });
    });
    it("captures act.check with the requested state", () => {
      const radio = { role: "radio", name: "Hide abstracts" };
      const step = normalizeCaptureEvent(agentCaptureEvent("act.check", { ref: "e11", checked: true }, url, radio)!);
      expect(step).toEqual({ kind: "check", url, locator: radio, checked: true });
      expect(replayBlockReason(step)).toBeNull();
      expect(normalizeCaptureEvent(agentCaptureEvent("act.check", { ref: "e11", checked: false }, url, radio)!)).toMatchObject({ checked: false });
      expect(normalizeCaptureEvent(agentCaptureEvent("act.check", { ref: "e11" }, url, radio)!)).toMatchObject({ checked: true });
    });
    it("blocks replaying a check on a consent or account control", () => {
      expect(replayBlockReason({ kind: "check", locator: { role: "checkbox", name: "Delete my account" }, checked: true })).toMatch(/sensitive/);
      expect(replayBlockReason({ kind: "check", checked: true })).toMatch(/target/);
    });
    it("keeps the target of a press made on a ref", () => {
      const step = normalizeCaptureEvent(agentCaptureEvent("act.press", { ref: "e8", key: "Enter" }, url, box)!);
      expect(step).toEqual({ kind: "press", url, key: "Enter", locator: box });
      expect(normalizeCaptureEvent(agentCaptureEvent("act.press", { key: "Escape" }, url)!)).toEqual({ kind: "press", url, key: "Escape" });
    });
    it("captures page and element scrolls, bounded", () => {
      expect(normalizeCaptureEvent(agentCaptureEvent("act.scroll", { dy: 2500 }, "https://x.com/search")!)).toEqual({ kind: "scroll", url: "https://x.com/search", dx: 0, dy: 2500 });
      expect(normalizeCaptureEvent(agentCaptureEvent("act.scroll", { dy: 9e9 }, "https://x.com/")!)).toMatchObject({ dy: 20000 });
      expect(replayBlockReason({ kind: "scroll", dx: 0, dy: 2500 })).toBeNull();
      expect(replayBlockReason({ kind: "scroll", dx: 0, dy: 0 })).toMatch(/scroll/);
    });
    it("still maps navigation and waits, and ignores reads", () => {
      expect(agentCaptureEvent("nav.goto", { url: "https://news.ycombinator.com/" }, "")).toEqual({ kind: "navigate", url: "https://news.ycombinator.com/" });
      expect(agentCaptureEvent("nav.wait", { for: "url", value: "newest", timeout: 15000 }, "")).toEqual({ kind: "wait", waitFor: "url", waitValue: "newest", timeoutMs: 15000 });
      expect(agentCaptureEvent("nav.wait", { for: "fn", value: "1" }, "")).toBeUndefined();
      expect(agentCaptureEvent("page.text", {}, url)).toBeUndefined();
    });
  });

  it("replay prefers the one exact name when a role lookup also matches substrings", () => {
    const matches = [{ ref: "e1", role: "link", name: "Hacker News" }, { ref: "e2", role: "link", name: "new" }];
    expect(exactNameMatch({ role: "link", name: "new" }, matches)).toEqual(matches[1]);
    expect(exactNameMatch({ role: "link", name: "New " }, matches)).toEqual(matches[1]);
    expect(exactNameMatch({ role: "link", name: "news" }, matches)).toBeNull();
    expect(exactNameMatch({ role: "link", name: "x" }, [{ ref: "a", name: "x" }, { ref: "b", name: "x" }])).toBeNull();
  });
});
