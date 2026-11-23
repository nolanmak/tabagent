// Permission gate (D17). The pure policy is policy.ts; this module feeds it the
// settings and tab ownership and turns a deny into an error.
// Enforced here, in the extension, never in the bridge (D1).
import { TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { resolve, type Level, type SensitiveCategory, type TabOwnership } from "./policy";
import { ownerOf } from "./sessions";
import { getSettings } from "./settings";

export interface GateRequest {
  meta: SessionMeta | { id: string; label: string; cap: string; sites: string[] };
  url: string;
  level: Level | null;
  sensitive?: SensitiveCategory;
  tool: string;
  tabId?: number;
}

function ownership(sessionId: string, tabId: number | undefined): TabOwnership {
  if (tabId == null) return "none";
  const o = ownerOf(tabId);
  return o === sessionId ? "own" : o ? "other" : "nobody";
}

/** The router's authorize() chokepoint: throws PERMISSION_DENIED / NOT_FOUND / TAB_BUSY, else returns. */
export async function authorize(g: GateRequest): Promise<void> {
  const s = await getSettings();
  const d = resolve({ devAllowSensitive: s.devAllowSensitive }, { url: g.url, level: g.level, sensitive: g.sensitive, tab: ownership(g.meta.id, g.tabId) });
  if (d.decision === "deny") throw new TabAgentError(d.code, d.message, d.hint);
}
