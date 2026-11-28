// #33 step 1, before anything is asked of the bridge: https, auth enabled for the origin
// (sites[origin].auth, off by default), host not on the banking / password-manager list or the
// user's denylist. No prompt here: the category g gate prompts later, after accounts are known.
import { TabAgentError } from "@tabagent/protocol";
import { authEnabled, hostMatches } from "../../policy";

export interface SiteCheckState {
  sites: Record<string, { auth?: boolean; policy?: string } | undefined>;
  denylist: string[];
  authDenyHosts: string[];
}

export function checkAuthSite(st: SiteCheckState, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TabAgentError("PERMISSION_DENIED", "Sign-in needs a web page");
  }
  if (u.protocol !== "https:") throw new TabAgentError("PERMISSION_DENIED", "Sign-in is only done on https pages", "TabAgent never fills credentials into http pages (DA3).");
  const host = u.hostname;
  if (st.authDenyHosts.some((g) => hostMatches(g, host))) throw new TabAgentError("PERMISSION_DENIED", `TabAgent never signs in on ${host}`);
  if (st.denylist.some((g) => hostMatches(g, host))) throw new TabAgentError("PERMISSION_DENIED", `${host} is on the TabAgent denylist`, "The user can remove it from the denylist in the side panel.");
  const e = st.sites[u.origin];
  if (e?.policy === "deny") throw new TabAgentError("PERMISSION_DENIED", `${u.origin} is denied`);
  if (!authEnabled(e, u.origin)) throw new TabAgentError("PERMISSION_DENIED", `Sign-in is not enabled for ${u.origin}`, "The user can enable sign-in for this site in the TabAgent side panel.");
  return u.origin;
}
