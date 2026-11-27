/** Browser-independent recipe capture, redaction, and bounded locator healing. */
export type Locator = { role?: string; name?: string; label?: string; text?: string; selector?: string; context?: string };
export type InputValue = { kind: "fixed"; value: string } | { kind: "parameter"; placeholder: string } | { kind: "secret-ref"; placeholder: string } | { kind: "omit" };
/** Metadata-only expectation for a download. Names, URLs, and file contents never enter a recipe. */
export type DownloadExpectation = { extension?: string; mime?: string; bytes?: number };
export type WorkflowStep = { kind: "navigate" | "wait" | "click" | "input" | "select" | "press" | "download" | "check" | "scroll"; url?: string; checked?: boolean; dx?: number; dy?: number; locator?: Locator; value?: InputValue; options?: string[]; key?: string; waitFor?: "load" | "networkidle" | "selector" | "text" | "url"; waitValue?: string; timeoutMs?: number; download?: DownloadExpectation };
export type WorkflowAssertion = { kind: "url_includes"; value: string };
export type CaptureEvent = { kind: WorkflowStep["kind"]; url?: string; checked?: boolean; dx?: number; dy?: number; target?: Locator & { value?: string }; values?: string[]; key?: string; waitFor?: WorkflowStep["waitFor"]; waitValue?: string; timeoutMs?: number; download?: DownloadExpectation };
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

/** Parameters are explicitly named in recipe review; no value is retained in the recipe. */
export function resolveReplayInput(value: InputValue | undefined, inputs: Record<string, string>) {
  if (!value) return null;
  if (value.kind === "fixed") return value.value;
  if (value.kind === "parameter") return inputs[value.placeholder] ?? null;
  return null;
}

function locator(target: CaptureEvent["target"]): Locator | undefined {
  if (!target) return undefined;
  const { role, name, label, text, selector, context } = target;
  const out = { role, name, label, text, selector, context };
  return Object.values(out).some(Boolean) ? out : undefined;
}

const MAX_SCROLL = 20_000;
const scrollBy = (v: unknown) => Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0));
const WAIT_KINDS = new Set(["load", "networkidle", "selector", "text", "url"]);
const SELECT_ROLES = new Set(["combobox", "listbox"]);

/**
 * Map one successful agent tool call to a capture event. `target` is the semantic
 * description of the call's ref (role/name/label), looked up by the caller. Reads and
 * tools with no replayable meaning return undefined.
 */
export function agentCaptureEvent(tool: string, params: Record<string, unknown>, url: string, target?: Locator): CaptureEvent | undefined {
  const t = target ?? { name: "captured target" };
  const hasRef = typeof params.ref === "string";
  switch (tool) {
    case "nav.goto":
      return typeof params.url === "string" ? { kind: "navigate", url: params.url } : undefined;
    case "nav.wait":
      if (!WAIT_KINDS.has(String(params.for))) return undefined;
      return { kind: "wait", waitFor: params.for as WorkflowStep["waitFor"], ...(typeof params.value === "string" ? { waitValue: params.value } : {}), timeoutMs: typeof params.timeout === "number" ? params.timeout : undefined };
    case "act.click":
      return hasRef ? { kind: "click", url, target: t } : undefined;
    case "act.type":
      return hasRef && typeof params.text === "string" ? { kind: "input", url, target: { ...t, value: params.text } } : undefined;
    case "act.fill":
      if (!hasRef || typeof params.value !== "string") return undefined;
      // act.fill on a <select> picks an option, so replay it as a select step.
      if (SELECT_ROLES.has(t.role ?? "")) return { kind: "select", url, target: t, values: [params.value] };
      return { kind: "input", url, target: { ...t, value: params.value } };
    case "act.select":
      return hasRef && Array.isArray(params.values) && params.values.every((v) => typeof v === "string") ? { kind: "select", url, target: t, values: params.values as string[] } : undefined;
    case "act.check":
      return hasRef ? { kind: "check", url, target: t, checked: params.checked !== false } : undefined;
    case "act.press":
      if (typeof params.key !== "string") return undefined;
      return { kind: "press", url, key: params.key, ...(hasRef ? { target: t } : {}) };
    case "act.scroll":
      return { kind: "scroll", url, dx: scrollBy(params.dx), dy: scrollBy(params.dy), ...(hasRef ? { target: t } : {}) };
  }
  return undefined;
}

/** Among several find() matches, the single one whose name equals the locator's name. */
export function exactNameMatch<M extends { name?: string; role?: string }>(wanted: Locator, matches: readonly M[]): M | null {
  const want = norm(wanted.name ?? wanted.label ?? wanted.text);
  if (!want) return null;
  const hits = matches.filter((m) => norm(m.name) === want && (!wanted.role || !m.role || norm(m.role) === norm(wanted.role)));
  return hits.length === 1 ? hits[0] : null;
}

