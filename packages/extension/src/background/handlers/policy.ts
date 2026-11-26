import { applyDenylistChanges, validateDenylistChanges } from "../../pure/denylistChange";
import { getSettings, updateSettings } from "../settings";

/** The router has already obtained the one-time visible category-p approval. */
export const policyHandlers = {
  "policy.denylist_change": async ({ p }: any) => {
    const changes = validateDenylistChanges(p.changes);
    const current = await getSettings();
    const result = applyDenylistChanges(current.denylist, changes);
    if (result.applied.length) await updateSettings({ denylist: result.denylist });
    return result;
  },
};
