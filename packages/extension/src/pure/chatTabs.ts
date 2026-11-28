// #151: clicking a session reuses that agent's chat tab when one is open. Pure.

/** The agent a chat page URL is for, or null when the URL is not this extension's chat page. */
export function chatAgentOf(url: string | undefined, base: string): string | null {
  if (!url || !url.startsWith(`${base}chat.html`)) return null;
  try {
    return new URL(url).searchParams.get("agent");
  } catch {
    return null;
  }
}

export function findChatTab<T extends { id?: number; url?: string; pendingUrl?: string }>(tabs: T[], base: string, agentId: string): T | null {
  return tabs.find((t) => t.id != null && chatAgentOf(t.pendingUrl || t.url, base) === agentId) ?? null;
}
