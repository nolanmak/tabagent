// Handler plumbing with a fake Driver: D14 side effects via __side, D24 diffs,
// D28 DIALOG_OPEN, D18(a)(b) gates, #21 lite UNSUPPORTED sweep.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS, TabAgentError } from "@tabagent/protocol";

const state = vi.hoisted(() => ({ dialog: null as any, drv: null as any, sensitive: [] as any[], site: [] as any[], url: "http://x.test/a" }));

vi.mock("../src/background/sessions", () => ({ resolveTab: async (_s: unknown, id?: number) => id ?? 1 }));
vi.mock("../src/background/permissions", () => ({
  requireSite: async (...a: unknown[]) => {
    state.site.push(a);
  },
  requireSensitive: async (...a: unknown[]) => {
    state.sensitive.push(a);
  },
  effectivePolicy: async () => ({ policy: "full" }),
}));
vi.mock("../src/background/bridgeFiles", () => ({ resolveFiles: async (_id: string, p: string[]) => p }));
vi.mock("../src/background/downloads", () => ({ noteAction: () => {}, downloadsSince: () => [] }));
vi.mock("../src/background/cdp", () => ({ peekCdpTab: () => (state.dialog ? { dialog: state.dialog } : undefined), getCdpTab: () => null, sleep: async () => {} }));
vi.mock("../src/background/driver", () => ({ driverFor: async () => state.drv }));
vi.mock("../src/background/refstore", async () => {
  const { Baselines } = await import("../src/background/diff");
  return { baselines: new Baselines(), refTable: null, forgetTab: () => {} };
});
(globalThis as any).chrome = { tabs: { get: async () => ({ url: state.url, title: "T" }) } };

const { actHandlers } = await import("../src/background/handlers/act");
const { pageHandlers } = await import("../src/background/handlers/page");
const { navHandlers } = await import("../src/background/handlers/nav");
const { assertLiteSupport, assertNoDialog, levelOf } = await import("../src/background/tabctx");
const { baselines } = await import("../src/background/refstore");
const { authTaint } = await import("../src/background/authTaint");

function fakeDriver(kind: "cdp" | "lite" = "cdp") {
  const log: string[] = [];
  let snap = ["- main", '  - button "Go" [ref=e1]'];
  const d: any = {
    kind,
    tabId: 1,
    log,
    epoch: 0,
    url: "http://x.test/a",
    dlg: null,
    setSnap: (l: string[]) => (snap = l),
    snapshot: async () => ({ text: snap.join("\n"), lines: snap, refs: ["e1"], shown: [], truncated: false, collapsed: 0, omitted: 0, tokens: 1 }),
    find: async () => ({ matches: [], truncated: false }),
    call: async (fn: string) => {
      log.push(`call:${fn}`);
      if (fn === "clickGateInfo") return d.clickInfo ?? { role: "button", name: "Go" };
      if (fn === "keyGateInfo") return d.keyInfo ?? { inForm: false };
      if (fn === "info") return { isSelect: false, visible: true };
      return null;
    },
    click: async (ref: string) => {
      log.push(`click:${ref}`);
      d.onClick?.();
      return d.dlg ? { dialog: d.dlg } : {};
    },
    press: async (k: string) => (log.push(`press:${k}`), {}),
    typeText: async (t: string) => (log.push(`type:${t}`), {}),
    focus: async () => log.push("focus"),
    prepareInput: async () => log.push("prepare"),
    fill: async () => log.push("fill"),
    hover: async () => log.push("hover"),
    drag: async () => log.push("drag"),
    scroll: async () => ({ scrollX: 0, scrollY: 0 }),
    screenshot: async (o: any) => ({ mime: "image/png", dataBase64: "x", width: 1, height: 1, o }),
    navigate: async (u: string) => ((d.url = u), d.epoch++, { url: u }),
    history: async () => {},
    waitLoad: async () => true,
    networkIdle: async () => true,
    quiet: async () => log.push("quiet"),
    settle: async () => {},
    navEpoch: () => d.epoch,
    currentUrl: async () => d.url,
    dialog: () => d.dlg,
    evaluate: async () => true,
    evals: [] as string[],
    fnResult: false as unknown,
    onEval: undefined as undefined | (() => void),
    evaluator: () => async (expr: string) => {
      d.evals.push(expr);
      d.onEval?.();
      return d.fnResult;
    },
  };
  return d;
}

const ctx = (tool: string, p: Record<string, unknown> = {}) => ({ s: {} as any, meta: { id: "S", label: "t", cap: "full", sites: [] } as any, p, tool: TOOLS.find((t) => t.name === tool) as any });

beforeEach(() => {
  state.dialog = null;
  state.sensitive = [];
  state.site = [];
  state.drv = fakeDriver();
  baselines.clearTab(1);
});

