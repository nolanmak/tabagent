// #108: `tabagent approve`. macOS only (LocalAuthentication); everything else refuses and points to the
// side panel or the phone page. The CLI never sends anything that could stand in for presence: the
// bridge runs the Touch ID / password check itself.
import { describe, expect, it } from "vitest";
import type { MirroredPrompt } from "@tabagent/protocol";
import { approveCommand } from "../src/commands";

const P = (id: string, over: Partial<MirroredPrompt> = {}): MirroredPrompt => ({
  promptId: id,
  title: `jarvis wants to read https://${id}.example`,
  detail: "It will be able to see page content.",
  summary: `open https://${id}.example/`,
  reasons: ["first visit"],
  tool: "nav.goto",
  sessionLabel: "jarvis",
  origin: `https://${id}.example`,
  expires: 100_000,
  answers: ["deny", "always", "once"],
  alwaysLabel: "Always allow read",
  ...over,
});

function api(list: unknown, answerReply: unknown = { ok: true, outcome: "applied", channel: "cli-presence" }) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fn = async (path: string, method = "GET", body?: unknown) => {
    calls.push({ path, method, body });
    if (path === "/v1/approvals") return list;
    if (path === "/v1/approvals/answer") return answerReply;
    if (path === "/v1/approvals/phone") return { ok: true, url: "http://100.100.100.100:47615/approve/abc?t=xyz", expiresAt: 3_700_000 };
    return { ok: false };
  };
  return { calls, fn };
}

const listed = (prompts: MirroredPrompt[], enabled = true) => ({ ok: true, enabled, presence: "macos-localauthentication", prompts });
const deps = (a: ReturnType<typeof api>, platform: NodeJS.Platform = "darwin") => ({ platform, api: a.fn, now: () => 40_000 });

describe("tabagent approve", () => {
  it.each(["linux", "win32", "freebsd"] as const)("refuses on %s and points to the side panel or the phone page", async (platform) => {
    const a = api(listed([P("a")]));
    const o = await approveCommand(["1", "once"], {}, deps(a, platform));
    expect(o.code).toBe(1);
    const text = o.err.join("\n");
    expect(text).toMatch(/macOS/);
    expect(text).toMatch(/side panel/);
    expect(text).toMatch(/phone/);
    expect(a.calls).toEqual([]);
  });
  it("lists pending prompts with the panel's exact text", async () => {
    const a = api(listed([P("a"), P("b", { answers: ["deny", "once"], alwaysLabel: undefined })]));
    const o = await approveCommand([], {}, deps(a));
    expect(o.code).toBe(0);
    const text = o.out.join("\n");
    for (const s of [P("a").title, P("a").detail, P("a").summary, "- first visit", "Tool: nav.goto", "60s left", P("b").title]) expect(text).toContain(s);
    expect(text).toContain("1. ");
    expect(text).toContain("2. ");
    expect(text).toMatch(/once \| always \| deny/);
    expect(text).toMatch(/once \| deny(?! \|)/);
    expect(text).toMatch(/tabagent approve <number> once\|always\|deny/);
  });
  it("says so when nothing is pending", async () => {
    const o = await approveCommand([], {}, deps(api(listed([]))));
    expect(o.code).toBe(0);
    expect(o.out.join("\n")).toMatch(/No pending/);
  });
  it("explains how to turn outside approvals on when the panel has them off", async () => {
    const o = await approveCommand([], {}, deps(api(listed([], false))));
    expect(o.code).toBe(1);
    expect(o.err.join("\n")).toMatch(/side panel/);
  });
  it("answers by number or prompt id with only {promptId, answer}", async () => {
    const a = api(listed([P("a"), P("b")]));
    const o = await approveCommand(["2", "always"], {}, deps(a));
    expect(o.code).toBe(0);
    expect(a.calls.at(-1)).toEqual({ path: "/v1/approvals/answer", method: "POST", body: { promptId: "b", answer: "always" } });
    expect(o.out.join("\n")).toContain(`Always allow read: ${P("b").title}`);
    const b = api(listed([P("a"), P("b")]));
    await approveCommand(["a", "deny"], {}, deps(b));
    expect(b.calls.at(-1)?.body).toEqual({ promptId: "a", answer: "deny" });
  });
  it("no flag can skip presence: extra flags never reach the bridge", async () => {
    const a = api(listed([P("a")]));
    await approveCommand(["1", "once"], { "skip-presence": true, yes: true, force: true, proof: "x", "no-touch-id": true }, deps(a));
    expect(a.calls.at(-1)?.body).toEqual({ promptId: "a", answer: "once" });
  });
  it("refuses an answer the prompt does not offer without calling the bridge", async () => {
    const a = api(listed([P("a", { answers: ["deny", "once"], alwaysLabel: undefined })]));
    const o = await approveCommand(["1", "always"], {}, deps(a));
    expect(o.code).toBe(1);
    expect(o.err.join("\n")).toMatch(/offers once \| deny/);
    expect(a.calls.map((c) => c.path)).toEqual(["/v1/approvals"]);
  });
  it("rejects bad input", async () => {
    expect((await approveCommand(["9", "once"], {}, deps(api(listed([P("a")]))))).code).toBe(1);
    expect((await approveCommand(["1", "maybe"], {}, deps(api(listed([P("a")]))))).code).toBe(1);
  });
  it("reports already answered, presence failures and expiry", async () => {
    const cases: [unknown, RegExp][] = [
      [{ ok: false, outcome: "already_answered", by: "panel" }, /already answered.*side panel/i],
      [{ ok: false, outcome: "presence_failed", error: { code: "PERMISSION_DENIED", message: "Touch ID or password was not confirmed" } }, /not confirmed/],
      [{ ok: false, outcome: "expired" }, /expired/i],
    ];
    for (const [reply, re] of cases) {
      const o = await approveCommand(["1", "once"], {}, deps(api(listed([P("a")]), reply)));
      expect(o.code).toBe(1);
      expect(o.err.join("\n")).toMatch(re);
    }
  });
  it("--phone prints the one-time link (the bridge asks for presence first)", async () => {
    const a = api(listed([P("a")]));
    const o = await approveCommand([], { phone: true, ttl: "30" }, deps(a));
    expect(o.code).toBe(0);
    expect(a.calls.at(-1)).toEqual({ path: "/v1/approvals/phone", method: "POST", body: { ttlMin: 30 } });
    expect(o.out.join("\n")).toContain("http://100.100.100.100:47615/approve/abc?t=xyz");
  });
});
