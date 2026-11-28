// #151: live chat entries. The watcher pushes lines appended to a transcript, leaves a partial line for the
// next poll, and reports a truncated, replaced or moved transcript as `reset`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEntries } from "@tabagent/protocol";
import { TranscriptWatchers } from "../src/agents/watch";
import { tx } from "./agents-fakes";

let dir: string;
let file: string;
let path: string | null;
let got: AgentEntries[];
let w: TranscriptWatchers;
const line = (r: object) => JSON.stringify(r) + "\n";
const push = (m: AgentEntries) => void got.push(m);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ta-watch-"));
  file = join(dir, "s.jsonl");
  path = file;
  got = [];
  // Long intervals: the tests drive polls by hand.
  w = new TranscriptWatchers({ resolve: async () => path, pollMs: 60_000, resolveMs: 60_000 });
});
afterEach(() => {
  w.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptWatchers", () => {
  it("pushes only lines appended after the watch started", async () => {
    writeFileSync(file, line(tx.user("old")));
    await w.watch("claude:1:1", push);
    await w.poll("claude:1:1");
    expect(got).toEqual([]);
    appendFileSync(file, line(tx.user("new one")) + line(tx.system()) + line(tx.assistant([tx.text("reply")])));
    await w.poll("claude:1:1");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "agent.entries", agentId: "claude:1:1" });
    expect(got[0].entries.map((e) => e.text)).toEqual(["new one", "reply"]);
  });

  it("a partially written line waits until it is complete", async () => {
    writeFileSync(file, "");
    await w.watch("a", push);
    const full = line(tx.assistant([tx.text("streamed")]));
    appendFileSync(file, full.slice(0, 15));
    await w.poll("a");
    expect(got).toEqual([]);
    appendFileSync(file, full.slice(15));
    await w.poll("a");
    expect(got[0].entries[0].text).toBe("streamed");
  });

  it("a line still being written when the watch starts is read once it is complete", async () => {
    const half = line(tx.user("half")).slice(0, 10);
    writeFileSync(file, line(tx.user("x")) + half);
    await w.watch("a", push);
    appendFileSync(file, line(tx.user("rest")).slice(10) + line(tx.user("after")));
    await w.poll("a");
    // The first 10 bytes of both lines are the same, so the completed line is "rest".
    expect(got[0].entries.map((e) => e.text)).toEqual(["rest", "after"]);
  });

  it("truncation and replacement (rotation) are pushed as reset", async () => {
    writeFileSync(file, line(tx.user("a")) + line(tx.user("b")));
    await w.watch("a", push);
    writeFileSync(file, line(tx.user("c")));
    await w.poll("a");
    expect(got.at(-1)).toEqual({ type: "agent.entries", agentId: "a", entries: [], reset: true });
    // Replaced by a new file (new inode) at the same path.
    const other = join(dir, "new.jsonl");
    writeFileSync(other, line(tx.user("d")) + line(tx.user("e")));
    renameSync(other, file);
    got = [];
    await w.poll("a");
    expect(got).toEqual([{ type: "agent.entries", agentId: "a", entries: [], reset: true }]);
    // After a reset, appends are pushed again.
    appendFileSync(file, line(tx.user("f")));
    await w.poll("a");
    expect(got.at(-1)!.entries.map((e) => e.text)).toEqual(["f"]);
  });

  it("the session moving to a new transcript (path change) is a reset", async () => {
    writeFileSync(file, line(tx.user("a")));
    w = new TranscriptWatchers({ resolve: async () => path, pollMs: 60_000, resolveMs: 0 });
    await w.watch("a", push);
    const next = join(dir, "s2.jsonl");
    writeFileSync(next, line(tx.user("fresh")));
    path = next;
    await w.poll("a");
    expect(got).toEqual([{ type: "agent.entries", agentId: "a", entries: [], reset: true }]);
    appendFileSync(next, line(tx.user("more")));
    await w.poll("a");
    expect(got.at(-1)!.entries.map((e) => e.text)).toEqual(["more"]);
  });

  it("no transcript yet: nothing is pushed until one appears", async () => {
    path = null;
    w = new TranscriptWatchers({ resolve: async () => path, pollMs: 60_000, resolveMs: 60_000 });
    await w.watch("a", push);
    await w.poll("a");
    expect(got).toEqual([]);
    writeFileSync(file, line(tx.user("first")));
    path = file;
    await w.poll("a");
    expect(got).toEqual([{ type: "agent.entries", agentId: "a", entries: [], reset: true }]);
  });

  it("unwatch stops pushes; watching twice keeps one watch; the cap refuses more", async () => {
    writeFileSync(file, "");
    w = new TranscriptWatchers({ resolve: async () => path, pollMs: 60_000, max: 2 });
    expect(await w.watch("a", push)).toBe(true);
    expect(await w.watch("a", push)).toBe(true);
    expect(w.size).toBe(1);
    expect(await w.watch("b", push)).toBe(true);
    expect(await w.watch("c", push)).toBe(false);
    w.unwatch("a");
    expect(w.has("a")).toBe(false);
    appendFileSync(file, line(tx.user("x")));
    await w.poll("a");
    expect(got).toEqual([]);
    w.stopAll();
    expect(w.size).toBe(0);
  });

  it("the timer polls by itself", async () => {
    writeFileSync(file, "");
    w = new TranscriptWatchers({ resolve: async () => path, pollMs: 20 });
    await w.watch("a", push);
    appendFileSync(file, line(tx.user("timed")));
    await expect.poll(() => got.length, { timeout: 2000 }).toBe(1);
  });
});
