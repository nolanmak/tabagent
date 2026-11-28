// Send to agent tab grant (docs/specs/agent-inbox.md AD11): may this tab be attached to this session? Pure.
// A user-initiated Send is the attach consent, so there is no prompt; everything else still holds. Site
// policy and the D18 gates are checked as usual on the agent's first action, not here.
import type { AgentGrantCode } from "@tabagent/protocol";
import { hostMatches, hostOf, isBlank } from "../background/policy";

export interface GrantFacts {
  /** The session the tab would join. */
  sessionId: string;
  /** The session's token site globs (empty = no extra limit). */
  sites: readonly string[];
  /** Kill switch. */
  paused: boolean;
  /** A private sign-in tab (M6). */
  isPrivate: boolean;
  /** Handed to the user (auth.handoff). */
  inHandoff: boolean;
  /** The session that owns the tab now, if any (D9). */
  owner: string | undefined;
  /** The tab's URL, or null when the tab is gone. */
  url: string | null;
}

/** The refusal code, or null when the grant may go ahead. */
export function grantRefusal(f: GrantFacts): AgentGrantCode | null {
  if (f.paused) return "PAUSED";
  if (f.isPrivate) return "PERMISSION_DENIED";
  if (f.inHandoff) return "TAB_BUSY";
  if (f.owner && f.owner !== f.sessionId) return "TAB_BUSY";
  if (f.url == null) return "NOT_FOUND";
  // A token-scoped session cannot use a tab outside its sites, so it is never handed one.
  if (f.sites.length && !isBlank(f.url) && !f.sites.some((g) => hostMatches(g, hostOf(f.url!)))) return "PERMISSION_DENIED";
  return null;
}
