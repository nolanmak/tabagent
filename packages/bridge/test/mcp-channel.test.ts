// P3 channel route, proxy side (spec AD9, spike §2): the stdio proxy's MCP server declares
// experimental["claude/channel"] only when the argv check passed, forwards a channel push as
// notifications/claude/channel, and ignores (and reports) any channel permission method.
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, channelPushHandler, CHANNEL_CAPABILITY, CHANNEL_NOTIFICATION } from "../src/mcp";

const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function connect(o: { channels?: boolean; onIgnored?: (m: string) => void } = {}) {
  const server = buildMcpServer({ call: async () => ({ ok: true }), profile: "core", ...o });
  const client = new Client({ name: "claude-code", version: "2.1.332" });
  const got: { method: string; params?: any }[] = [];
  client.fallbackNotificationHandler = async (n) => void got.push(n);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  open.push(client);
  return { server, client, got };
}

async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met");
}

describe("capability gating (AD9)", () => {
  it('declares experimental["claude/channel"] when the argv check passed', async () => {
    const { client } = await connect({ channels: true });
    const caps = client.getServerCapabilities()!;
    expect(caps.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    expect(caps.tools).toBeDefined();
  });
  it("declares nothing experimental otherwise (the default)", async () => {
    for (const o of [{}, { channels: false }]) {
      const { client } = await connect(o);
      expect(client.getServerCapabilities()!.experimental).toBeUndefined();
    }
  });
  it("never declares a permission-relay capability", async () => {
    const { client } = await connect({ channels: true });
    expect(JSON.stringify(client.getServerCapabilities())).not.toMatch(/permission/);
  });
});

describe("channel push (AD9, spike §2)", () => {
  it("forwards {kind: channel, content} as notifications/claude/channel with meta.source tabagent", async () => {
    const { server, got } = await connect({ channels: true });
    await channelPushHandler(server, true)({ msgId: "m1", kind: "channel", content: "[TabAgent: message from the user via the side panel]\nhi" });
    await until(() => got.length === 1);
    expect(CHANNEL_NOTIFICATION).toBe("notifications/claude/channel");
    // The exact wire shape the P0 spike verified.
    expect(got[0]).toEqual({ jsonrpc: "2.0", method: CHANNEL_NOTIFICATION, params: { content: "[TabAgent: message from the user via the side panel]\nhi", meta: { source: "tabagent" } } });
  });
  it("refuses (throws, so the proxy never acks) when channels were not declared", async () => {
    const { server, got } = await connect();
    await expect(channelPushHandler(server, false)({ msgId: "m1", kind: "channel", content: "x" })).rejects.toThrow(/not declared/);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
  });
  it("refuses an unknown push kind or a channel push without text content", async () => {
    const { server } = await connect({ channels: true });
    const push = channelPushHandler(server, true);
    await expect(push({ msgId: "m1", kind: "other", content: "x" })).rejects.toThrow(/kind/);
    await expect(push({ msgId: "m2", content: "x" })).rejects.toThrow(/kind/);
    await expect(push({ msgId: "m3", kind: "channel", content: 5 })).rejects.toThrow(/content/);
  });
});

describe("channel permission requests are ignored (AD9, §12)", () => {
  it("a notifications/claude/channel/permission_request is ignored and reported once", async () => {
    const ignored: string[] = [];
    const { client, got } = await connect({ channels: true, onIgnored: (m) => ignored.push(m) });
    await client.notification({ method: "notifications/claude/channel/permission_request", params: { request_id: "r1", tool_name: "Bash" } } as any);
    await until(() => ignored.length === 1);
    expect(ignored).toEqual(["notifications/claude/channel/permission_request"]);
    // Nothing is sent back, and the session still works.
    expect(got).toEqual([]);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
  it("a channel permission request (JSON-RPC request) is reported and answered method-not-found", async () => {
    const ignored: string[] = [];
    const { client } = await connect({ onIgnored: (m) => ignored.push(m) });
    const { z } = await import("zod");
    await expect(client.request({ method: "claude/channel/permission_request", params: {} } as any, z.object({}).passthrough())).rejects.toThrow(/not found/i);
    expect(ignored).toEqual(["claude/channel/permission_request"]);
  });
  it("other unknown notifications and requests are not reported", async () => {
    const ignored: string[] = [];
    const { client } = await connect({ onIgnored: (m) => ignored.push(m) });
    await client.notification({ method: "notifications/something_else" } as any);
    const { z } = await import("zod");
    await expect(client.request({ method: "nope/nothing", params: {} } as any, z.object({}).passthrough())).rejects.toThrow(/not found/i);
    await new Promise((r) => setTimeout(r, 20));
    expect(ignored).toEqual([]);
  });
});
