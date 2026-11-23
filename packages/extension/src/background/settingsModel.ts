// Pure settings model: defaults, validation and migration from the spike's shape.
import type { PreapprovableCategory, SiteEntry, StoredPolicy } from "./policy";

export type OnSessionEnd = "collapse" | "close" | "keep";
export type BeforeUnload = "accept" | "dismiss" | "ask-agent";

/** Editable seeded denylist: password managers, Google sign-in and banks (D32, #12). The Web Store is hard-denied separately. */
export const SEEDED_DENYLIST = [
  "*.1password.com",
  "*.lastpass.com",
  "*.bitwarden.com",
  "*.dashlane.com",
  "*.keepersecurity.com",
  "accounts.google.com",
  "*.chase.com",
  "*.bankofamerica.com",
  "*.wellsfargo.com",
  "*.citi.com",
  "*.capitalone.com",
  "*.mercury.com",
  "*.paypal.com",
];

export const DEFAULT_PORT = 47615;

export interface StoredShape {
  port: number;
  secret: string | null;
  sites: Record<string, SiteEntry>;
  denylist: string[];
  devAllowSensitive: boolean;
  onSessionEnd: OnSessionEnd;
  beforeUnload: BeforeUnload;
  showOverlay: boolean;
  forceLite: boolean;
  liteSites: string[];
}

export const DEFAULTS: StoredShape = {
  port: DEFAULT_PORT,
  secret: null,
  sites: {},
  denylist: SEEDED_DENYLIST,
  devAllowSensitive: false,
  onSessionEnd: "collapse",
  beforeUnload: "accept",
  showOverlay: true,
  forceLite: false,
  liteSites: [],
};

const POLICIES = new Set(["read", "act", "full", "deny"]);
const CATS: PreapprovableCategory[] = ["a", "b", "c", "d", "e"];

function cleanEntry(e: unknown): SiteEntry | null {
  if (!e || typeof e !== "object") return null;
  const x = e as Record<string, unknown>;
  const out: SiteEntry = {};
  if (typeof x.policy === "string" && POLICIES.has(x.policy)) out.policy = x.policy as StoredPolicy;
  if (x.lite === true) out.lite = true;
  if (x.preapproved && typeof x.preapproved === "object") {
    const p: Partial<Record<PreapprovableCategory, true>> = {};
    for (const c of CATS) if ((x.preapproved as Record<string, unknown>)[c] === true) p[c] = true;
    if (Object.keys(p).length) out.preapproved = p;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalise anything stored (or patched) into the current shape.
 * Old keys: policies{origin: level|"ask"}, sensitiveAllowed{origin: true}, autoAcceptBeforeUnload.
 */
export function migrateSettings(raw: Record<string, unknown> | undefined | null): StoredShape {
  const r = (raw ?? {}) as Record<string, any>;
  const sites: Record<string, SiteEntry> = {};
  for (const [o, e] of Object.entries((r.sites ?? {}) as Record<string, unknown>)) {
    const c = cleanEntry(e);
    if (c) sites[o] = c;
  }
  if (r.policies && typeof r.policies === "object") {
    for (const [o, p] of Object.entries(r.policies as Record<string, string>)) {
      if (POLICIES.has(p)) sites[o] = { ...sites[o], policy: p as StoredPolicy };
    }
  }
  if (r.sensitiveAllowed && typeof r.sensitiveAllowed === "object") {
    for (const [o, v] of Object.entries(r.sensitiveAllowed as Record<string, boolean>)) {
      if (v) sites[o] = { ...sites[o], preapproved: { a: true, b: true, c: true, d: true, e: true } };
    }
  }
  const beforeUnload: BeforeUnload = ["accept", "dismiss", "ask-agent"].includes(r.beforeUnload) ? r.beforeUnload : typeof r.autoAcceptBeforeUnload === "boolean" ? (r.autoAcceptBeforeUnload ? "accept" : "dismiss") : DEFAULTS.beforeUnload;
  return {
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULTS.port,
    secret: typeof r.secret === "string" && r.secret ? r.secret : null,
    sites,
    denylist: Array.isArray(r.denylist) ? r.denylist.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : DEFAULTS.denylist.slice(),
    devAllowSensitive: r.devAllowSensitive === true,
    onSessionEnd: ["collapse", "close", "keep"].includes(r.onSessionEnd) ? r.onSessionEnd : DEFAULTS.onSessionEnd,
    beforeUnload,
    showOverlay: typeof r.showOverlay === "boolean" ? r.showOverlay : DEFAULTS.showOverlay,
    forceLite: r.forceLite === true,
    liteSites: Array.isArray(r.liteSites) ? r.liteSites.filter((x: unknown) => typeof x === "string") : [],
  };
}
