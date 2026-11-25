// nolanmak/tabagent#64: when a submit is blocked, tell the agent which fields block it
// (form.blockers, and the same list on act.click / form.submit errors and results).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS, TabAgentError } from "@tabagent/protocol";

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

const BLOCKERS = {
  form: { ref: "e1", label: null },
  submit: { ref: "e9", label: "Continue", disabled: true },
  blockers: [
    { ref: "e3", label: "Yes", group: "Are you a government entity?", kind: "unselected", message: "Required choice has no option selected" },
    { ref: "e5", label: "I will use Codex in ChatGPT under the usage policies", kind: "unchecked", message: "Required checkbox is not checked" },
  ],
};

/** e9 = Continue (disabled unless `enabled`), e2 = an unrelated button. */
function page(o: { enabled?: boolean; blockers?: typeof BLOCKERS; navigates?: boolean } = {}) {
  const log: string[] = [];
  let url = "http://x.test/a";
  return {
    kind: "cdp",
    tabId: 1,
    log,
    snapshot: async () => ({ text: "- main", lines: ["- main"], refs: [], shown: [], truncated: false, collapsed: 0, omitted: 0, tokens: 1 }),
    call: async (fn: string, _a: unknown[], opt?: { ref?: string }) => {
      log.push(`call:${fn}:${opt?.ref ?? ""}`);
      if (fn === "submitLike") return opt?.ref === "e9";
      if (fn === "formBlockers") return o.blockers ?? BLOCKERS;
      if (fn === "submitInfo") return o.enabled ? { ref: "e1", submitRef: "e9", control: "Continue", fields: [] } : { ref: "e1", submitRef: null, control: "", fields: [], blocked: { control: "Continue", why: "disabled" } };
      if (fn === "clickGateInfo") return { role: "button", name: opt?.ref === "e9" ? "Continue" : "Other" };
      return null;
    },
    callAllFrames: async () => [],
    click: async (ref: string) => {
      log.push(`click:${ref}`);
      if (ref === "e9" && !o.enabled) throw new TabAgentError("NOT_ACTIONABLE", "e9 is not actionable (reason: disabled)", "The element is disabled. Required fields may need filling first.");
      if (ref === "e2") throw new TabAgentError("NOT_ACTIONABLE", "e2 is not actionable (reason: disabled)");
      if (o.navigates) url = "http://x.test/next";
      return {};
    },
    quiet: async () => {},
    settle: async () => {},
    navEpoch: () => 0,
    currentUrl: async () => url,
    dialog: () => null,
  } as any;
}

const ctx = (tool: string, p: Record<string, unknown> = {}) => ({ s: {} as any, meta: { id: "S", label: "t", cap: "full", sites: [] } as any, p, tool: TOOLS.find((t) => t.name === tool) as any });

beforeEach(() => {
  state.drv = page();
});

describe("form.blockers", () => {
  it("is registered in the forms profile as a read tool", () => {
    const t = TOOLS.find((x) => x.name === "form.blockers")!;
    expect(t).toMatchObject({ group: "form", level: "read", profiles: ["forms"] });
  });
  it("returns the page's blockers for the ref", async () => {
    const r: any = await formHandlers["form.blockers"](ctx("form.blockers", { ref: "e9" }));
    expect(r).toEqual(BLOCKERS);
    expect(state.drv.log).toContain("call:formBlockers:e9");
  });
});

describe("act.click on a disabled submit-like button", () => {
  it("fails NOT_ACTIONABLE with 'submit disabled' and the top blockers", async () => {
    const e: any = await actHandlers["act.click"](ctx("act.click", { ref: "e9" })).catch((x) => x);
    expect(e).toBeInstanceOf(TabAgentError);
    expect(e.code).toBe("NOT_ACTIONABLE");
    expect(e.message).toContain("submit disabled");
    expect(e.message).toContain('e3 "Are you a government entity?" (unselected)');
    expect(e.message).toContain('e5 "I will use Codex in ChatGPT under the usage policies" (unchecked)');
    expect(e.hint).toMatch(/form\.blockers/);
    expect(e.pageText).toBe(true);
  });
  it("says so when the page reports nothing missing", async () => {
    state.drv = page({ blockers: { ...BLOCKERS, blockers: [] } });
    const e: any = await actHandlers["act.click"](ctx("act.click", { ref: "e9" })).catch((x) => x);
    expect(e.message).toContain("submit disabled");
    expect(e.message).toMatch(/no empty or invalid field/);
  });
  it("leaves the error of a disabled non-submit button alone", async () => {
    const e: any = await actHandlers["act.click"](ctx("act.click", { ref: "e2" })).catch((x) => x);
    expect(e.message).toBe("e2 is not actionable (reason: disabled)");
    expect(state.drv.log).not.toContain("call:formBlockers:e2");
  });
});

describe("a submit click that changes nothing", () => {
  it("returns the form's remaining blockers with a hint", async () => {
    state.drv = page({ enabled: true });
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e9" }));
    expect(r.ok).toBe(true);
    expect(r.blockers.map((b: any) => b.ref)).toEqual(["e3", "e5"]);
    expect(r.hint).toMatch(/still has/);
  });
  it("no blockers check after a navigation", async () => {
    state.drv = page({ enabled: true, navigates: true });
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e9" }));
    expect(r.blockers).toBeUndefined();
    expect(state.drv.log).not.toContain("call:formBlockers:e9");
  });
  it("no blockers field when the form is complete", async () => {
    state.drv = page({ enabled: true, blockers: { ...BLOCKERS, blockers: [] } });
    const r: any = await actHandlers["act.click"](ctx("act.click", { ref: "e9" }));
    expect(r.blockers).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });
});

describe("form.submit", () => {
  it("a disabled submit names the blockers", async () => {
    const e: any = await formHandlers["form.submit"](ctx("form.submit", {})).catch((x) => x);
    expect(e.code).toBe("NOT_ACTIONABLE");
    expect(e.message).toContain('"Continue" is disabled');
    expect(e.message).toContain('e5 "I will use Codex in ChatGPT under the usage policies" (unchecked)');
  });
  it("a submit that changes nothing returns the remaining blockers", async () => {
    state.drv = page({ enabled: true });
    const r: any = await formHandlers["form.submit"](ctx("form.submit", {}));
    expect(r.blockers).toHaveLength(2);
  });
});
