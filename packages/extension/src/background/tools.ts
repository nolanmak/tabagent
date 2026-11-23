// Tool handlers. One per registry entry in @tabagent/protocol.
import { originOf, TabAgentError, type Level, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { sleep } from "./cdp";
import { CdpDriver, driverFor, type Driver } from "./driver";
import { downloadsSince, noteAction } from "./downloads";
import { dialogHandlers } from "./handlers/dialog";
import { devHandlers } from "./handlers/dev";
import { extractHandlers } from "./handlers/extract";
import { fileHandlers } from "./handlers/files";
import { formHandlers } from "./handlers/forms";
import { checkClickGate, checkKeyGate } from "./handlers/gates";
import { effectivePolicy, requireSensitive, requireSite } from "./permissions";
import { addTab, endSession, newTab, ownerOf, resolveTab, type Session } from "./sessions";
import { getSettings } from "./settings";

export interface Ctx {
  s: Session;
  meta: SessionMeta;
  p: any;
  tool: ToolDef;
}

type Handler = (c: Ctx) => Promise<unknown>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function tabUrl(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return t.pendingUrl || t.url || "";
}

export interface TabCtx {
  tabId: number;
  url: string;
  drv: Driver;
}

const locks = new Map<number, Promise<unknown>>();
/** Serialise commands per tab. */
export async function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(tabId, chain);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(tabId) === chain) locks.delete(tabId);
  }
}

export async function onTab<T>(c: Ctx, level: Level | null, fn: (t: TabCtx) => Promise<T>, opts: { create?: boolean; lock?: boolean } = {}): Promise<T> {
  const tabId = await resolveTab(c.s, c.p.tabId, opts.create);
  const run = async () => {
    const url = await tabUrl(tabId);
    if (level) await requireSite(c.meta, url, level, c.tool.name, summaryFor(c));
    const drv = await driverFor(tabId, url);
    return fn({ tabId, url, drv });
  };
  // Waiting tools must not hold the tab lock, or the action they wait on could never run.
  return opts.lock === false ? run() : withTabLock(tabId, run);
}

function summaryFor(c: Ctx): string {
  const p = c.p ?? {};
  switch (c.tool.name) {
    case "nav.goto":
      return `open ${p.url}`;
    case "act.click":
      return `click ${p.ref}`;
    case "act.type":
      return `type into ${p.ref ?? "focused element"}`;
    case "form.fill":
      return `fill ${Object.keys(p.fields ?? {}).join(", ")}`;
    default:
      return c.tool.name;
  }
}

export function cdp(drv: Driver): CdpDriver {
  if (drv instanceof CdpDriver) return drv;
  throw new TabAgentError("BAD_REQUEST", "This tool needs full (debugger) mode; the site is in lite mode", "Remove the site from Lite sites in the TabAgent side panel.");
}

export async function titleOf(tabId: number) {
  return (await chrome.tabs.get(tabId)).title ?? "";
}

/** Shared post-action reporting: navigation, dialogs, downloads, snapshot diff. */
async function afterAction(c: Ctx, t: TabCtx, beforeEpoch: number, started: number, early: { dialog?: unknown } = {}, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ok: true, ...extra };
  if (early.dialog || t.drv.dialog()) {
    out.dialog = early.dialog ?? t.drv.dialog();
    out.hint = "A JavaScript dialog is open. Call dialog.handle (accept=true|false) before anything else.";
    return out;
  }
  await t.drv.settle(beforeEpoch);
  const url = await t.drv.currentUrl();
  out.url = url;
  if (t.drv.dialog()) {
    out.dialog = t.drv.dialog();
    out.hint = "A JavaScript dialog is open. Call dialog.handle first.";
    return out;
  }
  const navigated = stripHash(url) !== stripHash(t.url) || t.drv.navEpoch() !== beforeEpoch;
  if (navigated) {
    out.navigated = true;
    out.title = await titleOf(t.tabId);
    out.hint = "Page changed. Take a page.snapshot to see it.";
  } else if (t.drv.hasSnapshot()) {
    try {
      const d = await t.drv.diffSinceLast();
      if (d) out.snapshotDiff = d.added || d.removed ? d.text : "(no changes in the accessibility snapshot)";
    } catch {
      /* page busy */
    }
  }
  const dls = downloadsSince(c.meta.id, started);
  if (dls.length) out.downloads = dls.map((d) => ({ id: d.id, url: d.url, filename: d.filename, state: d.state }));
  return out;
}

