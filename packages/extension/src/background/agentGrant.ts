// Send to agent tab grant, worker side (docs/specs/agent-inbox.md AD11; amends D9/D18f). A user-initiated
// Send is the attach consent: the tab joins the linked agent's session with no `tabs attach` prompt. Only
// the attach is granted; site policy, token cap/sites and the D18 gates still apply on every later command.
// grantTab is called only from the agent.grant handler in index.ts (a unit test enforces that).
import { TabAgentError, type AgentGrantCode, type SessionMeta } from "@tabagent/protocol";
import { grantRefusal } from "../pure/grant";
import { addTab, getSession, inHandoff, isPrivateTab, ownerOf, releaseAttachedTab, restoreSessions } from "./sessions";
import { isPaused } from "./settings";

export type GrantReply = { ok: true; added: boolean } | { ok: false; code: AgentGrantCode };

const KNOWN: readonly string[] = ["TAB_BUSY", "PERMISSION_DENIED", "NOT_FOUND"];

async function tabUrl(tabId: number): Promise<string | null> {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.pendingUrl || t.url || "";
  } catch {
    return null;
  }
}

/** getSession(meta) then addTab(..., {attached: true, makeActive: true}), or a refusal code. Never prompts. */
export async function grantTab(meta: SessionMeta, tabId: number): Promise<GrantReply> {
  await restoreSessions();
  const code = grantRefusal({
    sessionId: meta.id,
    sites: meta.sites,
    paused: await isPaused(),
    isPrivate: isPrivateTab(tabId),
    inHandoff: inHandoff(tabId),
    owner: ownerOf(tabId),
    url: await tabUrl(tabId),
  });
  if (code) return { ok: false, code };
  const added = ownerOf(tabId) !== meta.id;
  try {
    const s = await getSession(meta);
    await addTab(s, tabId, { attached: true, makeActive: true });
    return { ok: true, added };
  } catch (e) {
    const c = e instanceof TabAgentError ? e.code : "";
    return { ok: false, code: (KNOWN.includes(c) ? c : "FAILED") as AgentGrantCode };
  }
}

/** agent.release: an expired send gives its granted tab back (ungrouped, never closed). */
export function releaseGrantedTab(sessionId: string, tabId: number): Promise<boolean> {
  return releaseAttachedTab(sessionId, tabId);
}