describe("act.* through afterAction (D14/D24)", () => {
  it("no baseline -> no diff", async () => {
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(r.ok).toBe(true);
    expect(r.__side).toBeUndefined();
  });

  it("with a baseline: waits for DOM quiet, returns +/-/~ lines and advances the baseline", async () => {
    await pageHandlers["page.snapshot"](ctx("page.snapshot"));
    state.drv.onClick = () => state.drv.setSnap(["- main", '  - button "Gone" [ref=e1]', '  - link "New" [ref=e2]']);
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(state.drv.log).toContain("quiet");
    expect(r.__side.snapshotDiff).toBe('~ - button "Gone" [ref=e1]\n+ - link "New" [ref=e2]');
    const again: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(again.__side).toBeUndefined(); // unchanged page -> nothing reported
  });

  it("an action that navigates -> navigation set, no snapshotDiff, baseline cleared", async () => {
    await pageHandlers["page.snapshot"](ctx("page.snapshot"));
    state.drv.onClick = () => {
      state.drv.epoch++;
      state.drv.url = "http://x.test/b";
    };
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(r.__side.navigation).toEqual({ url: "http://x.test/b", title: "T", kind: "navigate" });
    expect(r.__side.snapshotDiff).toBeUndefined();
    expect(baselines.get("S", 1)).toBeUndefined();
  });

  it("an action that opens a dialog -> dialogs set, no diff (D28)", async () => {
    await pageHandlers["page.snapshot"](ctx("page.snapshot"));
    state.drv.dlg = { type: "alert", message: "hi" };
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(r.__side).toEqual({ dialogs: [{ type: "alert", message: "hi" }] });
  });

  it("while a dialog is open every command except dialog.handle gets DIALOG_OPEN", async () => {
    state.dialog = { type: "confirm", message: "Sure?" };
    await expect(actHandlers["act.click"](ctx("act.click", { ref: "e1" }))).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    await expect(pageHandlers["page.snapshot"](ctx("page.snapshot"))).rejects.toMatchObject({ code: "DIALOG_OPEN", pageText: true });
    await expect(navHandlers["nav.goto"](ctx("nav.goto", { url: "http://x.test/c" }))).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    expect(() => assertNoDialog(1, "dialog.handle")).not.toThrow();
  });

  it("act.type with ref: prepare, focus, insert; submit presses Enter", async () => {
    await actHandlers["act.type"](ctx("act.type", { ref: "e1", text: "hey", submit: true }));
    expect(state.drv.log.filter((l: string) => !l.startsWith("call:"))).toEqual(["prepare", "focus", "type:hey", "press:Enter"]);
  });
});

describe("D18(a)(b) gates", () => {
  it("a click on the submit control of a password form hits the gate", async () => {
    state.drv.clickInfo = { role: "button", name: "Log in", isSubmit: true, formFields: [{ type: "password", name: "pw", label: "Password" }] };
    await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(state.sensitive).toHaveLength(1);
    expect(state.sensitive[0][2]).toBe("a");
  });

  it("Enter inside a password form hits the gate (press and type submit)", async () => {
    state.drv.keyInfo = { inForm: true, formFields: [{ type: "password", name: "pw" }] };
    await actHandlers["act.press"](ctx("act.press", { key: "Enter" }));
    await actHandlers["act.type"](ctx("act.type", { text: "x", submit: true }));
    expect(state.sensitive.map((a) => a[2])).toEqual(["a", "a"]);
  });

  it("purchase/delete/send clicks are category b; plain clicks pass", async () => {
    state.drv.clickInfo = { role: "button", name: "Delete account" };
    await actHandlers["act.dblclick"](ctx("act.dblclick", { ref: "e1" }));
    expect(state.sensitive[0][2]).toBe("b");
    state.drv.clickInfo = { role: "button", name: "Go" };
    state.sensitive = [];
    await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(state.sensitive).toEqual([]);
  });
});

describe("#21 lite support matrix", () => {
  it("every tool has a lite value; unsupported tools return UNSUPPORTED in lite mode without touching the page", () => {
    const lite = fakeDriver("lite");
    for (const t of TOOLS as unknown as any[]) {
      expect(["supported", "degraded", "unsupported"], t.name).toContain(t.lite);
      if (t.lite === "unsupported") {
        let err: unknown;
        try {
          assertLiteSupport(lite, t);
        } catch (e) {
          err = e;
        }
        expect((err as TabAgentError)?.code, t.name).toBe("UNSUPPORTED");
      } else expect(() => assertLiteSupport(lite, t)).not.toThrow();
      expect(() => assertLiteSupport(fakeDriver("cdp"), t)).not.toThrow();
    }
    expect(lite.log).toEqual([]);
  });
});

