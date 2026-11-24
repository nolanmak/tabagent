import { describe, expect, it, vi } from "vitest";
import { RingBuffer } from "../src/pure/ringbuffer";
import { Capture, LIST_KEYS } from "../src/pure/capture";

function req(c: Capture, id: string, url: string, o: { method?: string; type?: string; status?: number; sid?: string; finish?: boolean; size?: number } = {}) {
  c.onEvent("Network.requestWillBeSent", { requestId: id, type: o.type ?? "XHR", request: { url, method: o.method ?? "GET", headers: { Authorization: "Bearer secret" } } }, o.sid);
  c.onEvent("Network.responseReceived", { requestId: id, type: o.type ?? "XHR", response: { url, status: o.status ?? 200, statusText: "OK", mimeType: "application/json", headers: { "set-cookie": "sid=1" } } }, o.sid);
  if (o.finish !== false) c.onEvent("Network.loadingFinished", { requestId: id, encodedDataLength: o.size ?? 10 }, o.sid);
}

describe("RingBuffer", () => {
  it("keeps the newest N", () => {
    const b = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.size).toBe(3);
    b.clear();
    expect(b.toArray()).toEqual([]);
  });
  it("reports evictions", () => {
    const evicted: number[] = [];
    const b = new RingBuffer<number>(2, (x) => evicted.push(x));
    b.push(1);
    b.push(2);
    b.push(3);
    expect(evicted).toEqual([1]);
  });
});

describe("Capture buffers (D35)", () => {
  it("keeps the newest 500 requests and 200 console messages", () => {
    const c = new Capture();
    for (let i = 0; i < 520; i++) req(c, `r${i}`, `http://a.test/${i}`);
    const l = c.list({ limit: 1000 });
    expect(l.total).toBe(500);
    expect(l.requests[0].url).toBe("http://a.test/20");
    for (let i = 0; i < 230; i++) c.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `m${i}` }] });
    const cl = c.consoleList({ limit: 1000 });
    expect(cl.total).toBe(200);
    expect(cl.messages[0].text).toBe("m30");
  });
  it("survives navigation with a marker entry", () => {
    const c = new Capture();
    req(c, "1", "http://a.test/before");
    c.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "before" }] });
    c.onEvent("Page.frameNavigated", { frame: { id: "F", url: "http://a.test/next" } });
    req(c, "2", "http://a.test/after");
    const l = c.list({});
    expect(l.requests.map((r) => r.url)).toEqual(["http://a.test/before", "http://a.test/next", "http://a.test/after"]);
    expect(l.requests[1].type).toBe("navigation");
    const cl = c.consoleList({});
    expect(cl.messages.map((m) => m.text)).toEqual(["before", "navigated to http://a.test/next"]);
    expect(cl.messages[1].level).toBe("marker");
  });
  it("child-frame navigations add no marker", () => {
    const c = new Capture();
    c.onEvent("Page.frameNavigated", { frame: { id: "F2", parentId: "F", url: "http://a.test/frame" } });
    c.onEvent("Page.frameNavigated", { frame: { id: "F3", url: "http://b.test/oopif" } }, "child-session");
    expect(c.list({}).total).toBe(0);
  });
  it("cleared on tab close", () => {
    const c = new Capture();
    req(c, "1", "http://a.test/x");
    c.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x" }] });
    c.clear();
    expect(c.list({}).total).toBe(0);
    expect(c.consoleList({}).total).toBe(0);
  });
  it("console captures exceptions and log entries", () => {
    const c = new Capture();
    c.onEvent("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "Error: boom\n at x" } } });
    c.onEvent("Log.entryAdded", { entry: { level: "warning", text: "deprecated" } });
    c.onEvent("Runtime.consoleAPICalled", { type: "error", args: [{ type: "object", description: "Object" }, { type: "number", value: 3 }] });
    expect(c.consoleList({}).messages.map((m) => [m.level, m.text])).toEqual([
      ["error", "Error: boom"],
      ["warning", "deprecated"],
      ["error", "Object 3"],
    ]);
    expect(c.consoleList({ level: "error" }).total).toBe(2);
    expect(Object.keys(c.consoleList({}).messages[0]).sort()).toEqual(["level", "text", "ts"]);
  });
});

