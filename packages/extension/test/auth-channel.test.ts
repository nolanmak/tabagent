// DA2 secret channel client: request/response by id, commandId binding, timeouts, kill.
import { describe, expect, it, vi } from "vitest";
import { createAuthChannel } from "../src/background/auth/pure/channel";

function setup(sendOk = true) {
  const sent: any[] = [];
  let id = 0;
  const timers: (() => void)[] = [];
  const ch = createAuthChannel({
    send: (m) => (sent.push(m), sendOk),
    newId: () => `m${++id}`,
    setTimeout: (fn) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
  });
  return { ch, sent, timers };
}

describe("auth channel", () => {
  it("accounts: sends auth.accounts with commandId + origin, resolves on the matching result", async () => {
    const { ch, sent } = setup();
    const p = ch.accounts("cmd1", "https://github.com");
    expect(sent[0]).toEqual({ type: "auth.accounts", origin: "https://github.com", id: "m1", commandId: "cmd1" });
    expect(ch.onMessage({ type: "auth.accounts.result", id: "m1", ok: true, accounts: [] })).toBe(true);
    await expect(p).resolves.toMatchObject({ ok: true, accounts: [] });
  });

  it("secret: resolves with the value for the right id/commandId/field only", async () => {
    const { ch, sent } = setup();
    const p = ch.secret("cmd1", "1password:abc", "password");
    expect(sent[0]).toEqual({ type: "auth.secret.request", accountId: "1password:abc", field: "password", id: "m1", commandId: "cmd1" });
    ch.onMessage({ type: "secret", id: "m1", commandId: "other", field: "password", ok: true, value: "WRONG" });
    ch.onMessage({ type: "secret", id: "m1", commandId: "cmd1", field: "username", ok: true, value: "WRONG" });
    expect(ch.pendingCount()).toBe(1);
    ch.onMessage({ type: "secret", id: "m1", commandId: "cmd1", field: "password", ok: true, value: "s3cret" });
    await expect(p).resolves.toBe("s3cret");
    expect(ch.pendingCount()).toBe(0);
  });

  it("totp request expects a field:code reply", async () => {
    const { ch } = setup();
    const p = ch.secret("c", "bitwarden:x", "totp");
    ch.onMessage({ type: "secret", id: "m1", commandId: "c", field: "code", ok: true, value: "123456" });
    await expect(p).resolves.toBe("123456");
  });

  it("sms code request carries since + timeout", async () => {
    const { ch, sent } = setup();
    const p = ch.smsCode("c", 1000, 60000);
    expect(sent[0]).toMatchObject({ type: "auth.code.request", source: "sms", since: 1000, timeout: 60000, commandId: "c" });
    ch.onMessage({ type: "secret", id: "m1", commandId: "c", field: "code", ok: true, value: "654321" });
    await expect(p).resolves.toBe("654321");
  });

  it("bridge error → TabAgentError with its code", async () => {
    const { ch } = setup();
    const p = ch.secret("c", "1password:abc", "password");
    ch.onMessage({ type: "secret", id: "m1", commandId: "c", field: "password", ok: false, error: { code: "PERMISSION_DENIED", message: "not in flight" } });
    await expect(p).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("not connected → NO_EXTENSION", async () => {
    const { ch } = setup(false);
    await expect(ch.accounts("c", "https://x.com")).rejects.toMatchObject({ code: "NO_EXTENSION" });
  });

  it("timeout → TIMEOUT", async () => {
    const { ch, timers } = setup();
    const p = ch.secret("c", "1password:abc", "password");
    timers[0]();
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("kill rejects everything pending; late replies are dropped", async () => {
    const { ch } = setup();
    const p = ch.secret("c", "1password:abc", "password");
    ch.rejectAll(Object.assign(new Error("killed"), { code: "KILLED" }));
    await expect(p).rejects.toMatchObject({ code: "KILLED" });
    expect(ch.onMessage({ type: "secret", id: "m1", commandId: "c", field: "password", ok: true, value: "late" })).toBe(true);
  });

  it("ignores non-auth messages", () => {
    const { ch } = setup();
    expect(ch.onMessage({ type: "command" })).toBe(false);
    expect(ch.onMessage(null)).toBe(false);
  });
});
