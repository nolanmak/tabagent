// In-memory fake of the chrome.* surface the session + permission modules use.
type Listener = (...a: any[]) => void;
function event() {
  const ls = new Set<Listener>();
  return { addListener: (f: Listener) => void ls.add(f), removeListener: (f: Listener) => void ls.delete(f), fire: (...a: any[]) => ls.forEach((f) => f(...a)), listeners: ls };
}

function area() {
  let data: Record<string, unknown> = {};
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return structuredClone(data);
      const ks = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (o: Record<string, unknown>) => void (data = { ...data, ...structuredClone(o) }),
    setAccessLevel: async () => {},
    _reset: () => void (data = {}),
    _data: () => data,
  };
}

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  groupId: number;
  openerTabId?: number;
}

export function installChrome() {
  const tabs = new Map<number, FakeTab>();
  const groups = new Map<number, { id: number; title?: string; color?: string; collapsed?: boolean; windowId: number }>();
  let nextTab = 100;
  let nextGroup = 1;
  const calls: string[] = [];
  const ev = { tabsRemoved: event(), tabsCreated: event(), tabsUpdated: event(), navTarget: event(), storageChanged: event(), msg: event() };
  const c: any = {
    runtime: { sendMessage: async () => {}, onMessage: ev.msg, id: "ext", getURL: (p: string) => `chrome-extension://ext/${p}` },
    storage: { local: area(), session: area(), onChanged: ev.storageChanged },
    tabs: {
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      create: async (o: { url?: string; active?: boolean; windowId?: number }) => {
        calls.push(`tabs.create active=${o.active}`);
        const t: FakeTab = { id: nextTab++, windowId: o.windowId ?? 1, url: o.url ?? "about:blank", title: "", active: !!o.active, groupId: -1 };
        tabs.set(t.id, t);
        return { ...t };
      },
      update: async (id: number, o: any) => {
        calls.push(`tabs.update ${id} ${JSON.stringify(o)}`);
        Object.assign(tabs.get(id)!, o);
      },
      remove: async (ids: number | number[]) => {
        for (const id of ([] as number[]).concat(ids)) {
          tabs.delete(id);
          calls.push(`tabs.remove ${id}`);
        }
      },
      group: async (o: { groupId?: number; tabIds: number[] }) => {
        const gid = o.groupId ?? nextGroup++;
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: 1 });
        for (const id of o.tabIds) {
          tabs.get(id)!.groupId = gid;
          ev.tabsUpdated.fire(id, { groupId: gid });
        }
        return gid;
      },
      ungroup: async (ids: number | number[]) => {
        for (const id of ([] as number[]).concat(ids)) {
          const t = tabs.get(id);
          if (t) {
            t.groupId = -1;
            ev.tabsUpdated.fire(id, { groupId: -1 });
          }
          calls.push(`tabs.ungroup ${id}`);
        }
      },
      query: async () => [...tabs.values()],
      onRemoved: ev.tabsRemoved,
      onCreated: ev.tabsCreated,
      onUpdated: ev.tabsUpdated,
    },
    tabGroups: {
      get: async (id: number) => {
        const g = groups.get(id);
        if (!g) throw new Error("no group");
        return { ...g };
      },
      update: async (id: number, o: any) => Object.assign(groups.get(id)!, o),
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: "normal" }],
      create: async () => ({ id: 2 }),
      getLastFocused: async () => ({ id: 1, tabs: [...tabs.values()].filter((t) => t.windowId === 1) }),
      update: async (...a: any[]) => void calls.push(`windows.update ${JSON.stringify(a)}`),
    },
    webNavigation: { onCreatedNavigationTarget: ev.navTarget },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  (globalThis as any).chrome = c;
  return {
    chrome: c,
    tabs,
    groups,
    calls,
    ev,
    addUserTab(url: string, over: Partial<FakeTab> = {}) {
      const t: FakeTab = { id: nextTab++, windowId: 1, url, title: "User", active: false, groupId: -1, ...over };
      tabs.set(t.id, t);
      return t;
    },
  };
}
