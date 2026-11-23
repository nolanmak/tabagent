// cookies.get scope (#18, D18d): only the tab's current origin.
import { TabAgentError } from "@tabagent/protocol";

function origin(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.origin : null;
  } catch {
    return null;
  }
}

/** The URL to read cookies for; another origin's URL is PERMISSION_DENIED. */
export function cookieUrlFor(tabUrl: string, requested: string | undefined): string {
  const own = origin(tabUrl);
  if (!own) throw new TabAgentError("BAD_REQUEST", "cookies.get needs a tab on an http(s) page");
  if (!requested) return tabUrl;
  const want = origin(requested);
  if (want !== own) throw new TabAgentError("PERMISSION_DENIED", `cookies.get only reads the tab's current origin (${own})`, "Navigate the tab to that site first.");
  return requested;
}
