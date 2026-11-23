// @vitest-environment happy-dom
// #21 Driver contract suite: the same behavioural tests run against the CDP
// driver (over a fake CDP tab serving recorded AX trees and scripted
// observations) and the lite driver (pagelib running in happy-dom).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import type { Observation } from "../src/background/autowait";
import { memoryStore, RefTable } from "../src/background/refs";
import { HTML, loadAx } from "./helpers";

vi.mock("../src/background/permissions", () => ({ effectivePolicy: async () => ({ origin: "http://x", policy: "full" }), requireSite: async () => {}, requireSensitive: async () => {} }));
vi.mock("../src/background/settings", () => ({ getSettings: async () => ({ showOverlay: false, liteSites: [], forceLite: false }) }));
vi.mock("../src/background/refstore", async () => {
  const { Baselines } = await import("../src/background/diff");
  const { RefTable, memoryStore } = await import("../src/background/refs");
  return { refTable: new RefTable(memoryStore()), baselines: new Baselines(), forgetTab: () => {} };
});
vi.mock("../src/background/cdp", () => ({ getCdpTab: () => null, peekCdpTab: () => null, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) }));

const { CdpDriver } = await import("../src/background/driver");
const { LiteDriver } = await import("../src/background/lite-driver");
type AnyDriver = InstanceType<typeof CdpDriver> | InstanceType<typeof LiteDriver>;

