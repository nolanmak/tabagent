// Tool handlers. One per registry entry in @tabagent/protocol.
import { originOf, TabAgentError, type Level, type SessionMeta, type ToolDef } from "@tabagent/protocol";
import { sleep } from "./cdp";
import { CdpDriver, driverFor, type Driver } from "./driver";
import { downloadsSince, getDownload, noteAction, sessionDownloads, waitDownload } from "./downloads";
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

interface TabCtx {
  tabId: number;
  url: string;
  drv: Driver;
}

const locks = new Map<number, Promise<unknown>>();
/** Serialise commands per tab. */
async function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
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

async function onTab<T>(c: Ctx, level: Level | null, fn: (t: TabCtx) => Promise<T>, opts: { create?: boolean; lock?: boolean } = {}): Promise<T> {
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

function cdp(drv: Driver): CdpDriver {
  if (drv instanceof CdpDriver) return drv;
  throw new TabAgentError("BAD_REQUEST", "This tool needs full (debugger) mode; the site is in lite mode", "Remove the site from Lite sites in the TabAgent side panel.");
}

async function titleOf(tabId: number) {
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

async function act<T>(c: Ctx, level: Level, fn: (t: TabCtx) => Promise<{ dialog?: unknown } | void | T>, extra?: (r: any) => Record<string, unknown>) {
  noteAction(c.meta.id);
  return onTab(c, level, async (t) => {
    const before = t.drv.navEpoch();
    const started = Date.now();
    const r = (await fn(t)) as any;
    return afterAction(c, t, before, started, r && typeof r === "object" && "dialog" in r ? r : {}, extra ? extra(r) : {});
  });
}

async function checkClickSensitive(c: Ctx, t: TabCtx, ref: string) {
  const cs = (await t.drv.call("clickSensitivity", [], { ref })) as { label: string; reasons: string[] };
  if (cs.reasons.length) await requireSensitive(c.meta, t.url, c.tool.name, `click "${cs.label.slice(0, 60)}"`, cs.reasons);
}

async function checkKeySensitive(c: Ctx, t: TabCtx, key: string) {
  if (!/enter/i.test(key)) return;
  const ks = (await t.drv.call("keySensitivity", [key])) as { reasons: string[] };
  if (ks.reasons.length) await requireSensitive(c.meta, t.url, c.tool.name, `press ${key}`, ks.reasons);
}

function toCsv(headers: string[], rows: Record<string, string>[]) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n");
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

  async "page.text"(c) {
    return onTab(c, "read", async (t) => t.drv.call("text", [], c.p.ref ? { ref: c.p.ref } : {}));
  },

  async "page.markdown"(c) {
    return onTab(c, "read", async (t) => t.drv.call("markdown", [c.p.maxChars ?? 20000]));
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
      await checkClickSensitive(c, t, c.p.ref);
      return t.drv.click(c.p.ref, { button: c.p.button, clickCount: c.p.clickCount, modifiers: c.p.modifiers, timeout: c.p.timeout });
    });
  },
  async "act.dblclick"(c) {
    return act(c, "act", async (t) => {
      await checkClickSensitive(c, t, c.p.ref);
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
        await checkKeySensitive(c, t, "Enter");
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
      await checkKeySensitive(c, t, c.p.key);
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
  async "act.upload"(c) {
    return act(
      c,
      "act",
      async (t) => {
        await t.drv.upload(c.p.ref, c.p.paths);
      },
      () => ({ files: c.p.paths.length }),
    );
  },

  async "form.describe"(c) {
    return onTab(c, "read", async (t) => {
      if (c.p.ref) return t.drv.call("describeForm", [], { ref: c.p.ref });
      const res = (await t.drv.callAllFrames("describeForm", [])) as any[];
      const forms: any[] = [];
      const fields: any[] = [];
      for (const fr of res) {
        for (const f of fr.value.forms) forms.push(fr.isMain ? f : { ...f, frame: fr.url });
        for (const f of fr.value.fields) fields.push(fr.isMain ? f : { ...f, frame: fr.url });
      }
      return { forms, fields, count: fields.length };
    });
  },

  async "form.fill"(c) {
    const fields = c.p.fields as Record<string, string | boolean | string[]>;
    const results: any[] = [];
    return act(
      c,
      "act",
      async (t) => {
        // keys that are refs resolve directly; the rest go through label matching
        const byRef: [string, any][] = [];
        const byLabel: Record<string, any> = {};
        for (const [k, v] of Object.entries(fields)) (/^[el]\d+$/.test(k) ? byRef.push([k, v]) : (byLabel[k] = v));
        let plan: any[] = [];
        if (Object.keys(byLabel).length) {
          const opts = c.p.ref ? { ref: c.p.ref } : {};
          plan = (await t.drv.call("planFill", [byLabel], opts)) as any[];
          // if nothing matched in the main frame, try iframes
          if (!c.p.ref && plan.every((p) => p.status === "error")) {
            const all = (await t.drv.callAllFrames("planFill", [byLabel])) as any[];
            const best = all.map((f) => f.value as any[]).sort((a, b) => a.filter((p) => p.status === "error").length - b.filter((p) => p.status === "error").length)[0];
            if (best) plan = best;
          }
        }
        for (const [ref, v] of byRef) {
          const inf = (await t.drv.call("info", [], { ref })) as any;
          const kind = inf.isSelect || inf.role === "combobox" || inf.role === "listbox" ? "select" : inf.checked !== null && (inf.type === "checkbox" || inf.role === "checkbox" || inf.role === "switch") ? "checkbox" : inf.type === "radio" || inf.role === "radio" ? "radio" : inf.isFile ? "file" : "text";
          plan.push({ key: ref, ref, kind });
        }
        for (const item of plan) {
          if (item.status === "error") {
            results.push({ field: item.key, ok: false, error: item.error });
            continue;
          }
          const v = fields[item.key];
          try {
            switch (item.kind) {
              case "text":
                await t.drv.fill(item.ref, Array.isArray(v) ? v.join(", ") : String(v));
                break;
              case "select":
                await doSelect(t, item.ref, Array.isArray(v) ? v : [String(v)]);
                break;
              case "checkbox":
                await doCheck(t, item.ref, v === true || v === "true" || v === "on" || v === "yes");
                break;
              case "radio":
                await doCheck(t, item.ref, true);
                break;
              case "file":
                throw new TabAgentError("BAD_REQUEST", "File inputs need act.upload");
            }
            results.push({ field: item.key, ok: true, ref: item.ref });
          } catch (e) {
            results.push({ field: item.key, ok: false, ref: item.ref, error: (e as Error).message });
          }
        }
      },
      () => ({ fields: results, filled: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }),
    );
  },

  async "form.submit"(c) {
    return act(c, "act", async (t) => {
      const f = (await t.drv.call("formFor", [], c.p.ref ? { ref: c.p.ref } : {})) as { ref: string; submitRef: string | null; sensitive: string[] } | null;
      if (!f) throw new TabAgentError("NOT_FOUND", "No form found", "Pass ref of the form or a field inside it.");
      const reasons = [...f.sensitive];
      let label = "form";
      if (f.submitRef) {
        const cs = (await t.drv.call("clickSensitivity", [], { ref: f.submitRef })) as { label: string; reasons: string[] };
        label = cs.label || label;
        for (const r of cs.reasons) if (!reasons.some((x) => r.includes(x))) reasons.push(r);
      }
      if (reasons.length) await requireSensitive(c.meta, t.url, c.tool.name, `submit "${label.slice(0, 60)}"`, reasons);
      if (f.submitRef) return t.drv.click(f.submitRef);
      await t.drv.call("requestSubmit", [], { ref: f.ref });
    });
  },

  async "extract.table"(c) {
    return onTab(c, "read", async (t) => {
      const r = (await t.drv.call("extractTable", [c.p.index], c.p.ref ? { ref: c.p.ref } : {})) as any;
      if (r.error) throw new TabAgentError("NOT_FOUND", r.error);
      if (c.p.format === "csv") return { csv: toCsv(r.headers, r.rows), count: r.count, tableIndex: r.tableIndex, totalTables: r.totalTables };
      return r;
    });
  },
  async "extract.links"(c) {
    return onTab(c, "read", async (t) => t.drv.call("extractLinks", [c.p.filter, c.p.limit ?? 200]));
  },
  async "extract.schema"(c) {
    return onTab(c, "read", async (t) => {
      const r = (await t.drv.call("extractSchema", [c.p.schema, c.p.hint])) as any;
      if (r.error) throw new TabAgentError("NOT_FOUND", r.error);
      return r;
    });
  },
  async "extract.paginate"(c) {
    const { extractor, schema, hint, nextText, nextSelector, maxPages = 5 } = c.p;
    if (extractor === "schema" && !schema) throw new TabAgentError("BAD_REQUEST", "extractor=schema needs schema");
    return onTab(c, "read", async (t) => {
      const rows: unknown[] = [];
      const seen = new Set<string>();
      const urls: string[] = [];
      let stopped = "maxPages reached";
      for (let page = 1; page <= maxPages; page++) {
        await t.drv.waitLoad(10000);
        urls.push(await t.drv.currentUrl());
        let items: unknown[] = [];
        if (extractor === "table") {
          const r = (await t.drv.call("extractTable", [undefined])) as any;
          if (r.error) {
            stopped = r.error;
            break;
          }
          items = r.rows;
        } else if (extractor === "links") items = ((await t.drv.call("extractLinks", [undefined, 500])) as any).links;
        else {
          const r = (await t.drv.call("extractSchema", [schema, hint])) as any;
          if (r.error) {
            stopped = r.error;
            break;
          }
          items = Array.isArray(r.data) ? r.data : [r.data];
        }
        let fresh = 0;
        for (const it of items) {
          const k = JSON.stringify(it);
          if (!seen.has(k)) {
            seen.add(k);
            rows.push(it);
            fresh++;
          }
        }
        if (page === maxPages) break;
        if (page > 1 && fresh === 0) {
          stopped = "no new rows on page";
          break;
        }
        const nx = (await t.drv.call("nextLink", [nextText, nextSelector])) as { ref: string } | null;
        if (!nx?.ref) {
          stopped = "no next link";
          break;
        }
        await requireSite(c.meta, t.url, "act", c.tool.name, "click Next to paginate");
        const before = t.drv.navEpoch();
        await t.drv.click(nx.ref);
        await t.drv.settle(before, 10000);
        await sleep(200);
      }
      return { rows, count: rows.length, pages: urls.length, urls, stopped };
    });
  },

  async "js.eval"(c) {
    return onTab(c, "full", async (t) => {
      await requireSensitive(c.meta, t.url, c.tool.name, `run JavaScript: ${String(c.p.expression).slice(0, 120)}`, ["Runs code in the page with access to its data"]);
      const value = await t.drv.evaluate(c.p.expression, c.p.world ?? "main");
      let out = value;
      const s = JSON.stringify(value);
      if (s && s.length > 50000) out = s.slice(0, 50000) + "… [truncated]";
      return { value: out };
    });
  },

  async "console.list"(c) {
    return onTab(c, "read", async (t) => {
      const tab = cdp(t.drv).tab;
      await tab.ensure();
      let list = tab.consoleLog;
      if (c.p.level) list = list.filter((e) => e.level === c.p.level || (c.p.level === "error" && /error|assert/.test(e.level)));
      const limit = c.p.limit ?? 50;
      return { messages: list.slice(-limit), total: list.length };
    });
  },
  async "network.list"(c) {
    return onTab(c, "read", async (t) => {
      const tab = cdp(t.drv).tab;
      await tab.ensure();
      let list = [...tab.network.entries()].map(([k, e]) => ({ requestId: k, method: e.method, url: e.url, status: e.status, type: e.resourceType, mimeType: e.mimeType, failed: e.failed, finished: e.finished }));
      if (c.p.url) list = list.filter((e) => matchUrl(e.url, c.p.url));
      if (c.p.method) list = list.filter((e) => e.method.toUpperCase() === String(c.p.method).toUpperCase());
      if (c.p.status) list = list.filter((e) => e.status === c.p.status);
      if (c.p.resourceType) list = list.filter((e) => (e.type ?? "").toLowerCase() === String(c.p.resourceType).toLowerCase());
      const limit = c.p.limit ?? 50;
      return { requests: list.slice(-limit), total: list.length };
    });
  },
  async "network.get"(c) {
    return onTab(c, "full", async (t) => {
      const tab = cdp(t.drv).tab;
      const e = tab.network.get(c.p.requestId) ?? [...tab.network.values()].find((x) => x.requestId === c.p.requestId);
      if (!e) throw new TabAgentError("NOT_FOUND", `No request ${c.p.requestId}`, "Use network.list to get requestIds.");
      let body: string | undefined;
      let base64 = false;
      try {
        const r = await tab.send<any>("Network.getResponseBody", { requestId: e.requestId }, e.sessionId);
        body = r.body;
        base64 = r.base64Encoded;
      } catch (err) {
        body = undefined;
        void err;
      }
      if (body && body.length > 100_000) body = body.slice(0, 100_000) + "… [truncated]";
      return { ...e, body, base64Encoded: base64 || undefined };
    });
  },
  async "network.waitFor"(c) {
    return onTab(c, "read", async (t) => {
      const tab = cdp(t.drv).tab;
      await tab.ensure();
      const ev = await tab.waitEvent((m, p) => m === "Network.responseReceived" && matchUrl(p.response.url, c.p.url), c.p.timeout ?? 10000);
      if (!ev) throw new TabAgentError("TIMEOUT", `No response matching ${c.p.url}`);
      const key = `${ev.sessionId ?? ""}:${ev.params.requestId}`;
      return { requestId: key, url: ev.params.response.url, status: ev.params.response.status, mimeType: ev.params.response.mimeType };
    }, { lock: false });
  },
  async "dialog.handle"(c) {
    const tabId = await resolveTab(c.s, c.p.tabId);
    const url = await tabUrl(tabId);
    await requireSite(c.meta, url, "act", c.tool.name, "answer a dialog");
    const drv = await driverFor(tabId, url);
    const d = await drv.handleDialog(c.p.accept, c.p.promptText);
    await sleep(100);
    return { handled: d, accepted: c.p.accept };
  },
  async "cookies.get"(c) {
    return onTab(c, "full", async (t) => {
      const url = c.p.url ?? t.url;
      if (c.p.url) await requireSite(c.meta, c.p.url, "full", c.tool.name, "read cookies");
      await requireSensitive(c.meta, url, c.tool.name, `read cookies for ${originOf(url)}`, ["Cookies can include session credentials"]);
      const cookies = await chrome.cookies.getAll({ url });
      return { cookies: cookies.map((k) => ({ name: k.name, value: k.value, domain: k.domain, path: k.path, httpOnly: k.httpOnly, secure: k.secure, expires: k.expirationDate })) };
    });
  },
  async "storage.get"(c) {
    return onTab(c, "full", async (t) => {
      await requireSensitive(c.meta, t.url, c.tool.name, `read ${c.p.kind}Storage`, ["Web storage can include tokens"]);
      return t.drv.call("storage", [c.p.kind]);
    });
  },

  async "downloads.list"(c) {
    return { downloads: sessionDownloads(c.meta.id) };
  },
  async "downloads.wait"(c) {
    const d = await waitDownload(c.meta.id, c.p.id, c.p.timeout ?? 30000);
    if (!d) throw new TabAgentError("TIMEOUT", "No download completed in time");
    return d;
  },
  async "downloads.read"(c) {
    const d = getDownload(c.p.id);
    if (!d || d.sessionId !== c.meta.id) throw new TabAgentError("NOT_FOUND", `Download ${c.p.id} is not from this session`);
    if (d.state !== "complete") throw new TabAgentError("BAD_REQUEST", `Download ${c.p.id} is ${d.state}`, "Use downloads.wait first.");
    await requireSensitive(c.meta, d.url, c.tool.name, `read downloaded file ${d.filename.split(/[\\/]/).pop()}`, ["Gives the agent the file's contents"]);
    return { __bridgeRead: { path: d.filename, mime: d.mime, maxBytes: c.p.maxBytes ?? 1_000_000 }, id: d.id, filename: d.filename, mime: d.mime, bytes: d.bytes };
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
};
