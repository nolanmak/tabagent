// Handler for `tabs` (list/new/select/close). The router has already validated
// params and run authorize(), so this handler only does the work.
import { TabAgentError, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { navigate } from "./handlers/nav";
import { newTab, resolveTab, selectTab, type Session } from "./sessions";

interface Ctx {
  s: Session;
  meta: SessionMeta;
  p: any;
  tool: ToolDef;
  tabId?: number;
  url?: string;
}

async function tabInfo(id: number) {
  const t = await chrome.tabs.get(id);
  return { url: t.pendingUrl || t.url || "", title: t.title ?? "" };
}

export const sessionHandlers: Record<string, (c: Ctx) => Promise<unknown>> = {
  async tabs(c) {
    const { action, url } = c.p;
    switch (action) {
      case "list": {
        const tabs = [];
        for (const id of c.s.tabIds) {
          try {
            const t = await tabInfo(id);
            tabs.push({ tabId: id, ...t, active: id === c.s.active });
          } catch {
            /* gone */
          }
        }
        return { tabs };
      }
      case "new": {
        const t = await newTab(c.s, "about:blank");
        if (url) {
          const r = await navigate(t.id!, url, "load", 30000);
          return { tabId: t.id, ...r, title: (await tabInfo(t.id!)).title };
        }
        return { tabId: t.id, url: "about:blank" };
      }
      case "select": {
        const id = await selectTab(c.s, c.p.tabId);
        return { tabId: id, ...(await tabInfo(id)) };
      }
      case "close": {
        const id = await resolveTab(c.s, c.p.tabId);
        await chrome.tabs.remove(id);
        return { closed: id };
      }
    }
    throw new TabAgentError("BAD_REQUEST", `Unknown tabs action ${action}`);
  },
};
