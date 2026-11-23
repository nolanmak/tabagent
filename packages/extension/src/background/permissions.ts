// Permission gate (D17 interim). The pure policy is policy.ts; this module reads
// the settings it needs and exposes authorize / requireSite / requireSensitive.
// Enforced here, in the extension, never in the bridge (D1). #12 and #13 replace
// the policy behind these functions; callers do not change.
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { effectiveLevel, resolve, type Level, type PolicyState, type SensitiveCategory } from "./policy";
import { getSettings } from "./settings";

const err = (code: string, message: string, hint?: string) => new TabAgentError(code as any, message, hint);

async function policyState(): Promise<PolicyState> {
  const s = await getSettings();
  return { devAllowSensitive: s.devAllowSensitive };
}

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

/** Allow, or throw PERMISSION_DENIED. Never prompts before #12. */
export async function authorize(g: GateRequest): Promise<void> {
  const d = resolve(await policyState(), { url: g.url, level: g.level, sensitive: g.sensitive });
  if (d.decision === "deny") throw err(d.code, d.message, d.hint);
}

/** Ensure the session may use `level` on `url`. */
export async function requireSite(meta: SessionMeta, url: string, level: Level, tool: string, summary: string): Promise<void> {
  return authorize({ meta, url, level, tool, summary, reasons: [] });
}

/** Sensitive gate (D18): refused unless devAllowSensitive (D17). */
export async function requireSensitive(meta: SessionMeta, url: string, category: SensitiveCategory, tool: string, summary: string, reasons: string[], opts?: { tabId?: number }): Promise<void> {
  return authorize({ meta, url, level: null, sensitive: category, tool, summary, reasons, tabId: opts?.tabId });
}

/** Effective access for display (session.permissions). */
export async function effectivePolicy(url: string): Promise<{ origin: string | null; policy: string; source: string; sensitiveAllowed: boolean }> {
  const e = effectiveLevel(await policyState(), url);
  return { origin: e.origin, policy: e.level, source: e.source, sensitiveAllowed: e.sensitiveAllowed };
}
