import { applyDenylistChanges, validateDenylistChanges } from "../../pure/denylistChange";
import { applySiteChange, checkSiteChange, normalizeSiteOrigin, siteChangeSnapshot, type SiteChanges } from "../../pure/siteChange";
import { checkModeChange, modeChangeSnapshot, type ModeChangeParams } from "../../pure/modeChange";
import { getSettings, settingsNow, updateSettings } from "../settings";
import { TabAgentError } from "@tabagent/protocol";

const snapshot = (denylist: readonly string[]) => [...denylist].map((glob) => glob.trim().toLowerCase()).filter(Boolean).sort().join("\u0000");
const STALE = (what: string) => new TabAgentError("BAD_REQUEST", `The ${what} changed while this approval was pending; submit a new exact request.`);

/**
 * Router hook, before the prompt: refuse requests that cross a hard boundary (so the user is never
 * asked about them) and snapshot the state the prompt is shown against.
 */
export async function policyPrecheck(tool: string, p: Record<string, unknown>): Promise<string | undefined> {
  const current = await getSettings();
  if (tool === "policy.denylist_change") return snapshot(current.denylist);
  if (tool === "policy.site_change") {
    const { origin } = checkSiteChange(current, String(p.origin ?? ""), p.changes as SiteChanges);
    return siteChangeSnapshot(current, origin);
  }
  if (tool === "policy.mode_change") {
    checkModeChange(current, p as ModeChangeParams, settingsNow());
    return modeChangeSnapshot(current);
  }
  return undefined;
}

/**
 * The router has already obtained the one-time visible category-p approval, except for
 * policy.mode_change requests that only turn modes off (#109), which need none.
 */
export const policyHandlers = {
  "policy.denylist_change": async ({ p, policySnapshot }: any) => {
    const changes = validateDenylistChanges(p.changes);
    const current = await getSettings();
    if (typeof policySnapshot === "string" && snapshot(current.denylist) !== policySnapshot) throw STALE("denylist");
    const result = applyDenylistChanges(current.denylist, changes);
    if (result.applied.length) await updateSettings({ denylist: result.denylist });
    return { status: "applied", ...result };
  },
  "policy.site_change": async ({ p, policySnapshot }: any) => {
    const current = await getSettings();
    // Fail closed: without the pre-prompt snapshot there is no proof the user saw this state.
    if (typeof policySnapshot !== "string") throw STALE("site settings");
    const origin = normalizeSiteOrigin(p.origin);
    if (siteChangeSnapshot(current, origin) !== policySnapshot) throw STALE("site settings");
    checkSiteChange(current, origin, p.changes);
    const result = applySiteChange(current.sites, origin, p.changes, !!current.yolo);
    await updateSettings({ sites: result.sites });
    return { status: "applied", origin, site: result.site, applied: result.applied };
  },
  "policy.mode_change": async ({ p, policySnapshot }: any) => {
    const current = await getSettings();
    // Duration starts now, at approval; the expiry alarm follows the stored timestamp (index.ts).
    const { next, applied, needsApproval } = checkModeChange(current, p as ModeChangeParams, settingsNow());
    // Fail closed: turning a mode on needs proof the user approved exactly this state.
    if (needsApproval && (typeof policySnapshot !== "string" || modeChangeSnapshot(current) !== policySnapshot)) throw STALE("YOLO or developer mode setting");
    await updateSettings({ ...next });
    return { status: "applied", ...next, applied };
  },
};