function stripHash(u: string) {
  return u.split("#")[0];
}

export async function act<T>(c: Ctx, level: Level, fn: (t: TabCtx) => Promise<{ dialog?: unknown } | void | T>, extra?: (r: any) => Record<string, unknown>) {
  noteAction(c.meta.id);
  return onTab(c, level, async (t) => {
    const before = t.drv.navEpoch();
    const started = Date.now();
    const r = (await fn(t)) as any;
    return afterAction(c, t, before, started, r && typeof r === "object" && "dialog" in r ? r : {}, extra ? extra(r) : {});
  });
}

async function waitUntil(fn: () => Promise<boolean>, timeout: number, every = 150): Promise<boolean> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* navigating */
    }
    if (Date.now() > end) return false;
    await sleep(every);
  }
}

function matchUrl(url: string, pattern: string) {
  const m = pattern.match(/^\/(.+)\/([dgimsuy]*)$/);
  if (m && (m[2] || /[\\^$.*+?()[\]{}|]/.test(m[1]))) {
    try {
      return new RegExp(m[1], m[2].replace("g", "")).test(url);
    } catch {
      /* treat as substring */
    }
  }
  return url.includes(pattern);
}

// ---------------------------------------------------------------------------
// select / check shared by act.* and form.fill
// ---------------------------------------------------------------------------
async function doSelect(t: TabCtx, ref: string, values: string[], timeout?: number) {
  const inf = (await t.drv.call("info", [], { ref })) as { isSelect: boolean; role: string };
  if (inf.isSelect) {
    const r = (await t.drv.call("selectOptions", [values], { ref })) as { selected?: string[]; error?: string };
    if (r.error) throw new TabAgentError("NOT_FOUND", r.error);
    return r.selected;
  }
  // ARIA combobox/listbox: open then click options
  const picked: string[] = [];
  await t.drv.click(ref, { timeout });
  for (const v of values) {
    let found: any = null;
    const ok = await waitUntil(async () => {
      const res = (await t.drv.callAllFrames("find", [{ role: "option", name: v, limit: 5 }])) as any[];
      for (const fr of res) {
        const m = fr.value.matches.find((x: any) => x.visible);
        if (m) {
          found = m;
          return true;
        }
      }
      return false;
    }, timeout ?? 3000);
    if (!ok || !found) throw new TabAgentError("NOT_FOUND", `No visible option "${v}" after opening ${ref}`, "Take a page.snapshot to see the options, then act.click the option.");
    await t.drv.click(found.ref, { timeout });
    picked.push(found.name);
  }
  return picked;
}

