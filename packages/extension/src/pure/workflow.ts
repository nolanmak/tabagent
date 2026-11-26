/** Browser-independent recipe capture, redaction, and bounded locator healing. */
export type Locator = { role?: string; name?: string; label?: string; text?: string; selector?: string; context?: string };
export type InputValue = { kind: "fixed"; value: string } | { kind: "secret-ref"; placeholder: string } | { kind: "omit" };
export type WorkflowStep = { kind: "navigate" | "click" | "input" | "select" | "press"; url?: string; locator?: Locator; value?: InputValue; key?: string };
export type WorkflowAssertion = { kind: "url_includes"; value: string };
export type CaptureEvent = { kind: WorkflowStep["kind"]; url?: string; target?: Locator & { value?: string }; key?: string };
export type LocatorCandidate = Required<Pick<Locator, "role" | "name" | "selector">> & Pick<Locator, "label" | "text" | "context">;
export type WorkflowRecipe = { version: 1; id: string; name: string; createdAt: number; source: "agent" | "manual" | "mixed"; status: "draft" | "reviewed"; steps: WorkflowStep[]; assertions?: WorkflowAssertion[]; stopRules: string[]; /** Human-reviewed key identifying an artifact/outcome that must not repeat. */ dedupeKey?: string };
export type RunState = "queued" | "running" | "succeeded" | "skipped" | "blocked" | "failed" | "cancelled";
export type WorkflowRunReason = "NO_EXTENSION" | "AUTH_REQUIRED" | "AMBIGUOUS_TARGET" | "POLICY_DENIED" | "ASSERTION_FAILED" | "SENSITIVE_ACTION";

const OMIT = /pass(word)?|pin|one.?time|otp|mfa|authenticator|verification.?code|cvv|cvc|security.?code|credit.?card|card.?number|ssn|social.?security|routing|account.?number/i;
const SECRET = /token|api.?key|secret|access.?key|private.?key/i;

export function classifyInput(name: string, value: string): InputValue {
  if (OMIT.test(name) || /^\d{13,19}$/.test(value.replace(/[ -]/g, ""))) return { kind: "omit" };
  if (SECRET.test(name)) return { kind: "secret-ref", placeholder: `{{${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}}}` };
  return { kind: "fixed", value: value.slice(0, 1000) };
}

function locator(target: CaptureEvent["target"]): Locator | undefined {
  if (!target) return undefined;
  const { role, name, label, text, selector, context } = target;
  const out = { role, name, label, text, selector, context };
  return Object.values(out).some(Boolean) ? out : undefined;
}

export function normalizeCaptureEvent(event: CaptureEvent): WorkflowStep {
  const target = locator(event.target);
  if (event.kind === "navigate") return { kind: "navigate", url: event.url };
  if (event.kind === "input") return { kind: "input", ...(event.url ? { url: event.url } : {}), ...(target ? { locator: target } : {}), value: classifyInput(event.target?.name ?? event.target?.label ?? "input", event.target?.value ?? "") };
  if (event.kind === "press") return { kind: "press", ...(event.url ? { url: event.url } : {}), key: event.key ?? "" };
  return { kind: event.kind, ...(event.url ? { url: event.url } : {}), ...(target ? { locator: target } : {}) };
}

export function buildRecipe(id: string, name: string, source: WorkflowRecipe["source"], events: readonly CaptureEvent[], now: number): WorkflowRecipe {
  return {
    version: 1,
    id,
    name: name.trim().slice(0, 120) || "Captured workflow",
    createdAt: now,
    source,
    status: "draft",
    steps: events.map(normalizeCaptureEvent),
    stopRules: ["MFA or unexpected sign-in", "ambiguous target", "delete, send, purchase, transfer, upload, or account-setting action"],
  };
}

const UNSAFE = /delete|remove|destroy|send|submit|pay|purchase|buy|transfer|withdraw|deposit|wire|upload|invite|share|account|password|sign.?in|log.?in|mfa|otp|verify/i;
/** A replay recipe is deliberately narrower than interactive agent actions. */
export function replayBlockReason(step: WorkflowStep): string | null {
  if (step.kind === "input" && step.value?.kind !== "fixed") return "input needs a secret, or was intentionally omitted";
  if (step.kind === "input" && OMIT.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "input target looks sensitive, so its value cannot be replayed";
  if (step.kind === "click" && UNSAFE.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "target looks like a sensitive or irreversible action";
  if ((step.kind === "click" || step.kind === "input" || step.kind === "select") && !step.locator) return "step has no semantic target";
  if (step.kind === "navigate" && !step.url) return "navigation has no URL";
  return null;
}

/** Machine-readable counterpart to replayBlockReason for history, CLI and notifications. */
export function replayBlockCode(step: WorkflowStep): WorkflowRunReason | null {
  if (step.kind === "input" && step.value?.kind !== "fixed") return "SENSITIVE_ACTION";
  if (step.kind === "input" && OMIT.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "SENSITIVE_ACTION";
  if (step.kind === "click" && UNSAFE.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "SENSITIVE_ACTION";
  if ((step.kind === "click" || step.kind === "input" || step.kind === "select") && !step.locator) return "AMBIGUOUS_TARGET";
  return null;
}

/** Only completed keys suppress a run; failed/blocked attempts remain safely retryable. */
export function shouldSkipDuplicate(key: string | undefined, priorRuns: readonly { dedupeKey?: string; state: string }[]) {
  return !!key && priorRuns.some((run) => run.state === "succeeded" && run.dedupeKey === key);
}

export function assertionsPass(assertions: readonly WorkflowAssertion[] | undefined, url: string) {
  return (assertions ?? []).every((assertion) => assertion.kind === "url_includes" && url.includes(assertion.value));
}

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const similarity = (a: string | undefined, b: string | undefined) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const words = new Set(x.split(" "));
  const overlap = y.split(" ").filter((w) => words.has(w)).length;
  return overlap / Math.max(words.size, new Set(y.split(" ")).size);
};

/** Returns a repair only above threshold and with a clear margin over runner-up. */
export function chooseLocatorCandidate(wanted: Locator, candidates: readonly LocatorCandidate[]): (LocatorCandidate & { score: number }) | null {
  const ranked = candidates
    .map((candidate) => {
      const role = norm(wanted.role) && norm(wanted.role) === norm(candidate.role) ? 0.25 : 0;
      const name = similarity(wanted.name ?? wanted.label ?? wanted.text, candidate.name ?? candidate.label ?? candidate.text) * 0.65;
      const context = similarity(wanted.context, candidate.context) * 0.1;
      return { ...candidate, score: role + name + context };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.85 || (ranked[1] && best.score - ranked[1].score < 0.15)) return null;
  return best;
}
