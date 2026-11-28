// Agent-visible extension settings (#105, #106). The preference schema here is the one place that
// lists what `settings.change` may set; the extension's settings model normalises with the same enums.
import { z } from "zod";
import { TabAgentError } from "./errors";

export const ON_SESSION_END = ["collapse", "close", "keep"] as const;
export const BEFORE_UNLOAD = ["accept", "dismiss", "ask-agent"] as const;
export const SITE_POLICY_CHOICES = ["ask", "read", "act", "full", "deny"] as const;

/** A host glob as the lite-mode list stores it: `example.com` or `*.example.com`. */
const hostGlob = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i, { message: "Expected a host or *.host glob" });

/**
 * The only settings an agent may change without the user's approval (#106). None of them widens what
 * an agent can do: they change how TabAgent shows and cleans up after agents, or force the
 * (less capable) lite driver. Everything else is rejected by checkPreferenceChanges.
 */
export const PREFERENCE_SCHEMA = {
  showOverlay: z.boolean(),
  beforeUnload: z.enum(BEFORE_UNLOAD),
  onSessionEnd: z.enum(ON_SESSION_END),
  forceLite: z.boolean(),
  liteSites: z.array(hostGlob).max(100),
};
export type PreferenceKey = keyof typeof PREFERENCE_SCHEMA;
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_SCHEMA) as PreferenceKey[];
export type PreferenceChanges = { [K in PreferenceKey]?: z.infer<(typeof PREFERENCE_SCHEMA)[K]> };

/** Params schema for settings.change: unknown keys pass validation so the handler can answer with a hint. */
export const PREFERENCE_CHANGES = z.looseObject(Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, PREFERENCE_SCHEMA[k].optional()])) as { [K in PreferenceKey]: z.ZodOptional<(typeof PREFERENCE_SCHEMA)[K]> });

const MODE_HINT = "Request policy.mode_change: turning it off applies at once; turning it on needs the user's approval in the TabAgent side panel.";
/** Settings that exist but are not preferences, and where an agent should go instead. */
const PROTECTED: Record<string, { code: "PERMISSION_DENIED"; hint: string }> = {
  yolo: { code: "PERMISSION_DENIED", hint: MODE_HINT },
  devAllowSensitive: { code: "PERMISSION_DENIED", hint: MODE_HINT },
  yoloExpiresAt: { code: "PERMISSION_DENIED", hint: MODE_HINT },
  denylist: { code: "PERMISSION_DENIED", hint: "Request policy.denylist_change; the user approves it in the side panel." },
  sites: { code: "PERMISSION_DENIED", hint: "Request policy.site_change for one origin; the user approves it in the side panel." },
  paused: { code: "PERMISSION_DENIED", hint: "Stop agents with session.kill_all. Resume is panel-only: ask the user to press Resume in the TabAgent side panel." },
  secret: { code: "PERMISSION_DENIED", hint: "Pairing is managed in the side panel and with `tabagent pair`." },
  port: { code: "PERMISSION_DENIED", hint: "The port is set when pairing (`tabagent config set port`)." },
};

/**
 * Validate a settings.change request: only PREFERENCE_KEYS, each with a value the panel could set.
 * Escalating or protected keys are refused with a pointer to the right tool; unknown keys list the allowed ones.
 */
export function checkPreferenceChanges(changes: unknown): PreferenceChanges {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TabAgentError("BAD_REQUEST", "settings.change needs a changes object", `Allowed keys: ${PREFERENCE_KEYS.join(", ")}`);
  const keys = Object.keys(changes);
  for (const k of keys) {
    if ((PREFERENCE_KEYS as string[]).includes(k)) continue;
    const p = Object.hasOwn(PROTECTED, k) ? PROTECTED[k] : undefined;
    if (p) throw new TabAgentError(p.code, `settings.change cannot set ${k}`, p.hint);
    throw new TabAgentError("BAD_REQUEST", `settings.change has no setting ${JSON.stringify(k.slice(0, 64))}`, `Allowed keys: ${PREFERENCE_KEYS.join(", ")}`);
  }
  if (!keys.length) throw new TabAgentError("BAD_REQUEST", "settings.change needs at least one setting to change", `Allowed keys: ${PREFERENCE_KEYS.join(", ")}`);
  const r = z.object(PREFERENCE_SCHEMA).partial().strict().safeParse(changes);
  if (!r.success) throw new TabAgentError("BAD_REQUEST", `Invalid settings.change value: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data as PreferenceChanges;
}

/** settings.get result: built from an explicit allowlist, never the pairing secret, tokens or account ids. */
export const SETTINGS_SNAPSHOT = z.object({
  denylist: z.array(z.string()),
  sites: z.record(
    z.string(),
    z.object({
      policy: z.enum(SITE_POLICY_CHOICES),
      auth: z.boolean(),
      lite: z.boolean(),
      preapproved: z.array(z.string()).optional(),
      /** How many saved accounts the user said "Always" to; the ids are never returned. */
      alwaysAccounts: z.number().optional(),
    }),
  ),
  yolo: z.boolean(),
  /** Epoch ms when YOLO switches itself off (policy.mode_change durationMin); absent = no expiry. */
  yoloExpiresAt: z.number().optional(),
  devAllowSensitive: z.boolean(),
  onSessionEnd: z.enum(ON_SESSION_END),
  beforeUnload: z.enum(BEFORE_UNLOAD),
  showOverlay: z.boolean(),
  forceLite: z.boolean(),
  liteSites: z.array(z.string()),
  authDenyHosts: z.array(z.string()),
  vaultDenyHosts: z.array(z.string()),
});
export type SettingsSnapshot = z.infer<typeof SETTINGS_SNAPSHOT>;
