// dialog.handle (#27, D28). The state machine is ../../pure/dialogs; capture.ts feeds it.
import { TabAgentError } from "@tabagent/protocol";
import { tabState } from "../capture";
import { getCdpTab, sleep } from "../cdp";
import { requireSite } from "../permissions";
import { resolveTab } from "../sessions";
import type { Ctx } from "./ctx";

type Handler = (c: Ctx) => Promise<unknown>;

export const dialogHandlers: Record<string, Handler> = {
  async "dialog.handle"(c) {
    const action: "accept" | "dismiss" = c.p.action ?? (c.p.accept === false ? "dismiss" : "accept");
    const tabId = await resolveTab(c.s, c.p.tabId);
    const t = await chrome.tabs.get(tabId);
    const url = t.pendingUrl || t.url || "";
    await requireSite(c.meta, url, "act", c.tool.name, `${action} a dialog`);
    if (!tabState(tabId).dialogs.current()) throw new TabAgentError("NOT_FOUND", "No dialog is open on this tab");
    await getCdpTab(tabId).ensure();
    const dialog = await tabState(tabId).dialogs.handle(action, c.p.promptText);
    await sleep(100);
    return { dialog, action };
  },
};