async function doCheck(t: TabCtx, ref: string, checked: boolean, timeout?: number) {
  const cur = (await t.drv.call("getChecked", [], { ref })) as boolean | null;
  if (cur === checked) return { checked, changed: false };
  const inf = (await t.drv.call("info", [], { ref })) as { visible: boolean };
  try {
    if (!inf.visible) throw new TabAgentError("NOT_ACTIONABLE", `${ref} is not visible`);
    await t.drv.click(ref, { timeout: timeout ?? 2000 });
  } catch (e) {
    if (e instanceof TabAgentError && e.code === "NOT_ACTIONABLE") {
      const lab = (await t.drv.call("labelFor", [], { ref })) as { ref: string } | null;
      if (!lab?.ref) throw e;
      await t.drv.click(lab.ref, { timeout });
    } else throw e;
  }
  await sleep(50);
  const after = (await t.drv.call("getChecked", [], { ref })) as boolean | null;
  if (after !== null && after !== checked) throw new TabAgentError("NOT_ACTIONABLE", `${ref} did not change to checked=${checked}`, "The page may control this input; try act.click on its visible label.");
  return { checked: after ?? checked, changed: true };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
export const handlers: Record<string, Handler> = {
  async tabs(c) {
    const { action, tabId, url } = c.p;
    switch (action) {
      case "list": {
        const tabs = [];
        for (const id of c.s.tabIds) {
          try {
            const t = await chrome.tabs.get(id);
            tabs.push({ tabId: id, url: t.url, title: t.title, active: id === c.s.active });
          } catch {
            /* gone */
          }
        }
        return { tabs };
      }
      case "new": {
        if (url) await requireSite(c.meta, url, "read", "tabs", `open ${url}`);
        const t = await newTab(c.s, "about:blank");
        if (url) {
          const drv = await driverFor(t.id!, url);
          const r = await drv.navigate(url, "load", 30000);
          return { tabId: t.id, ...r, title: await titleOf(t.id!) };
        }
        return { tabId: t.id, url: "about:blank" };
      }
      case "select": {
        const id = await resolveTab(c.s, tabId);
        c.s.active = id;
        await chrome.tabs.update(id, { active: true });
        return { tabId: id, url: await tabUrl(id), title: await titleOf(id) };
      }
      case "close": {
        const id = await resolveTab(c.s, tabId);
        await chrome.tabs.remove(id);
        return { closed: id };
      }
      case "attach": {
        if (tabId == null) throw new TabAgentError("BAD_REQUEST", "tabs action=attach needs tabId", "Ask the user which tab, or list them with chrome tab ids.");
        const o = ownerOf(tabId);
        if (o === c.meta.id) return { tabId, attached: true };
        if (o) throw new TabAgentError("TAB_BUSY", `Tab ${tabId} belongs to another agent session`);
        const url = await tabUrl(tabId);
        const title = await titleOf(tabId);
        await requireSensitive(c.meta, url, "tabs", `take over your tab "${title.slice(0, 60)}"`, ["Adopting a tab you opened gives the agent your page and its sign-ins"], "attach");
        await addTab(c.s, tabId);
        return { tabId, url, title, attached: true };
      }
    }
    throw new TabAgentError("BAD_REQUEST", `Unknown tabs action ${action}`);
  },

  async "nav.goto"(c) {
    const { url, waitUntil = "load", timeout = 30000 } = c.p;
    let target = url as string;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = "https://" + target;
    noteAction(c.meta.id);
    await requireSite(c.meta, target, "read", c.tool.name, `open ${target}`);
    const tabId = await resolveTab(c.s, c.p.tabId, true);
    return withTabLock(tabId, async () => {
      const drv = await driverFor(tabId, target);
      const r = await drv.navigate(target, waitUntil, timeout);
      return { ...r, title: await titleOf(tabId) };
    });
  },

  async "nav.back"(c) {
    return onTab(c, "read", async (t) => {
      await t.drv.history("back", 10000);
      return { url: await t.drv.currentUrl(), title: await titleOf(t.tabId) };
    });
  },
  async "nav.forward"(c) {
    return onTab(c, "read", async (t) => {
      await t.drv.history("forward", 10000);
      return { url: await t.drv.currentUrl(), title: await titleOf(t.tabId) };
    });
  },
  async "nav.reload"(c) {
    return onTab(c, "read", async (t) => {
      await t.drv.history("reload", 15000);
      return { url: await t.drv.currentUrl(), title: await titleOf(t.tabId) };
    });
  },

  async "nav.wait"(c) {
    const { for: kind, value, timeout = 5000 } = c.p;
    return onTab(c, "read", async (t) => {
      const started = Date.now();
      let ok = false;
      switch (kind) {
        case "load":
          ok = await t.drv.waitLoad(timeout);
          break;
        case "networkidle":
          ok = await t.drv.networkIdle(500, timeout);
          break;
        case "selector":
          if (!value) throw new TabAgentError("BAD_REQUEST", "nav.wait selector needs value");
          ok = await waitUntil(async () => !!(await t.drv.call("waitSelector", [value])), timeout);
          break;
        case "text":
          if (!value) throw new TabAgentError("BAD_REQUEST", "nav.wait text needs value");
          ok = await waitUntil(async () => !!(await t.drv.call("waitText", [value])), timeout);
          break;
        case "url":
          if (!value) throw new TabAgentError("BAD_REQUEST", "nav.wait url needs value");
          ok = await waitUntil(async () => matchUrl(await t.drv.currentUrl(), value), timeout, 100);
          break;
        case "fn":
          if (!value) throw new TabAgentError("BAD_REQUEST", "nav.wait fn needs value (a JS expression, evaluated in an isolated world with DOM access)");
          if (t.drv.kind !== "cdp") throw new TabAgentError("BAD_REQUEST", "nav.wait fn needs full mode");
          ok = await waitUntil(async () => !!(await t.drv.evaluate(`!!(${value})`, "isolated")), timeout);
          break;
      }
      if (!ok) throw new TabAgentError("TIMEOUT", `Timed out after ${timeout}ms waiting for ${kind}${value ? ` "${value}"` : ""}`, "Take a page.snapshot to see the current state.");
      return { ok: true, waitedMs: Date.now() - started, url: await t.drv.currentUrl() };
    }, { lock: false });
  },

  async "page.snapshot"(c) {
    return onTab(c, "read", async (t) => {
      const r = await t.drv.snapshot({ mode: c.p.mode, root: c.p.root, maxTokens: c.p.maxTokens, diff: c.p.diff });
      const head = { url: await t.drv.currentUrl(), title: await titleOf(t.tabId) };
      if (c.p.diff && r.diff) return { ...head, diff: r.diff.added || r.diff.removed ? r.diff.text : "(no changes)", added: r.diff.added, removed: r.diff.removed };
      return { ...head, snapshot: r.snapshot, refs: r.refs, ...(r.truncated ? { truncated: true } : {}) };
    });
  },

  async "page.screenshot"(c) {
    return onTab(c, "read", async (t) => {
      const img = await t.drv.screenshot({ fullPage: c.p.fullPage, ref: c.p.ref, marks: c.p.marks, format: c.p.format });
      return { image: { data: img.data, mimeType: img.mimeType }, width: img.width, height: img.height, url: await t.drv.currentUrl() };
    });
  },

  async "page.find"(c) {
    const q = { text: c.p.text, role: c.p.role, name: c.p.name, label: c.p.label, css: c.p.css, xpath: c.p.xpath, limit: c.p.limit ?? 20 };
    if (!q.text && !q.role && !q.label && !q.css && !q.xpath && !q.name) throw new TabAgentError("BAD_REQUEST", "page.find needs one of text, role, name, label, css, xpath");
    return onTab(c, "read", async (t) => {
      const res = (await t.drv.callAllFrames("find", [q])) as any[];
      const matches: any[] = [];
      let total = 0;
      for (const fr of res) {
        total += fr.value.total;
        for (const m of fr.value.matches) matches.push(fr.isMain ? m : { ...m, frame: fr.url });
      }
      return { total, matches: matches.slice(0, q.limit) };
    });
  },

  async "act.click"(c) {
    return act(c, "act", async (t) => {
      await checkClickGate(c, t, c.p.ref);
      return t.drv.click(c.p.ref, { button: c.p.button, clickCount: c.p.clickCount, modifiers: c.p.modifiers, timeout: c.p.timeout });
    });
  },
  async "act.dblclick"(c) {
    return act(c, "act", async (t) => {
      await checkClickGate(c, t, c.p.ref);
      return t.drv.click(c.p.ref, { clickCount: 2, timeout: c.p.timeout });
    });
  },
  async "act.hover"(c) {
    return act(c, "act", async (t) => {
      await t.drv.hover(c.p.ref, c.p.timeout);
    });
  },
  async "act.type"(c) {
    return act(c, "act", async (t) => {
      if (c.p.ref) {
        if (c.p.clear) await t.drv.fill(c.p.ref, "", c.p.timeout);
        else {
          if (t.drv instanceof CdpDriver) await t.drv.actionPoint(c.p.ref, { timeout: c.p.timeout, needEditable: true });
          await t.drv.focus(c.p.ref, true);
        }
      }
      const r = await t.drv.typeText(c.p.text);
      if (r.dialog) return r;
      if (c.p.submit) {
        await checkKeyGate(c, t, "Enter");
        return t.drv.press("Enter");
      }
      return r;
    });
  },
  async "act.fill"(c) {
    return act(c, "act", async (t) => {
      const inf = (await t.drv.call("info", [], { ref: c.p.ref })) as { isSelect: boolean; checked: boolean | null; role: string };
      if (inf.isSelect) {
        await doSelect(t, c.p.ref, [c.p.value], c.p.timeout);
        return;
      }
      await t.drv.fill(c.p.ref, c.p.value, c.p.timeout);
    });
  },
  async "act.press"(c) {
    return act(c, "act", async (t) => {
      if (c.p.ref) await t.drv.focus(c.p.ref, true);
      await checkKeyGate(c, t, c.p.key);
      return t.drv.press(c.p.key);
    });
  },
  async "act.select"(c) {
    let selected: unknown;
    return act(
      c,
      "act",
      async (t) => {
        selected = await doSelect(t, c.p.ref, c.p.values, c.p.timeout);
      },
      () => ({ selected }),
    );
  },
  async "act.check"(c) {
    let res: unknown;
    return act(
      c,
      "act",
      async (t) => {
        res = await doCheck(t, c.p.ref, c.p.checked ?? true, c.p.timeout);
      },
      () => ({ result: res }),
    );
  },
  async "act.scroll"(c) {
    return onTab(c, "read", async (t) => ({ ok: true, position: await t.drv.scroll(c.p.ref, c.p.dx ?? 0, c.p.dy ?? 0) }));
  },
  async "act.drag"(c) {
    return act(c, "act", async (t) => {
      await t.drv.drag(c.p.from, c.p.to, c.p.timeout);
    });
  },
  async "session.info"(c) {
    const tabs = [];
    for (const id of c.s.tabIds) {
      try {
        const t = await chrome.tabs.get(id);
        const drv = await driverFor(id, t.url ?? "");
        tabs.push({ tabId: id, url: t.url, title: t.title, mode: drv.kind, active: id === c.s.active });
      } catch {
        /* gone */
      }
    }
    const s = await getSettings();
    return { id: c.meta.id, label: c.meta.label, cap: c.meta.cap, sites: c.meta.sites, tabs, paused: s.paused, groupId: c.s.groupId };
  },
  async "session.permissions"(c) {
    let url = c.p.url as string | undefined;
    if (!url) {
      const id = await resolveTab(c.s, undefined).catch(() => null);
      url = id != null ? await tabUrl(id) : "about:blank";
    }
    const e = await effectivePolicy(url);
    const s = await getSettings();
    return { url, origin: e.origin, policy: e.policy, source: e.source, sensitivePreapproved: !!(e.origin && s.sensitiveAllowed[e.origin]), tokenCap: c.meta.cap, tokenSites: c.meta.sites };
  },
  async "session.end"(c) {
    await endSession(c.meta.id);
    return { ended: true };
  },
  ...formHandlers,
  ...extractHandlers,
  ...devHandlers,
  ...fileHandlers,
  ...dialogHandlers,
};
