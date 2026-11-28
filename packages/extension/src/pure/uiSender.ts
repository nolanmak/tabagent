/**
 * The UI API gate. The side panel and the prompt window are the only callers of ui.* messages
 * (approve prompts, change settings, resume after a kill). Content scripts, other extensions and the
 * bridge never pass it, which is what keeps Resume panel-only (#106).
 */
export interface SenderLike {
  id?: string;
  url?: string;
}

export function isPanelSender(sender: SenderLike | undefined, runtimeId: string, extensionBaseUrl: string): boolean {
  return !!sender && sender.id === runtimeId && typeof sender.url === "string" && sender.url.startsWith(extensionBaseUrl);
}
