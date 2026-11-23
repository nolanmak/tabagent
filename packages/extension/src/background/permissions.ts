// Permission gate (contract §8). The pure engine is policy.ts; this module holds
// the state, runs prompts (D19) and exposes requireSite / requireSensitive.
// Enforced here, in the extension, never in the bridge (D1).
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { broadcast } from "./feed";
import { applySensitiveAnswer, applySiteAnswer, clearSessionGrants, effectiveLevel, originOf, resolve, type Answer, type Level, type PolicyState, type SensitiveCategory, type SessionGrant } from "./policy";
import { CATEGORY_TEXT, PromptQueue, type PromptInfo, type PromptKind, type PromptOutcome } from "./prompts";
import { getSettings, updateSettings } from "./settings";

export type { Answer, PromptInfo, PromptKind };

const err = (code: string, message: string, hint?: string) => new TabAgentError(code as any, message, hint);

// ---------------------------------------------------------------------------
// Session grants (allow once / deny), persisted in chrome.storage.session (D11)
// ---------------------------------------------------------------------------
let grants: Record<string, Record<string, SessionGrant>> | null = null;

async function loadGrants() {
  if (grants) return grants;
  try {
    grants = ((await chrome.storage.session.get("grants")).grants as typeof grants) ?? {};
  } catch {
    grants = {};
  }
  return grants!;
}

async function saveGrants() {
  await chrome.storage.session.set({ grants: grants ?? {} }).catch(() => {});
}

async function policyState(): Promise<PolicyState> {
  const s = await getSettings();
  return { paused: s.paused, sites: s.sites, denylist: s.denylist, devAllowSensitive: s.devAllowSensitive, grants: await loadGrants() };
}