describe("page / nav handlers", () => {
  it("page.snapshot diff:true without a baseline returns the full snapshot and says so", async () => {
    const r: any = await pageHandlers["page.snapshot"](ctx("page.snapshot", { diff: true }));
    expect(r.full).toBe(true);
    expect(r.snapshot).toContain('button "Go"');
    const r2: any = await pageHandlers["page.snapshot"](ctx("page.snapshot", { diff: true }));
    expect(r2).toMatchObject({ diff: true, snapshot: "(no changes)" });
    // root and full-mode snapshots don't move the baseline
    state.drv.setSnap(["- x"]);
    await pageHandlers["page.snapshot"](ctx("page.snapshot", { mode: "full" }));
    expect(baselines.get("S", 1)).toEqual(["- main", '  - button "Go" [ref=e1]']);
  });

  it("page.screenshot maps the spike's fullPage to target=full; page.find validates", async () => {
    const r: any = await pageHandlers["page.screenshot"](ctx("page.screenshot", { fullPage: true }));
    expect(r.o.target).toBe("full");
    const r2: any = await pageHandlers["page.screenshot"](ctx("page.screenshot", { ref: "e1" }));
    expect(r2.o.target).toBe("ref");
    await expect(pageHandlers["page.find"](ctx("page.find", {}))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await pageHandlers["page.find"](ctx("page.find", { by: "text", value: "x" }))).toEqual({ matches: [], truncated: false });
  });

  it("nav.goto reports navigation and clears the baseline; nav.wait times out with TIMEOUT", async () => {
    await pageHandlers["page.snapshot"](ctx("page.snapshot"));
    const r: any = await navHandlers["nav.goto"](ctx("nav.goto", { url: "x.test/next" }));
    expect(r.__side.navigation.url).toBe("https://x.test/next");
    expect(baselines.get("S", 1)).toBeUndefined();
    state.drv.currentUrl = async () => "http://x.test/zzz";
    await expect(navHandlers["nav.wait"](ctx("nav.wait", { for: "url", value: "never", timeout: 150 }))).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(navHandlers["nav.wait"](ctx("nav.wait", { for: "url", value: "/(/" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await navHandlers["nav.wait"](ctx("nav.wait", { for: "url", value: "/zz+$/", timeout: 500 }))).toMatchObject({ ok: true });
    expect(await navHandlers["nav.wait"](ctx("nav.wait", { for: "load" }))).toMatchObject({ ok: true });
    state.drv.kind = "lite";
    await expect(navHandlers["nav.wait"](ctx("nav.wait", { for: "fn", value: "true" }))).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("levelOf follows the registry (nav tools are act, D16)", () => {
    expect(levelOf(ctx("nav.goto") as any, "read")).toBe("act");
    expect(levelOf(ctx("page.snapshot") as any, "act")).toBe("read");
  });
});

describe("nav.wait for=fn (security review H2)", () => {
  beforeEach(() => authTaint.closed(1));

  it("checks the site at full, other waits at read", async () => {
    state.drv.fnResult = true;
    await navHandlers["nav.wait"](ctx("nav.wait", { for: "fn", value: "1", timeout: 500 }));
    expect(state.site.at(-1)[2]).toBe("full");
    await navHandlers["nav.wait"](ctx("nav.wait", { for: "load" }));
    expect(state.site.at(-1)[2]).toBe("read");
  });

  it("evaluates through the driver's fresh-world evaluator, never pagelib's world", async () => {
    state.drv.fnResult = true;
    state.drv.evaluate = async () => {
      throw new Error("pagelib world used");
    };
    expect(await navHandlers["nav.wait"](ctx("nav.wait", { for: "fn", value: "document.title", timeout: 500 }))).toMatchObject({ ok: true });
    expect(state.drv.evals).toEqual(["!!(document.title)"]);
  });

  it("stops with PERMISSION_DENIED as soon as the tab leaves the authorized origin, without evaluating there", async () => {
    state.drv.onEval = () => (state.drv.url = "https://bank.example/");
    await expect(navHandlers["nav.wait"](ctx("nav.wait", { for: "fn", value: "0", timeout: 2000 }))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(state.drv.evals).toHaveLength(1);
  });

  it("stops when TabAgent types a credential into the tab mid-wait, and marks the document as touched by agent JS", async () => {
    state.drv.onEval = () => authTaint.filled(1, "password", "hunter2-secret");
    await expect(navHandlers["nav.wait"](ctx("nav.wait", { for: "fn", value: "0", timeout: 2000 }))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(state.drv.evals).toHaveLength(1);
    expect(authTaint.scriptDirty(1)).toBe(true);
  });
});
