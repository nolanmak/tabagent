import { describe, expect, it } from "vitest";
import { DownloadTracker } from "../src/pure/dlattr";

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
});