// ---------------------------------------------------------------------------
// layout stubs for happy-dom (no layout engine)
// ---------------------------------------------------------------------------
let coverer: Element | null = null;
let lastEl: Element | null = null;
function stubLayout() {
  const rect = (el: Element) => {
    const hidden = (el as HTMLElement).style?.display === "none" || el.closest("[hidden]");
    return hidden ? new DOMRect(0, 0, 0, 0) : new DOMRect(10, 10, 100, 20);
  };
  Element.prototype.getBoundingClientRect = function () {
    return rect(this);
  };
  Element.prototype.getClientRects = function () {
    lastEl = this;
    const r = rect(this);
    return (r.width ? [r] : []) as unknown as DOMRectList;
  };
  (document as any).elementFromPoint = () => coverer ?? lastEl ?? document.body;
  Object.defineProperty(HTMLElement.prototype, "innerText", { get() { return this.textContent ?? ""; }, configurable: true });
  (globalThis as any).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

// ---------------------------------------------------------------------------
// CDP fake: recorded AX tree for index.html + scripted pagelib answers
// ---------------------------------------------------------------------------
function fakeCdpTab(page: string) {
  const fx = loadAx(page);
  const state = { obs: {} as Partial<Observation>, removed: new Set<number>(), loader: "L1", calls: [] as string[] };
  const ok: Observation = { attached: true, visible: true, enabled: true, editable: true, box: { x: 10, y: 10, w: 100, h: 20 }, box2: { x: 10, y: 10, w: 100, h: 20 }, inView: true, point: { x: 60, y: 20 }, hit: { ok: true } };
  const tab: any = {
    tabId: 7,
    attached: true,
    userDetached: false,
    dialog: null,
    loaders: new Map([["|main", "L1"]]),
    lifecycle: [],
    navEpoch: 0,
    mainFrameId: "main",
    url: "http://x/" + page,
    onNavigated: () => () => {},
    ensure: async () => {},
    assertNoDialog: () => {},
    guard: <T>(p: Promise<T>) => p,
    detachedError: () => new TabAgentError("DEBUGGER_DETACHED", "gone"),
    mainKey: () => "|main",
    frames: async () => [{ key: "|main", frameId: "main", url: "http://x/" + page, loaderId: state.loader }],
    waitEvent: () => new Promise(() => {}),
    networkIdle: async () => true,
    send: async (m: string) => {
      state.calls.push(m);
      if (m === "Accessibility.getFullAXTree") return { nodes: fx.nodes.filter((n) => !state.removed.has(n.backendDOMNodeId!)) };
      return {};
    },
    pagelib: async (_fk: string, name: string, _args: unknown[], self?: number) => {
      state.calls.push(`pagelib:${name}`);
      if (self != null && state.removed.has(self)) throw new TabAgentError("REF_STALE", "Element is no longer in the page");
      if (name === "sensitiveInputs") return { value: [], nodes: [] };
      if (name === "observe") return { value: { ...ok, ...state.obs }, nodes: [] };
      if (name === "ownerMetrics") return { value: { rect: { left: 0, top: 0 }, clientLeft: 0, clientTop: 0, paddingLeft: 0, paddingTop: 0 }, nodes: [] };
      return { value: true, nodes: [] };
    },
  };
  return { tab, state };
}

// ---------------------------------------------------------------------------
// Lite env over happy-dom
// ---------------------------------------------------------------------------
function liteEnv() {
  const c = clock();
  return {
    exec: async (func: (...a: any[]) => any, args: unknown[]) => JSON.parse(JSON.stringify((await func(...args)) ?? null)),
    ensureLib: async () => {},
    tab: async () => ({ url: location.href, title: document.title, active: false, windowId: 1, status: "complete" }),
    navigate: async () => true,
    history: async () => true,
    captureVisible: async () => "",
    ...c,
  };
}

function loadHtml(page: string) {
  const html = readFileSync(join(HTML, `${page}.html`), "utf8");
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  document.title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
}

interface Harness {
  name: string;
  make(page: string): { drv: AnyDriver; disable(label: string): void; cover(label: string): void; remove(label: string): void; navigate(): void };
}

const harnesses: Harness[] = [
  {
    name: "cdp (fake)",
    make(page) {
      const { tab, state } = fakeCdpTab(page);
      const drv = new CdpDriver(tab, new RefTable(memoryStore()), clock());
      const nodeOf = (label: string) => loadAx(page).nodes.find((n) => n.name?.value === label)!.backendDOMNodeId!;
      return {
        drv,
        disable: () => (state.obs = { enabled: false }),
        cover: () => (state.obs = { hit: { ok: false, by: '<div#overlay.cookie-banner> "Cookies"' } }),
        remove: (label) => state.removed.add(nodeOf(label)),
        navigate: () => {
          state.loader = "L2";
          tab.loaders.set("|main", "L2");
        },
      };
    },
  },
  {
    name: "lite (happy-dom)",
    make(page) {
      loadHtml(page);
      const drv = new LiteDriver(7, new RefTable(memoryStore()), liteEnv() as any);
      const byText = (label: string) => [...document.querySelectorAll("button,a,input")].find((e) => (e.textContent ?? "").trim() === label || e.getAttribute("aria-label") === label)!;
      return {
        drv,
        disable: (label) => ((byText(label) as HTMLButtonElement).disabled = true),
        cover: () => {
          coverer = document.createElement("div");
          coverer.id = "overlay";
          coverer.className = "cookie-banner";
          document.body.appendChild(coverer);
        },
        remove: (label) => byText(label).remove(),
        navigate: () => {
          // a new document: the lite content script reports a different docId
          (globalThis as any).__ta = undefined;
          vi.resetModules();
        },
      };
    },
  },
];

beforeAll(async () => {
  stubLayout();
  await import("../src/pagelib/index");
});
beforeEach(() => {
  coverer = null;
});

for (const H of harnesses) {
  describe(`Driver contract: ${H.name}`, () => {
    it("snapshot format: same text format, interactive nodes carry e<N> refs", async () => {
      const { drv } = H.make("index");
      const r = await drv.snapshot({});
      expect(r.text).toMatch(/- button "Click me" \[ref=e\d+\]/);
      expect(r.text).toMatch(/- link "Form" \[ref=e\d+\]/);
      expect(r.text).toMatch(/- heading "TabAgent fixtures" level=1/);
      expect(r.text).toMatch(/- searchbox "Search" \[ref=e\d+\] value=""/);
      expect(r.text).not.toMatch(/heading .*\[ref=/);
    });

    it("ref stability: the same node keeps its ref", async () => {
      const { drv } = H.make("index");
      const a = await drv.snapshot({});
      const b = await drv.snapshot({});
      expect(b.text).toBe(a.text);
    });

    it("REF_STALE: unknown ref, removed node", async () => {
      const h = H.make("index");
      await expect(h.drv.click("e999")).rejects.toMatchObject({ code: "REF_STALE" });
      const s = await h.drv.snapshot({});
      const ref = s.text.match(/button "Click me" \[ref=(e\d+)\]/)![1];
      h.remove("Click me");
      await expect(h.drv.click(ref, { timeout: 200 })).rejects.toMatchObject({ code: "REF_STALE" });
    });

    it("auto-wait reasons: disabled and covered", async () => {
      const h = H.make("index");
      const s = await h.drv.snapshot({});
      const ref = s.text.match(/button "Click me" \[ref=(e\d+)\]/)![1];
      h.disable("Click me");
      const e1 = await h.drv.click(ref, { timeout: 200 }).catch((e) => e);
      expect(e1.code).toBe("NOT_ACTIONABLE");
      expect(e1.message).toContain("reason: disabled");
      const h2 = H.make("index");
      const s2 = await h2.drv.snapshot({});
      const ref2 = s2.text.match(/button "Click me" \[ref=(e\d+)\]/)![1];
      h2.cover("Click me");
      const e2 = await h2.drv.click(ref2, { timeout: 200 }).catch((e) => e);
      expect(e2.code).toBe("NOT_ACTIONABLE");
      expect(e2.message).toContain("reason: covered");
      expect(e2.message).toContain("cookie-banner");
    });

    it("page.find mints refs from the same table as the snapshot", async () => {
      const { drv } = H.make("index");
      const s = await drv.snapshot({});
      const ref = s.text.match(/button "Click me" \[ref=(e\d+)\]/)![1];
      if (H.name.startsWith("cdp")) return; // fake CDP has no DOM to search; covered by e2e
      const f = await drv.find({ by: "role", value: "button", name: "Click me" });
      expect(f.matches[0].ref).toBe(ref);
    });
  });
}

describe("lite driver specifics", () => {
  it("unsupported tools return UNSUPPORTED without touching the page", async () => {
    loadHtml("index");
    const env = liteEnv() as any;
    const exec = vi.fn(env.exec);
    const drv = new LiteDriver(7, new RefTable(memoryStore()), { ...env, exec });
    await expect(drv.upload()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(drv.evaluate()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(drv.handleDialog()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(drv.screenshot({ target: "ref", ref: "e1" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(drv.screenshot({ target: "full" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(exec).not.toHaveBeenCalled();
    // D10: a background tab is never focused for a viewport capture
    await expect(drv.screenshot({})).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("masks password values and fills through the native setter", async () => {
    loadHtml("masked");
    (document.getElementById("pw") as HTMLInputElement).value = "hunter2";
    const drv = new LiteDriver(7, new RefTable(memoryStore()), liteEnv() as any);
    const s = await drv.snapshot({});
    expect(s.text).toMatch(/textbox "Password" \[ref=e\d+\] value="••••"/);
    expect(s.text).not.toContain("hunter2");
    const user = s.text.match(/textbox "Username" \[ref=(e\d+)\]/)![1];
    const seen: string[] = [];
    document.getElementById("user")!.addEventListener("input", (e) => seen.push((e.target as HTMLInputElement).value));
    await drv.fill(user, "trinity");
    expect((document.getElementById("user") as HTMLInputElement).value).toBe("trinity");
    expect(seen).toEqual(["trinity"]);
  });
});

describe("lite DOM walker vs CDP goldens (interactive nodes)", () => {
  // Documented differences: the walker's accessible-name computation is simplified
  // (no CSS-generated content, date inputs are plain textboxes, no options for
  // closed <select>s); the sets below are compared on role + name of interactive lines.
  const interactive = (t: string) =>
    t
      .split("\n")
      .filter((l) => l.includes("[ref="))
      .map((l) => l.trim().replace(/ \[ref=e\d+\].*$/, ""))
      .sort();
  for (const page of ["index", "masked", "checkout", "modal", "drag", "shadow"]) {
    it(page, async () => {
      loadHtml(page);
      const drv = new LiteDriver(7, new RefTable(memoryStore()), liteEnv() as any);
      const lite = (await drv.snapshot({})).text;
      const golden = readFileSync(join(__dirname, "goldens", `${page}.interactive.txt`), "utf8");
      if (page === "shadow") {
        // shadow content is created by script, which loadHtml strips: only the heading appears
        expect(lite).toContain('heading "Shadow DOM"');
        return;
      }
      expect(interactive(lite)).toEqual(interactive(golden));
    });
  }
});