describe("network.list filters", () => {
  const c = new Capture();
  req(c, "1", "http://a.test/api/users", { method: "GET", status: 200, type: "XHR" });
  req(c, "2", "http://a.test/api/users", { method: "POST", status: 201, type: "Fetch" });
  req(c, "3", "http://a.test/style.css", { method: "GET", status: 404, type: "Stylesheet" });
  const urls = (f: Parameters<Capture["list"]>[0]) => c.list(f).requests.map((r) => `${r.method} ${r.url} ${r.status}`);
  it("url substring", () => expect(urls({ url: "api" })).toHaveLength(2));
  it("url regex", () => expect(urls({ url: "/\\.css$/" })).toHaveLength(1));
  it("method", () => expect(urls({ method: "post" })).toEqual(["POST http://a.test/api/users 201"]));
  it("status", () => expect(urls({ status: 404 })).toEqual(["GET http://a.test/style.css 404"]));
  it("type", () => expect(urls({ type: "stylesheet" })).toHaveLength(1));
  it("combined", () => expect(urls({ url: "users", method: "GET", status: 200, type: "xhr" })).toEqual(["GET http://a.test/api/users 200"]));
  it("limit keeps the newest", () => expect(urls({ limit: 1 })).toEqual(["GET http://a.test/style.css 404"]));
  it("list output has no header values (schema)", () => {
    const l = c.list({});
    for (const r of l.requests) expect(Object.keys(r).sort()).toEqual([...LIST_KEYS].sort());
    expect(JSON.stringify(l)).not.toContain("Bearer secret");
    expect(JSON.stringify(l)).not.toContain("sid=1");
    expect(l.requests[0].size).toBe(10);
    expect(typeof l.requests[0].ms).toBe("number");
  });
});

describe("network.get", () => {
  it("returns headers and the body", async () => {
    const c = new Capture();
    req(c, "7", "http://a.test/api", { sid: "S" });
    const id = c.list({}).requests[0].id;
    const fetch = vi.fn(async () => ({ body: '{"a":1}', base64Encoded: false }));
    const g = await c.get(id, fetch);
    expect(fetch).toHaveBeenCalledWith("7", "S");
    expect(g.request.headers).toEqual({ Authorization: "Bearer secret" });
    expect(g.response?.headers).toEqual({ "set-cookie": "sid=1" });
    expect(g.body).toBe('{"a":1}');
  });
  it("evicted body -> NOT_FOUND body no longer available", async () => {
    const c = new Capture();
    req(c, "7", "http://a.test/api");
    const id = c.list({}).requests[0].id;
    await expect(c.get(id, async () => { throw new Error("No resource with given identifier found"); })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("body no longer available") });
  });
  it("evicted request -> NOT_FOUND", async () => {
    const c = new Capture(1);
    req(c, "1", "http://a.test/a");
    const id = c.list({}).requests[0].id;
    req(c, "2", "http://a.test/b");
    await expect(c.get(id, async () => ({ body: "" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("large bodies are cut", async () => {
    const c = new Capture();
    req(c, "1", "http://a.test/a");
    const g = await c.get(c.list({}).requests[0].id, async () => ({ body: "x".repeat(200_000) }));
    expect(g.body!.length).toBeLessThan(110_000);
    expect(g.truncated).toBe(true);
  });
  it("DA1 (review H1): a request the auth taint covers is refused without fetching its body", async () => {
    let t = 1000;
    const c = new Capture(undefined, undefined, () => t);
    req(c, "1", "http://a.test/before");
    t = 2000;
    c.onEvent("Network.requestWillBeSent", { requestId: "2", type: "Document", request: { url: "http://a.test/session", method: "POST", headers: {}, postData: "login=n&password=hunter2" } });
    const [before, login] = c.list({}).requests.map((r) => r.id);
    const fetch = vi.fn(async () => ({ body: "ok" }));
    const blocked = (start: number) => start >= 1500;
    await expect(c.get(login, fetch, { blocked })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await c.get(before, fetch, { blocked })).body).toBe("ok");
  });
});

describe("network.waitFor", () => {
  it("resolves on a later matching request and ignores earlier ones", async () => {
    const c = new Capture();
    req(c, "1", "http://a.test/api/data.json");
    const p = c.waitFor({ url: "data.json", timeout: 1000 });
    req(c, "2", "http://a.test/other");
    req(c, "3", "http://a.test/api/data.json", { status: 201 });
    const r = await p;
    expect(r.status).toBe(201);
    expect(r.url).toBe("http://a.test/api/data.json");
  });
  it("matches on method and status", async () => {
    const c = new Capture();
    const p = c.waitFor({ method: "POST", status: 500, timeout: 1000 });
    req(c, "1", "http://a.test/x", { method: "POST", status: 200 });
    req(c, "2", "http://a.test/x", { method: "POST", status: 500 });
    expect((await p).status).toBe(500);
  });
  it("only completions count", async () => {
    const c = new Capture();
    const p = c.waitFor({ url: "x", timeout: 100 });
    req(c, "1", "http://a.test/x", { finish: false });
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("failed loads count as completions", async () => {
    const c = new Capture();
    const p = c.waitFor({ url: "x", timeout: 1000 });
    c.onEvent("Network.requestWillBeSent", { requestId: "9", type: "Fetch", request: { url: "http://a.test/x", method: "GET" } });
    c.onEvent("Network.loadingFailed", { requestId: "9", errorText: "net::ERR_FAILED" });
    expect((await p).failed).toBe("net::ERR_FAILED");
  });
  it("times out with TIMEOUT", async () => {
    const c = new Capture();
    await expect(c.waitFor({ url: "nope", timeout: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
