// Handlers owned by #5: `tabs` (list/new/select/close/attach) and session.*.
// The router has already validated params, resolved/authorized the tab and run
// the attach (f) gate, so these handlers only do the work.
import { TabAgentError, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { driverFor } from "./driver";
import { effectivePolicy, preapprovalsFor } from "./permissions";
import { addTab, endSession, newTab, ownerOf, resolveTab, selectTab, userActiveTab, type Session } from "./sessions";
import { getSettings } from "./settings";

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

/** Resolve the tabs attach target for the router (throws TAB_BUSY / NOT_FOUND). */
export async function attachTarget(meta: SessionMeta, tabId: number | undefined): Promise<{ tabId: number; url: string; title: string }> {
  let id = tabId;
  if (id == null) {
    const t = await userActiveTab();
    if (!t?.id) throw new TabAgentError("NOT_FOUND", "No active tab in the last-focused window", "Ask the user to focus the tab to share, or pass tabId.");
    id = t.id;
  }
  const o = ownerOf(id);
  if (o && o !== meta.id) throw new TabAgentError("TAB_BUSY", `Tab ${id} belongs to another agent session`);
  let info: { url: string; title: string };
  try {
    info = await tabInfo(id);
  } catch {
    throw new TabAgentError("NOT_FOUND", `No tab ${id}`);
  }
  return { tabId: id, ...info };
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
            tabs.push({ tabId: id, ...t, active: id === c.s.active, attached: c.s.attached.includes(id) });
          } catch {
            /* gone */
          }
        }
        return { tabs };
      }
      case "new": {
        const t = await newTab(c.s, "about:blank");
        if (url) {
          const drv = await driverFor(t.id!, url);
          const r = await drv.navigate(url, "load", 30000);
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
      case "attach": {
        const id = c.p.tabId as number;
        if (ownerOf(id) === c.meta.id) return { tabId: id, attached: true, ...(await tabInfo(id)) };
        await addTab(c.s, id, { attached: true });
        return { tabId: id, attached: true, ...(await tabInfo(id)) };
      }
    }
    throw new TabAgentError("BAD_REQUEST", `Unknown tabs action ${action}`);
  },

  async "session.permissions"(c) {
    let url = c.p.url as string | undefined;
    if (!url) {
      const id = await resolveTab(c.s, undefined).catch(() => null);
      url = id != null ? (await tabInfo(id)).url : "about:blank";
    }
    const e = await effectivePolicy(url, c.meta);
    return { url, origin: e.origin, level: e.policy, policy: e.policy, source: e.source, preapproved: await preapprovalsFor(url), tokenCap: c.meta.cap, tokenSites: c.meta.sites };
  },

  async "session.info"(c) {
    const tabs = [];
    for (const id of c.s.tabIds) {
      try {
        const t = await tabInfo(id);
        tabs.push({ tabId: id, ...t, active: id === c.s.active, attached: c.s.attached.includes(id) });
      } catch {
        /* gone */
      }
    }
    const s = await getSettings();
    return { id: c.meta.id, label: c.meta.label, cap: c.meta.cap, sites: c.meta.sites, tabs, paused: s.paused, groupId: c.s.groupId };
  },

  async "session.end"(c) {
    await endSession(c.meta.id);
    return { ended: true };
  },
};
