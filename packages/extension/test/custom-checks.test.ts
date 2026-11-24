// nolanmak/Jarvis#2522: act.check / act.click / form.fill on custom checkboxes and
// radios whose native input is hidden behind a styled label (often React-controlled).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "@tabagent/protocol";

const state = vi.hoisted(() => ({ drv: null as any }));

vi.mock("../src/background/sessions", () => ({ resolveTab: async (_s: unknown, id?: number) => id ?? 1 }));
vi.mock("../src/background/permissions", () => ({ requireSite: async () => {}, requireSensitive: async () => {}, effectivePolicy: async () => ({ policy: "full" }) }));
vi.mock("../src/background/bridgeFiles", () => ({ resolveFiles: async (_id: string, p: string[]) => p }));
vi.mock("../src/background/downloads", () => ({ noteAction: () => {}, downloadsSince: () => [] }));
vi.mock("../src/background/cdp", () => ({ peekCdpTab: () => undefined, getCdpTab: () => null, sleep: async () => {} }));
vi.mock("../src/background/driver", () => ({ driverFor: async () => state.drv }));
vi.mock("../src/background/refstore", async () => {
  const { Baselines } = await import("../src/background/diff");
  return { baselines: new Baselines(), refTable: null, forgetTab: () => {} };
});
(globalThis as any).chrome = { tabs: { get: async () => ({ url: "http://x.test/a", title: "T" }) } };

const { actHandlers } = await import("../src/background/handlers/act");
const { formHandlers } = await import("../src/background/handlers/forms");

/**
 * e1 = a hidden native checkbox (opacity:0), e9 = its label. `labelToggles` says
 * whether a click on the label reaches the input (it does not when the trusted
 * click is lost); `jsClickToggles` is the in-page el.click() fallback.
 */
function page(o: { type?: string; visible?: boolean; labelToggles?: boolean; jsClickToggles?: boolean; label?: string | null; initial?: boolean } = {}) {
  const type = o.type ?? "checkbox";
  const log: string[] = [];
  const s = { checked: o.initial ?? false };
  const toggle = () => (s.checked = type === "radio" ? true : !s.checked);
  const label = o.label === undefined ? "e9" : o.label;
  const d: any = {
    kind: "cdp",
    tabId: 1,
    log,
    s,
    snapshot: async () => ({ text: "- main", lines: ["- main"], refs: [], shown: [], truncated: false, collapsed: 0, omitted: 0, tokens: 1 }),
    call: async (fn: string, _a: unknown[], opt?: { ref?: string }) => {
      log.push(`call:${fn}:${opt?.ref ?? ""}`);
      if (fn === "getChecked") return s.checked;
      if (fn === "info") return { tag: "input", isSelect: false, role: type, inputType: type, type, checked: s.checked, visible: o.visible ?? false };
      if (fn === "labelFor" || fn === "toggleTarget") return label && opt?.ref === "e1" && !(o.visible ?? false) ? { ref: label } : null;
      if (fn === "clickEl") {
        if (o.jsClickToggles ?? true) toggle();
        return true;
      }
      if (fn === "clickGateInfo") return { role: type, name: "Agree" };
      if (fn === "fieldInfo") return { label: "Agree", type, name: "agree", checked: s.checked };
      return null;
    },
    callAllFrames: async () => [],
    click: async (ref: string) => {
      log.push(`click:${ref}`);
      if (ref === "e1" && !(o.visible ?? false)) {
        const { TabAgentError } = await import("@tabagent/protocol");
        throw new TabAgentError("NOT_ACTIONABLE", "e1 is not actionable (reason: hidden)");
      }
      if (ref === label && (o.labelToggles ?? true)) toggle();
      if (ref === "e1") toggle();
      return {};
    },
    quiet: async () => {},
    settle: async () => {},
    navEpoch: () => 0,
    currentUrl: async () => "http://x.test/a",
    dialog: () => null,
  };
  return d;
}

const ctx = (tool: string, p: Record<string, unknown> = {}) => ({ s: {} as any, meta: { id: "S", label: "t", cap: "full", sites: [] } as any, p, tool: TOOLS.find((t) => t.name === tool) as any });
const clicks = (d: any) => d.log.filter((l: string) => l.startsWith("click:") || l.startsWith("call:clickEl"));

beforeEach(() => {
  state.drv = page();
});

describe("act.check on a custom (hidden-input) checkbox", () => {
  it("clicks the label of a hidden input and reports the new state", async () => {
    const r: any = await actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }));
    expect(r.result).toEqual({ checked: true, changed: true });
    expect(clicks(state.drv)).toEqual(["click:e9"]);
  });

  it("falls back to an in-page click on the input when the label click does not toggle it", async () => {
    state.drv = page({ labelToggles: false });
    const r: any = await actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }));
    expect(r.result).toEqual({ checked: true, changed: true });
    expect(clicks(state.drv)).toEqual(["click:e9", "call:clickEl"]);
  });

  it("uses the in-page click when there is no label to click", async () => {
    state.drv = page({ label: null });
    const r: any = await actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }));
    expect(r.result.checked).toBe(true);
    expect(clicks(state.drv)).toEqual(["call:clickEl"]);
  });

  it("still reports NOT_ACTIONABLE when nothing changes the state", async () => {
    state.drv = page({ labelToggles: false, jsClickToggles: false });
    await expect(actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }))).rejects.toMatchObject({ code: "NOT_ACTIONABLE" });
  });

  it("does not click at all when already in the asked state", async () => {
    state.drv = page({ initial: true });
    const r: any = await actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }));
    expect(r.result).toEqual({ checked: true, changed: false });
    expect(clicks(state.drv)).toEqual([]);
  });

  it("a visible checkbox is clicked directly", async () => {
    state.drv = page({ visible: true });
    const r: any = await actHandlers["act.check"](ctx("act.check", { ref: "e1", checked: true }));
    expect(r.result.checked).toBe(true);
    expect(clicks(state.drv)).toEqual(["click:e1"]);
  });
});

describe("act.click on a hidden checkbox/radio input", () => {
  it("clicks the associated label instead of failing 'hidden'", async () => {
    state.drv = page({ type: "radio" });
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e1" }));
    expect(r.ok).toBe(true);
    expect(clicks(state.drv)).toEqual(["click:e9"]);
    expect(state.drv.s.checked).toBe(true);
  });
});

describe("form.fill on a custom checkbox", () => {
  it("falls back like act.check when the label click does not toggle it", async () => {
    state.drv = page({ labelToggles: false });
    const r: any = await formHandlers["form.fill"](ctx("form.fill", { fields: { e1: true } }));
    expect(r.failed ?? []).toEqual([]);
    expect(state.drv.s.checked).toBe(true);
  });
});