export function normalizeCaptureEvent(event: CaptureEvent): WorkflowStep {
  const target = locator(event.target);
  if (event.kind === "navigate") return { kind: "navigate", url: event.url };
  if (event.kind === "wait") return { kind: "wait", waitFor: event.waitFor, ...(typeof event.waitValue === "string" ? { waitValue: event.waitValue } : {}), timeoutMs: event.timeoutMs };
  if (event.kind === "download") return { kind: "download", download: event.download, timeoutMs: event.timeoutMs };
  if (event.kind === "input") return { kind: "input", ...(event.url ? { url: event.url } : {}), ...(target ? { locator: target } : {}), value: classifyInput(event.target?.name ?? event.target?.label ?? "input", event.target?.value ?? "") };
  if (event.kind === "select") return { kind: "select", ...(event.url ? { url: event.url } : {}), ...(target ? { locator: target } : {}), options: (event.values ?? []).filter((value) => typeof value === "string").map((value) => value.slice(0, 300)).slice(0, 20) };
  if (event.kind === "press") return { kind: "press", ...(event.url ? { url: event.url } : {}), key: event.key ?? "", ...(target ? { locator: target } : {}) };
  if (event.kind === "check") return { kind: "check", ...(event.url ? { url: event.url } : {}), ...(target ? { locator: target } : {}), checked: event.checked !== false };
  if (event.kind === "scroll") return { kind: "scroll", ...(event.url ? { url: event.url } : {}), dx: scrollBy(event.dx), dy: scrollBy(event.dy), ...(target ? { locator: target } : {}) };
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
const STEP_KINDS = new Set<WorkflowStep["kind"]>(["navigate", "wait", "click", "input", "select", "press", "download", "check", "scroll"]);
/** A replay recipe is deliberately narrower than interactive agent actions. */
export function replayBlockReason(step: WorkflowStep): string | null {
  if (!STEP_KINDS.has(step.kind)) return "unknown workflow step kind";
  if (step.kind === "input" && !step.value) return "input has no value";
  if (step.kind === "input" && (step.value?.kind === "secret-ref" || step.value?.kind === "omit")) return "input needs a secret, or was intentionally omitted";
  if (step.kind === "input" && OMIT.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "input target looks sensitive, so its value cannot be replayed";
  if ((step.kind === "click" || step.kind === "check") && UNSAFE.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "target looks like a sensitive or irreversible action";
  if ((step.kind === "click" || step.kind === "input" || step.kind === "select" || step.kind === "check") && !step.locator) return "step has no semantic target";
  if (step.kind === "scroll" && !step.dx && !step.dy && !step.locator) return "scroll step has no distance or target";
  if (step.kind === "select" && !step.options?.length) return "select step has no selected option";
  if (step.kind === "wait" && !step.waitFor) return "wait step has no condition";
  if (step.kind === "download" && !step.download?.extension && !step.download?.mime) return "download has no safe metadata expectation";
  if (step.kind === "navigate" && !step.url) return "navigation has no URL";
  return null;
}

/** Machine-readable counterpart to replayBlockReason for history, CLI and notifications. */
export function replayBlockCode(step: WorkflowStep): WorkflowRunReason | null {
  if (!STEP_KINDS.has(step.kind)) return "SENSITIVE_ACTION";
  if (step.kind === "input" && (!step.value || step.value.kind === "secret-ref" || step.value.kind === "omit")) return "SENSITIVE_ACTION";
  if (step.kind === "input" && OMIT.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "SENSITIVE_ACTION";
  if ((step.kind === "click" || step.kind === "check") && UNSAFE.test([step.locator?.name, step.locator?.label, step.locator?.text].filter(Boolean).join(" "))) return "SENSITIVE_ACTION";
  if ((step.kind === "click" || step.kind === "input" || step.kind === "select" || step.kind === "check") && !step.locator) return "AMBIGUOUS_TARGET";
  return null;
}

/** Only completed keys suppress a run; failed/blocked attempts remain safely retryable. */
export function shouldSkipDuplicate(key: string | undefined, priorRuns: readonly { dedupeKey?: string; state: string }[]) {
  return !!key && priorRuns.some((run) => run.state === "succeeded" && run.dedupeKey === key);
}

/** Resolve a reviewed idempotency template from explicit run inputs only. */
export function resolveDedupeKey(template: string | undefined, inputs: Record<string, string>) {
  if (!template) return undefined;
  let missing = false;
  const value = template.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, (placeholder) => {
    const input = inputs[placeholder];
    if (input == null) { missing = true; return placeholder; }
    return input;
  });
  return missing ? null : value;
}

export function assertionsPass(assertions: readonly WorkflowAssertion[] | undefined, url: string) {
  return (assertions ?? []).every((assertion) => assertion.kind === "url_includes" && url.includes(assertion.value));
}

/** A locator patch is trustworthy only after all reviewed postconditions passed. */
export function repairCanPersist(state: RunState) {
  return state === "succeeded";
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
  // A same-role candidate sharing most of the semantic name is a bounded repair; the
  // substantial runner-up margin prevents a near-tie from becoming an unattended click.
  if (!best || best.score < 0.65 || (ranked[1] && best.score - ranked[1].score < 0.15)) return null;
  return best;
}
