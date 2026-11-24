// TabAgent wire protocol + tool registry. Single source of truth for the MCP
// tool list, REST routes, CLI, and extension handlers. See docs/DESIGN.md and roadmap #28.
export * from "./errors";
export * from "./messages";
export * from "./registry";
export * from "./wrap";
export * from "./auth";
export * from "./auth-code";
export * from "./captcha";

// ---------------------------------------------------------------------------
// Site policy helpers (shared by extension engine + bridge token limits)
// ---------------------------------------------------------------------------

export type SitePolicy = "deny" | "read" | "act" | "full" | "ask";

/** Match a hostname against a glob like "*.github.com", "github.com", "*". */
export function hostMatches(glob: string, host: string): boolean {
  glob = glob.trim().toLowerCase();
  host = host.toLowerCase();
  if (glob === "*" || glob === "<all>") return true;
  if (glob.startsWith("*.")) {
    const base = glob.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === glob;
}

export const DEFAULT_DENYLIST = [
  "chromewebstore.google.com",
  "chrome.google.com",
  "*.1password.com",
  "*.lastpass.com",
  "*.bitwarden.com",
  "*.dashlane.com",
  "accounts.google.com",
  "*.chase.com",
  "*.bankofamerica.com",
  "*.wellsfargo.com",
  "*.mercury.com",
  "*.paypal.com",
];

/** Schemes the extension never touches. */
export function isRestrictedUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search):/i.test(url) && !/^about:blank/i.test(url);
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") return u.origin === "null" ? "file://" : u.origin;
    return null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Redaction for audit logs
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /pass(word)?|pwd|secret|token|card|cc-?num|cvv|cvc|ssn|social|pin\b|otp|iban|routing|account.?num/i;

export function redact(value: unknown, keyHint = ""): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(keyHint)) return "[redacted]";
    if (/^\d{13,19}$/.test(value.replace(/[\s-]/g, ""))) return "[redacted]"; // card-like
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(value)) return "[redacted]"; // ssn-like
    return value.length > 500 ? value.slice(0, 500) + "…" : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "data" && typeof v === "string" && v.length > 1000) {
        out[k] = `[${v.length} bytes]`;
        continue;
      }
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}
export const DEV_EXTENSION_ID = "pjpcgiijlaafoafgibplighdenoandid";
