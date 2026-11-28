import { describe, expect, it } from "vitest";
import {
  answerLabel,
  APPROVALS_FEATURE,
  checkPreferenceChanges,
  MirroredPromptSchema,
  PromptAnswerResultSchema,
  PromptAnswerSchema,
  PromptsSyncSchema,
  TabAgentError,
} from "../src/index";

const prompt = { promptId: "p1", title: "jarvis wants to read https://a.example", detail: "It will be able to see page content.", summary: "open", reasons: [], tool: "nav.goto", sessionLabel: "jarvis", origin: "https://a.example", expires: 1, answers: ["deny", "always", "once"], alwaysLabel: "Always allow read" };

describe("#108 approvals wire", () => {
  it("has a feature flag", () => expect(APPROVALS_FEATURE).toBe("prompts.mirror"));
  it("accepts a mirrored prompt and a sync", () => {
    expect(MirroredPromptSchema.parse(prompt)).toEqual(prompt);
    expect(PromptsSyncSchema.safeParse({ type: "prompts.sync", enabled: true, prompts: [prompt] }).success).toBe(true);
  });
  it("rejects a prompt with no answers or an unknown answer", () => {
    expect(MirroredPromptSchema.safeParse({ ...prompt, answers: [] }).success).toBe(false);
    expect(MirroredPromptSchema.safeParse({ ...prompt, answers: ["yes"] }).success).toBe(false);
  });
  it("prompt.answer can only name an outside channel, never the panel", () => {
    const m = { type: "prompt.answer", id: "a", promptId: "p1", answer: "once", channel: "phone" };
    expect(PromptAnswerSchema.safeParse(m).success).toBe(true);
    expect(PromptAnswerSchema.safeParse({ ...m, channel: "cli-presence" }).success).toBe(true);
    expect(PromptAnswerSchema.safeParse({ ...m, channel: "panel" }).success).toBe(false);
  });
  it("results carry an outcome", () => {
    expect(PromptAnswerResultSchema.safeParse({ type: "prompt.answer.result", id: "a", ok: false, outcome: "already_answered", by: "panel" }).success).toBe(true);
    expect(PromptAnswerResultSchema.safeParse({ type: "prompt.answer.result", id: "a", ok: false, outcome: "maybe" }).success).toBe(false);
  });
  it("labels answers like the panel", () => {
    expect(answerLabel("once")).toBe("Allow once");
    expect(answerLabel("deny")).toBe("Deny");
    expect(answerLabel("always", "Always allow read")).toBe("Always allow read");
    expect(answerLabel("always")).toBe("Always allow");
  });
});

describe("#108 settings.change cannot turn on outside approvals", () => {
  it("is refused as protected with a pointer to the side panel", () => {
    try {
      checkPreferenceChanges({ outsideApprovals: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TabAgentError);
      expect((e as TabAgentError).code).toBe("PERMISSION_DENIED");
      expect((e as TabAgentError).hint).toMatch(/side panel/);
    }
  });
});
