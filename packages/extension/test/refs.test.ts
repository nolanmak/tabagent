import { describe, expect, it } from "vitest";
import { TabAgentError } from "@tabagent/protocol";
import { memoryStore, RefTable } from "../src/background/refs";

const T = (backendNodeId: number, o: Partial<{ tabId: number; frameKey: string; loaderId: string }> = {}) => ({ tabId: 1, frameKey: "|F", loaderId: "L1", backendNodeId, ...o });

function code(f: () => unknown) {
  try {
    f();
  } catch (e) {
    return (e as TabAgentError).code;
  }
  return "ok";
}

describe("errors helpers", () => {
  it("taErr carries code, hint and pageText; isCode / codeOf", async () => {
    const { codeOf, isCode, taErr } = await import("../src/background/errors");
    const e = taErr("NOT_ACTIONABLE", "covered by <div>", "close it", { pageText: true });
    expect(e.toJSON()).toEqual({ code: "NOT_ACTIONABLE", message: "covered by <div>", hint: "close it", untrusted: true });
    expect(isCode(e, "NOT_ACTIONABLE")).toBe(true);
    expect(isCode(new Error("x"), "NOT_ACTIONABLE")).toBe(false);
    expect(codeOf(e)).toBe("NOT_ACTIONABLE");
    expect(codeOf("nope")).toBeUndefined();
  });
});

describe("RefTable (D22)", () => {
  it("mints e<N>, keeps the same ref for the same node", async () => {
    const t = new RefTable(memoryStore());
    await t.init();
    const a = t.mint(T(5));
    expect(a).toBe("e1");
    expect(t.mint(T(5))).toBe(a);
    expect(t.mint(T(6))).toBe("e2");
    expect(t.peek(T(6))).toBe("e2");
    expect(t.peek(T(7))).toBeUndefined();
  });

  it("never reuses a number after nodes are removed", async () => {
    const t = new RefTable(memoryStore());
    await t.init();
    const a = t.mint(T(1));
    t.dropNode(1, "|F", 1);
    const b = t.mint(T(1));
    expect(b).not.toBe(a);
    expect(code(() => t.resolve(a, 1))).toBe("REF_STALE");
  });

  it("one counter across tabs; a ref used with another tabId is REF_STALE", async () => {
    const t = new RefTable(memoryStore());
    await t.init();
    const a = t.mint(T(1, { tabId: 1 }));
    const b = t.mint(T(1, { tabId: 2 }));
    expect(a).not.toBe(b);
    expect(t.resolve(a, 1).backendNodeId).toBe(1);
    expect(code(() => t.resolve(a, 2))).toBe("REF_STALE");
  });

  it("a ref from before a navigation (loaderId changed) is REF_STALE; frame gone is REF_STALE", async () => {
    const t = new RefTable(memoryStore());
    await t.init();
    const a = t.mint(T(1));
    const loaders = new Map([["|F", "L1"]]);
    expect(t.resolve(a, 1, (k) => loaders.get(k)).loaderId).toBe("L1");
    loaders.set("|F", "L2");
    expect(code(() => t.resolve(a, 1, (k) => loaders.get(k)))).toBe("REF_STALE");
    loaders.delete("|F");
    expect(code(() => t.resolve(a, 1, (k) => loaders.get(k)))).toBe("REF_STALE");
  });

  it("frame navigation stales only that frame's refs (#19)", async () => {
    const t = new RefTable(memoryStore());
    await t.init();
    const parent = t.mint(T(1, { frameKey: "|top" }));
    const child = t.mint(T(1, { frameKey: "S|child", loaderId: "C1" }));
    expect(parent).not.toBe(child);
    const loaders = new Map([["|top", "L1"], ["S|child", "C2"]]);
    expect(code(() => t.resolve(child, 1, (k) => loaders.get(k)))).toBe("REF_STALE");
    expect(t.resolve(parent, 1, (k) => loaders.get(k)).frameKey).toBe("|top");
    expect(t.resolve(child, 1).frameKey).toBe("S|child");
  });

  it("after a simulated worker restart old refs are REF_STALE and new refs continue above the persisted counter", async () => {
    const store = memoryStore();
    const t1 = new RefTable(store, 10);
    await t1.init();
    const old = [t1.mint(T(1)), t1.mint(T(2)), t1.mint(T(3))];
    const t2 = new RefTable(store, 10); // new service worker life
    await t2.init();
    for (const r of old) expect(code(() => t2.resolve(r, 1))).toBe("REF_STALE");
    const fresh = t2.mint(T(1));
    const n = (r: string) => Number(r.slice(1));
    expect(n(fresh)).toBeGreaterThan(Math.max(...old.map(n)));
  });

  it("reserves numbers in blocks before using them", async () => {
    const store = memoryStore();
    const t = new RefTable(store, 5);
    await t.init();
    expect(store.value).toBe(5);
    await t.reserve(12);
    expect(store.value).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < 12; i++) t.mint(T(100 + i));
    // minting past the reservation still extends it (best effort)
    for (let i = 0; i < 10; i++) t.mint(T(200 + i));
    await t.reserve(1);
    expect(store.value).toBeGreaterThanOrEqual(t.peekNext() - 1);
  });

  it("unknown or malformed refs are REF_STALE; drop helpers", async () => {
    const t = new RefTable(memoryStore());
    expect(code(() => t.resolve("e1", 1))).toBe("REF_STALE");
    expect(code(() => t.resolve("l7", 1))).toBe("REF_STALE");
    await t.init();
    t.mint(T(1, { tabId: 3 }));
    t.mint(T(2, { tabId: 3, frameKey: "|G" }));
    expect(t.entries(3)).toHaveLength(2);
    expect(t.entries(3, "|G")).toHaveLength(1);
    expect(t.dropFrame(3, "|G")).toBe(1);
    expect(t.dropTab(3)).toBe(1);
    expect(t.size()).toBe(0);
  });
});