/** Kill switch / session end: allow-once (and deny) answers go away. */
export async function clearGrants(sessionId?: string) {
  const st = clearSessionGrants({ paused: false, sites: {}, denylist: [], grants: await loadGrants() }, sessionId);
  grants = st.grants;
  await saveGrants();
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export const prompts = new PromptQueue({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  newId: () => crypto.randomUUID(),
});

type PromptHook = (ev: { type: "added" | "removed"; info: PromptInfo; outcome?: PromptOutcome }) => void;
const hooks = new Set<PromptHook>();
/** index.ts registers delivery (badge, notification, banner, bridge events). */
export function onPrompt(fn: PromptHook) {
  hooks.add(fn);
}
prompts.on((ev) => {
  broadcast({ type: "prompts", prompts: prompts.list() });
  for (const h of hooks) {
    try {
      h(ev);
    } catch {
      /* delivery is best effort */
    }
  }
});

export function pendingPrompts(): PromptInfo[] {
  return prompts.list();
}

export function answerPrompt(id: string, answer: Answer): boolean {
  return prompts.answer(id, answer);
}

export function denyAllPrompts() {
  prompts.dropAll("killed");
}

function outcomeError(outcome: PromptOutcome, what: string): TabAgentError | null {
  if (outcome === "timeout") return err("PROMPT_TIMEOUT", `Nobody answered the permission prompt for ${what} within 120s`, "Ask the user to open the TabAgent side panel and answer, then retry.");
  if (outcome === "killed") return err("KILLED", "The user stopped all agents with the TabAgent kill switch", "Ask the user to press Resume in the TabAgent side panel.");
  if (outcome === "deny") return err("PERMISSION_DENIED", `The user denied ${what}`);
  return null;
}

// ---------------------------------------------------------------------------
// Per-command approvals: the router holds a static-category approval while the
// handler runs, so a handler re-checking the same gate doesn't prompt twice.
// ---------------------------------------------------------------------------
const held = new Map<string, number>();
export function holdApproval(sessionId: string, origin: string, category: SensitiveCategory): () => void {
  const k = `${sessionId}|${origin}|${category}`;
  held.set(k, (held.get(k) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (held.get(k) ?? 1) - 1;
    if (n <= 0) held.delete(k);
    else held.set(k, n);
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
export interface GateRequest {
  meta: SessionMeta | { id: string; label: string; cap: string; sites: string[] };
  url: string;
  level: Level | null;
  sensitive?: SensitiveCategory;
  tool: string;
  summary: string;
  reasons: string[];
  tabId?: number;
}

/** Resolve -> prompt -> apply answer, until allowed or denied. */
export async function authorize(g: GateRequest): Promise<void> {
  const meta = g.meta;
  for (let round = 0; round < 4; round++) {
    const st = await policyState();
    const d = resolve(st, { sessionId: meta.id, cap: (meta.cap as Level) ?? "full", sites: meta.sites ?? [], url: g.url, level: g.level, sensitive: g.sensitive });
    if (d.decision === "allow") return;
    if (d.decision === "deny") throw err(d.code, d.message, d.hint);
    if (d.kind === "sensitive" && held.has(`${meta.id}|${d.origin}|${d.category}`)) return;
    if (d.kind === "site") {
      const { outcome } = prompts.request({ kind: "site", sessionId: meta.id, sessionLabel: meta.label, origin: d.origin, level: d.level, tool: g.tool, summary: g.summary, reasons: d.reason ? [d.reason] : [], tabId: g.tabId });
      const o = await outcome;
      if (o === "once" || o === "always" || o === "deny") {
        const next = applySiteAnswer(st, meta.id, d.origin, d.level, o);
        if (o === "always") await updateSettings({ sites: next.sites });
        else {
          grants = next.grants;
          await saveGrants();
        }
      }
      const e = outcomeError(o, `${d.level} access to ${d.origin}`);
      if (e) throw e;
      continue;
    }
    // sensitive
    const cat = d.category;
    const kind: PromptKind = cat === "f" ? "attach" : "sensitive";
    const { outcome } = prompts.request({ kind, sessionId: meta.id, sessionLabel: meta.label, origin: d.origin, sensitive: { category: cat, description: CATEGORY_TEXT[cat] }, tool: g.tool, summary: g.summary, reasons: g.reasons, tabId: g.tabId });
    const o = await outcome;
    if (o === "always") {
      const next = applySensitiveAnswer(st, d.origin, cat, o);
      if (next !== st) await updateSettings({ sites: next.sites });
    }
    const e = outcomeError(o, `this action (${CATEGORY_TEXT[cat].toLowerCase()})`);
    if (e) throw e;
    return; // once / always: this action may proceed
  }
  throw err("PERMISSION_DENIED", "Permission could not be settled");
}

/** Ensure the session may use `level` on `url`. May prompt the user. */
export async function requireSite(meta: SessionMeta, url: string, level: Level, tool: string, summary: string): Promise<void> {
  return authorize({ meta, url, level, tool, summary, reasons: [] });
}

const CATS = new Set(["a", "b", "c", "d", "e", "f"]);

export interface SensitiveOpts {
  tabId?: number;
}

/**
 * Sensitive gate (D18). New signature: (meta, url, category, tool, summary, reasons).
 * The spike's (meta, url, tool, summary, reasons, kind?) form is still accepted.
 */
export function requireSensitive(meta: SessionMeta, url: string, category: SensitiveCategory, tool: string, summary: string, reasons: string[], opts?: SensitiveOpts): Promise<void>;
/** @deprecated legacy spike signature */
export function requireSensitive(meta: SessionMeta, url: string, tool: string, summary: string, reasons: string[], kind?: PromptKind): Promise<void>;
export async function requireSensitive(meta: SessionMeta, url: string, a: string, b: string, c: string | string[], d?: string[] | PromptKind, opts?: SensitiveOpts): Promise<void> {
  let category: SensitiveCategory;
  let tool: string;
  let summary: string;
  let reasons: string[];
  if (CATS.has(a)) {
    category = a as SensitiveCategory;
    tool = b;
    summary = c as string;
    reasons = (d as string[]) ?? [];
  } else {
    tool = a;
    summary = b;
    reasons = (c as string[]) ?? [];
    category = d === "attach" ? "f" : legacyCategory(tool, reasons);
  }
  return authorize({ meta, url, level: null, sensitive: category, tool, summary, reasons, tabId: opts?.tabId });
}

function legacyCategory(tool: string, reasons: string[]): SensitiveCategory {
  const stat: Record<string, SensitiveCategory> = { "js.eval": "c", "nav.wait": "c", "cookies.get": "d", "storage.get": "d", "network.get": "d", "act.upload": "e", "downloads.read": "e", tabs: "f" };
  if (stat[tool]) return stat[tool];
  if (reasons.some((r) => /password|card|ssn|bank account|form with/i.test(r))) return "a";
  return "b";
}

/** Effective level for display (session.permissions + legacy callers). */
export async function effectivePolicy(url: string, meta?: { id: string; cap: string; sites: string[] }): Promise<{ origin: string | null; policy: string; source: string }> {
  const st = await policyState();
  const e = effectiveLevel(st, { sessionId: meta?.id ?? "", cap: (meta?.cap as Level) ?? "full", sites: meta?.sites ?? [], url });
  return { origin: e.origin, policy: e.level, source: e.source };
}

export async function preapprovalsFor(url: string) {
  const o = originOf(url);
  const s = await getSettings();
  return (o && s.sites[o]?.preapproved) || {};
}
