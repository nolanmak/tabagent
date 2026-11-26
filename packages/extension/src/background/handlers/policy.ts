import { applyDenylistChanges, validateDenylistChanges } from "../../pure/denylistChange";
import { getSettings, updateSettings } from "../settings";
import { TabAgentError } from "@tabagent/protocol";

const snapshot = (denylist: readonly string[]) => [...denylist].map((glob) => glob.trim().toLowerCase()).filter(Boolean).sort().join("\u0000");

/** The router has already obtained the one-time visible category-p approval. */
export const policyHandlers = {
  "policy.denylist_change": async ({ p, policySnapshot }: any) => {
    const changes = validateDenylistChanges(p.changes);
    const current = await getSettings();
    if (typeof policySnapshot === "string" && snapshot(current.denylist) !== policySnapshot) {
      throw new TabAgentError("BAD_REQUEST", "The denylist changed while this approval was pending; submit a new exact request.");
    }
    const result = applyDenylistChanges(current.denylist, changes);
    if (result.applied.length) await updateSettings({ denylist: result.denylist });
    return { status: "applied", ...result };
  },
};
