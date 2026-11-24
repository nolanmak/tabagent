// #61 Part B: per-handoff one-time tokens for the remote handoff page.
import { describe, expect, it } from "vitest";
import { HandoffRegistry } from "../src/handoff/registry";

function reg(opts: { alive?: (e: any) => boolean } = {}) {
  let now = 1_000_000;
  const changes: number[] = [];
  const r = new HandoffRegistry({ now: () => now, alive: opts.alive, onChange: (n) => changes.push(n) });
  return { r, changes, advance: (ms: number) => (now += ms) };
}
const INFO = { commandId: "c1", ws: "ws1", origin: "https://id.example", reason: "Selfie check", sessionLabel: "jarvis", ttlMs: 30 * 60_000 };

describe("handoff registry: token lifecycle", () => {
  it("mints an unguessable id and token per handoff", () => {
    const { r } = reg();
    const a = r.create(INFO);
    const b = r.create({ ...INFO, commandId: "c2" });
    expect(a.entry.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(a.token).not.toBe(b.token);
    expect(a.entry.id).not.toBe(b.entry.id);
    // the plaintext token is not kept on the entry
    expect(JSON.stringify(a.entry)).not.toContain(a.token);
  });

  it("the URL token is valid only for its own handoff", () => {
    const { r } = reg();
    const a = r.create(INFO);
    const b = r.create({ ...INFO, commandId: "c2" });
    expect(r.checkToken(a.entry.id, a.token)).toBeTruthy();
    expect(r.checkToken(b.entry.id, a.token)).toBeNull();
    expect(r.checkToken(a.entry.id, "")).toBeNull();
    expect(r.checkToken(a.entry.id, a.token.slice(0, -1) + (a.token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(r.checkToken("0".repeat(32), a.token)).toBeNull();
  });

  it("claim is one-time: the token becomes a browser cookie and cannot be claimed again", () => {
    const { r } = reg();
    const a = r.create(INFO);
    const cookie = r.claim(a.entry.id, a.token);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).not.toBe(a.token);
    expect(r.claim(a.entry.id, a.token)).toBeNull();
    expect(r.checkToken(a.entry.id, a.token)).toBeNull();
    expect(r.checkCookie(a.entry.id, cookie!)).toBeTruthy();
    expect(r.checkCookie(a.entry.id, a.token)).toBeNull();
    const b = r.create({ ...INFO, commandId: "c2" });
    expect(r.checkCookie(b.entry.id, cookie!)).toBeNull();
  });

  it("revoke ends the token and the cookie", () => {
    const { r, changes } = reg();
    const a = r.create(INFO);
    const cookie = r.claim(a.entry.id, a.token)!;
    expect(r.revoke(a.entry.id)).toBe(true);
    expect(r.checkCookie(a.entry.id, cookie)).toBeNull();
    expect(r.get(a.entry.id)).toBeUndefined();
    expect(r.revoke(a.entry.id)).toBe(false);
    expect(changes).toEqual([1, 0]);
  });

  it("expires at the handoff timeout", () => {
    const { r, advance } = reg();
    const a = r.create({ ...INFO, ttlMs: 60_000 });
    expect(a.entry.expiresAt).toBe(1_000_000 + 60_000);
    advance(59_999);
    expect(r.checkToken(a.entry.id, a.token)).toBeTruthy();
    advance(2);
    expect(r.checkToken(a.entry.id, a.token)).toBeNull();
    expect(r.size).toBe(0);
  });

  it("an entry whose command is no longer in flight is revoked on lookup", () => {
    let live = true;
    const { r } = reg({ alive: () => live });
    const a = r.create(INFO);
    const cookie = r.claim(a.entry.id, a.token)!;
    live = false;
    expect(r.checkCookie(a.entry.id, cookie)).toBeNull();
    expect(r.size).toBe(0);
  });

  it("revokeWhere / revokeAll (socket closed, kill switch)", () => {
    const { r } = reg();
    r.create(INFO);
    r.create({ ...INFO, commandId: "c2", ws: "ws2" });
    r.create({ ...INFO, commandId: "c3", ws: "ws2" });
    expect(r.revokeWhere((e) => e.ws === "ws2")).toBe(2);
    expect(r.size).toBe(1);
    r.revokeAll();
    expect(r.size).toBe(0);
  });

  it("finds the entry of a command", () => {
    const { r } = reg();
    const a = r.create(INFO);
    expect(r.byCommand("c1")?.id).toBe(a.entry.id);
    expect(r.byCommand("nope")).toBeUndefined();
  });
});
