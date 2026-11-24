// #61 Part B wire schemas for the remote handoff page.
import { describe, expect, it } from "vitest";
import { HandoffInputSchema, HandoffOpenSchema, isHandoffExtMessage } from "../src/handoff";

describe("remote handoff wire", () => {
  it("input: tap/text/key/scroll only, strict, bounded", () => {
    for (const ok of [
      { kind: "tap", x: 0, y: 1 },
      { kind: "text", text: "a".repeat(500) },
      { kind: "key", key: "Enter" },
      { kind: "scroll", x: 0.5, y: 0.5, dy: -400 },
    ]) expect(HandoffInputSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [
      { kind: "tap", x: -0.1, y: 0 },
      { kind: "tap", x: 0.5, y: 0.5, tabId: 3 },
      { kind: "text", text: "" },
      { kind: "text", text: "a".repeat(501) },
      { kind: "key", key: "F12" },
      { kind: "key", key: "Control" },
      { kind: "scroll", x: 0.5, y: 0.5, dy: 1e9 },
      { kind: "eval", expression: "1" },
      { kind: "navigate", url: "https://x" },
      {},
      null,
    ]) expect(HandoffInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("open carries no tab id and bounds its text", () => {
    expect(HandoffOpenSchema.safeParse({ type: "handoff.open", id: "1", commandId: "c", origin: "https://a.b", reason: "r", sessionLabel: "s" }).success).toBe(true);
    expect(HandoffOpenSchema.safeParse({ type: "handoff.open", id: "1", commandId: "c", origin: "https://a.b", reason: "r".repeat(501), sessionLabel: "s" }).success).toBe(false);
  });

  it("isHandoffExtMessage matches only the extension → bridge handoff messages", () => {
    for (const t of ["handoff.open", "handoff.closed", "handoff.frame.result", "handoff.input.result"]) expect(isHandoffExtMessage({ type: t })).toBe(true);
    for (const t of ["handoff.opened", "handoff.frame", "handoff.input", "handoff.end", "result", "event"]) expect(isHandoffExtMessage({ type: t })).toBe(false);
    expect(isHandoffExtMessage(null)).toBe(false);
  });
});
