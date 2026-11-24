// #61 Part B: tailnet detection and bind guard, the `handoff` config section, the webhook payload.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configCommand } from "../src/commands";
import { handoffTimeoutMs, readHandoffConfig, validateWebhookUrl } from "../src/handoff/config";
import { detectTailnetIp, isTailnetIPv4 } from "../src/handoff/tailnet";
import { startRemoteListener } from "../src/handoff/remote";
import { webhookPayload } from "../src/handoff/webhook";
import { tempHome } from "./helpers";

describe("tailnet address", () => {
  it("isTailnetIPv4 accepts only 100.64.0.0/10", () => {
    for (const ip of ["100.64.0.1", "100.100.100.100", "100.127.255.254"]) expect(isTailnetIPv4(ip)).toBe(true);
    for (const ip of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "0.0.0.0", "10.0.0.1", "192.168.1.2", "::", "::1", "fd7a:115c:a1e0::1", "100.64.0", "100.64.0.1.2", "abc", ""]) expect(isTailnetIPv4(ip)).toBe(false);
  });

  it("prefers `tailscale ip -4`", async () => {
    const ip = await detectTailnetIp({ exec: async () => "100.101.1.2\n", interfaces: () => ({}) });
    expect(ip).toBe("100.101.1.2");
  });

  it("ignores CLI output that is not a tailnet address", async () => {
    const ip = await detectTailnetIp({ exec: async () => "192.168.1.5\n", interfaces: () => ({}) });
    expect(ip).toBeNull();
  });

  it("falls back to a tailscale* interface only (carrier CGNAT on other interfaces is not the tailnet)", async () => {
    const ifaces = {
      en0: [{ address: "100.70.1.1", family: "IPv4", internal: false }],
      tailscale0: [
        { address: "fd7a::1", family: "IPv6", internal: false },
        { address: "100.88.7.6", family: "IPv4", internal: false },
      ],
    } as any;
    expect(await detectTailnetIp({ exec: async () => Promise.reject(new Error("ENOENT")), interfaces: () => ifaces })).toBe("100.88.7.6");
    expect(await detectTailnetIp({ exec: async () => Promise.reject(new Error("ENOENT")), interfaces: () => ({ en0: ifaces.en0 }) })).toBeNull();
  });

  it("the remote listener refuses any address outside the tailnet", async () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "::", "192.168.1.2", "100.128.0.1"]) {
      await expect(startRemoteListener(() => {}, ip, 0)).rejects.toThrow(/tailnet/);
    }
  });

  it("the remote listener binds exactly the tailnet address it was given (never a wildcard)", async () => {
    // 100.127.255.254 is not on this machine: binding that exact address must fail, which proves no wildcard bind.
    await expect(startRemoteListener(() => {}, "100.127.255.254", 0)).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});

describe("handoff config", () => {
  it("defaults: remote off, no webhook, 5 min; remote on → 30 min; timeoutMin overrides and is clamped", () => {
    expect(readHandoffConfig("/nonexistent/config.json")).toEqual({ remote: false, webhook: null, timeoutMin: null });
    expect(handoffTimeoutMs({ remote: false, webhook: null, timeoutMin: null })).toBe(5 * 60_000);
    expect(handoffTimeoutMs({ remote: true, webhook: null, timeoutMin: null })).toBe(30 * 60_000);
    expect(handoffTimeoutMs({ remote: true, webhook: null, timeoutMin: 12 })).toBe(12 * 60_000);
    expect(handoffTimeoutMs({ remote: false, webhook: null, timeoutMin: 9999 })).toBe(120 * 60_000);
    expect(handoffTimeoutMs({ remote: false, webhook: null, timeoutMin: 0 })).toBe(60_000);
  });

  it("webhook URL: https anywhere; plain http only to loopback or the tailnet", () => {
    for (const u of ["https://hooks.example.com/x", "http://127.0.0.1:8080/h", "http://localhost/h", "http://100.90.1.1:9000/h", "http://legion.tail1234.ts.net/h"]) expect(validateWebhookUrl(u)).toBe(u);
    for (const u of ["http://hooks.example.com/x", "ftp://x", "not a url", "javascript:alert(1)"]) expect(() => validateWebhookUrl(u)).toThrow();
  });

  it("`tabagent config handoff.*` writes the handoff section and keeps other keys", () => {
    const home = tempHome();
    expect(configCommand(["handoff.remote", "on"]).code).toBe(0);
    expect(configCommand(["handoff.webhook", "https://hooks.example.com/abc"]).code).toBe(0);
    expect(configCommand(["handoff.timeoutMin", "45"]).code).toBe(0);
    let raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.handoff).toEqual({ remote: true, webhook: "https://hooks.example.com/abc", timeoutMin: 45 });
    expect(raw.secret).toBeTruthy();
    expect(configCommand(["handoff.webhook", "http://evil.example.com/x"]).code).toBe(1);
    expect(configCommand(["handoff.remote", "maybe"]).code).toBe(1);
    expect(configCommand(["handoff.timeoutMin", "default"]).code).toBe(0);
    expect(configCommand(["handoff.webhook", "off"]).code).toBe(0);
    expect(configCommand(["handoff.remote", "off"]).code).toBe(0);
    raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.handoff).toEqual({ remote: false, webhook: null, timeoutMin: null });
    expect(configCommand(["handoff.nope", "x"]).code).toBe(1);
  });
});

describe("webhook payload", () => {
  it("carries origin, reason, link, expiry and session label, and nothing from the page", () => {
    const p = webhookPayload({ origin: "https://id.example", reason: "Selfie check", sessionLabel: "jarvis", url: "http://100.1.2.3:47615/handoff/abc?t=tok", expiresAt: Date.UTC(2026, 10, 24, 12, 0, 0) });
    expect(p).toEqual({
      event: "handoff.start",
      origin: "https://id.example",
      reason: "Selfie check",
      url: "http://100.1.2.3:47615/handoff/abc?t=tok",
      expiresAt: "2026-11-24T12:00:00.000Z",
      session: "jarvis",
    });
    expect(webhookPayload({ origin: "https://a.b", reason: "r", sessionLabel: "s", url: null, expiresAt: 0 }).url).toBeNull();
  });
});
