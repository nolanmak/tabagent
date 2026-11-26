import { describe, expect, it, vi } from "vitest";
import { runEval, EVAL_MAX_BYTES } from "../src/pure/jseval";
import { cookieUrlFor } from "../src/pure/cookies";
import { DownloadTracker } from "../src/pure/dlattr";

type Send = (method: string, params: any) => Promise<any>;

function fakeSend(result: any, onCall?: (m: string, p: any) => void): Send & { calls: [string, any][] } {
  const calls: [string, any][] = [];
  const f = (async (m: string, p: any) => {
    calls.push([m, p]);
    onCall?.(m, p);
    if (m === "Page.createIsolatedWorld") return { executionContextId: 77 };
    if (typeof result === "function") return result(m, p);
    return result;
  }) as any;
  f.calls = calls;
  return f;
}

describe("js.eval (D18c)", () => {
  it("passes the result through", async () => {
    const send = fakeSend({ result: { type: "number", value: 3 } });
    expect(await runEval(send, { expression: "1+2", world: "main", frameId: "F", timeout: 1000 })).toEqual({ value: 3 });
    const [m, p] = send.calls[0];
    expect(m).toBe("Runtime.evaluate");
    expect(p).toMatchObject({ expression: "1+2", awaitPromise: true, returnByValue: true });
    expect(p.contextId).toBeUndefined();
  });
  it("undefined results are reported as such", async () => {
    const send = fakeSend({ result: { type: "undefined" } });
    expect(await runEval(send, { expression: "void 0", world: "main", frameId: "F" })).toEqual({ value: null, type: "undefined" });
  });
  it("awaits promises (awaitPromise on)", async () => {
    const send = fakeSend({ result: { type: "string", value: "done" } });
    await runEval(send, { expression: "new Promise(r => r('done'))", world: "main", frameId: "F" });
    expect(send.calls[0][1].awaitPromise).toBe(true);
  });
  it("a thrown error -> error with the page's message, marked page text", async () => {
    const send = fakeSend({ result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "Error: nope\n    at <anonymous>:1:7" } } });
    const err: any = await runEval(send, { expression: "throw new Error('nope')", world: "main", frameId: "F" }).catch((e) => e);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("Error: nope");
    expect(err.message).not.toContain("<anonymous>");
    expect(err.pageText).toBe(true);
  });
  it("> 100 KB -> TOO_LARGE", async () => {
    const send = fakeSend({ result: { type: "string", value: "x".repeat(EVAL_MAX_BYTES + 1) } });
    await expect(runEval(send, { expression: "big", world: "main", frameId: "F" })).rejects.toMatchObject({ code: "TOO_LARGE" });
    const ok = fakeSend({ result: { type: "string", value: "x".repeat(1000) } });
    await expect(runEval(ok, { expression: "small", world: "main", frameId: "F" })).resolves.toBeTruthy();
  });
  it("timeout -> TIMEOUT", async () => {
    const send = fakeSend(() => new Promise(() => {}));
    await expect(runEval(send, { expression: "while(1){}", world: "main", frameId: "F", timeout: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("CDP-reported timeout -> TIMEOUT", async () => {
    const send = fakeSend(async () => {
      throw new Error("Runtime.evaluate: Execution was terminated");
    });
    await expect(runEval(send, { expression: "x", world: "main", frameId: "F", timeout: 1000 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("isolated creates a fresh world and evaluates in it", async () => {
    const send = fakeSend({ result: { type: "string", value: "undefined" } });
    await runEval(send, { expression: "typeof window.n", world: "isolated", frameId: "F" });
    await runEval(send, { expression: "typeof window.n", world: "isolated", frameId: "F" });
    const worlds = send.calls.filter(([m]) => m === "Page.createIsolatedWorld");
    expect(worlds).toHaveLength(2);
    expect(worlds[0][1]).toMatchObject({ frameId: "F" });
    expect(worlds[0][1].worldName).not.toBe(worlds[1][1].worldName);
    expect(send.calls.find(([m]) => m === "Runtime.evaluate")![1].contextId).toBe(77);
  });
  it("non-serialisable results fall back to their description", async () => {
    const send = fakeSend({ result: { type: "object", subtype: "node", description: "div#x" } });
    expect(await runEval(send, { expression: "document.body", world: "main", frameId: "F" })).toEqual({ value: "div#x", type: "object" });
  });
});

describe("cookies.get origin rule (D18d)", () => {
  it("defaults to the tab's URL", () => {
    expect(cookieUrlFor("http://a.test:8080/x?y", undefined)).toBe("http://a.test:8080/x?y");
  });
  it("allows other paths on the same origin", () => {
    expect(cookieUrlFor("http://a.test/x", "http://a.test/account")).toBe("http://a.test/account");
  });
  it("refuses another origin's URL with PERMISSION_DENIED", () => {
    expect(() => cookieUrlFor("http://a.test/x", "http://b.test/")).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => cookieUrlFor("http://a.test/x", "https://a.test/")).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => cookieUrlFor("http://a.test/x", "http://sub.a.test/")).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });
  it("refuses pages without an origin", () => {
    expect(() => cookieUrlFor("about:blank", undefined)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});

describe("download attribution (D31)", () => {
  const owner = (tabId: number) => (tabId === 1 ? "S1" : tabId === 2 ? "S2" : undefined);
  it("a download started by a session tab belongs to that session", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/f.csv", 1000);
    t.onCreated({ id: 5, url: "http://a.test/f.csv", filename: "/d/f.csv", state: "in_progress", mime: "text/csv", startTime: "1970-01-01T00:00:01.000Z" }, 1001);
    expect(t.list("S1").map((d) => d.id)).toEqual([5]);
    expect(t.list("S2")).toEqual([]);
  });
  it("order does not matter (created before the tab note)", () => {
    const t = new DownloadTracker(owner);
    t.onCreated({ id: 6, url: "http://a.test/g.bin", filename: "", state: "in_progress" }, 1000);
    expect(t.list("S1")).toEqual([]);
    t.noteTabDownload(1, "http://a.test/g.bin", 1100);
    expect(t.list("S1").map((d) => d.id)).toEqual([6]);
  });
  it("downloads by another session or by the user are absent", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(2, "http://a.test/other", 1000);
    t.onCreated({ id: 1, url: "http://a.test/other", filename: "", state: "complete" }, 1000);
    t.onCreated({ id: 2, url: "http://a.test/user-clicked", filename: "", state: "complete" }, 1000);
    t.noteTabDownload(9, "http://a.test/unowned", 1000);
    t.onCreated({ id: 3, url: "http://a.test/unowned", filename: "", state: "complete" }, 1000);
    expect(t.list("S1")).toEqual([]);
    expect(t.list("S2").map((d) => d.id)).toEqual([1]);
  });
  it("stale tab notes are not matched", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/f", 1000);
    t.onCreated({ id: 1, url: "http://a.test/f", filename: "", state: "complete" }, 1000 + 60_000);
    expect(t.list("S1")).toEqual([]);
  });
  it("a tab note matches only one download", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/f", 1000);
    t.onCreated({ id: 1, url: "http://a.test/f", filename: "", state: "complete" }, 1000);
    t.onCreated({ id: 2, url: "http://a.test/f", filename: "", state: "complete" }, 1001);
    expect(t.list("S1").map((d) => d.id)).toEqual([1]);
  });
  it("downloads.read only for ids reported to that session", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/f", 1000);
    t.onCreated({ id: 1, url: "http://a.test/f", filename: "/d/f", state: "complete", mime: "text/plain" }, 1000);
    expect(() => t.readable("S1", 1)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    t.markReported("S1", [1]);
    expect(t.readable("S1", 1).filename).toBe("/d/f");
    expect(() => t.readable("S2", 1)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    t.markReported("S2", [1]);
    expect(() => t.readable("S2", 1)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => t.readable("S1", 99)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
  it("an incomplete download is not readable yet", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/f", 1000);
    t.onCreated({ id: 1, url: "http://a.test/f", filename: "/d/f", state: "in_progress" }, 1000);
    t.markReported("S1", [1]);
    expect(() => t.readable("S1", 1)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    t.onChanged({ id: 1, state: "complete", filename: "/d/f" });
    expect(t.readable("S1", 1).state).toBe("complete");
  });
  it("waitNext resolves on the next completed download of the session only", async () => {
    const t = new DownloadTracker(owner);
    const p = t.waitNext("S1", 1000);
    t.noteTabDownload(2, "http://a.test/o", 1000);
    t.onCreated({ id: 1, url: "http://a.test/o", filename: "", state: "complete" }, 1000);
    t.noteTabDownload(1, "http://a.test/mine", 1000);
    t.onCreated({ id: 2, url: "http://a.test/mine", filename: "/d/mine", state: "in_progress" }, 1000);
    t.onChanged({ id: 2, state: "complete" });
    expect((await p)?.id).toBe(2);
    expect(await t.waitNext("S1", 20)).toBeNull();
  });
  it("since() lists a session's downloads started after a time", () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/a", 1000);
    t.onCreated({ id: 1, url: "http://a.test/a", filename: "", state: "complete" }, 1000);
    t.noteTabDownload(1, "http://a.test/b", 5000);
    t.onCreated({ id: 2, url: "http://a.test/b", filename: "", state: "complete" }, 5000);
    expect(t.since("S1", 4000).map((d) => d.id)).toEqual([2]);
  });
  it("waitAfter ignores an earlier artifact and resolves only a workflow-run download", async () => {
    const t = new DownloadTracker(owner);
    t.noteTabDownload(1, "http://a.test/old", 1000);
    t.onCreated({ id: 1, url: "http://a.test/old", filename: "/d/old.csv", state: "complete" }, 1000);
    const next = t.waitAfter("S1", 2000, 1000);
    t.noteTabDownload(1, "http://a.test/new", 2001);
    t.onCreated({ id: 2, url: "http://a.test/new", filename: "/d/new.csv", state: "in_progress" }, 2001);
    t.onChanged({ id: 2, state: "complete" });
    expect((await next)?.id).toBe(2);
  });
});
