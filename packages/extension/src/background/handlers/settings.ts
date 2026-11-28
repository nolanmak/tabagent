// settings.get (#105) and settings.change (#106). Neither prompts: one reads an allowlisted snapshot,
// the other writes only the preference keys from the protocol's PREFERENCE_SCHEMA. Both are audited
// by the router like every tool call; settings.change also reports what it changed.
import { checkPreferenceChanges } from "@tabagent/protocol";
import { applyPreferences, settingsSnapshot } from "../../pure/settingsView";
import { getStoredSettings, updateSettings } from "../settings";

export const settingsHandlers = {
  "settings.get": async () => settingsSnapshot(await getStoredSettings()),
  "settings.change": async ({ p }: { p: { changes?: unknown } }) => {
    const changes = checkPreferenceChanges(p.changes);
    const { patch, applied } = applyPreferences(await getStoredSettings(), changes);
    if (applied.length) await updateSettings(patch);
    return { status: "applied" as const, applied };
  },
};
