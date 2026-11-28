// #108: the approval endpoints end to end (daemon + fake extension). The core rule under test: the bridge
// never sends an answer to the extension without a valid presence proof, and nothing a caller puts in
// the request can stand in for one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MirroredPrompt } from "@tabagent/protocol";
import { PromptQueue } from "../../extension/src/background/prompts";
import { mirrorMessage, onBridgeAnswer } from "../../extension/src/pure/promptMirror";
import { createToken } from "../src/tokens";
import { saveConfig } from "../src/config";
import type { Daemon } from "../src/daemon";
import { pairedExt, rest, startDaemon, type FakeExt } from "./helpers";
import { fakePresence, type FakePresence } from "./presence-fakes";

let daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
});

const P = (id: string, over: Partial<MirroredPrompt> = {}): MirroredPrompt => ({
  promptId: id,
  title: `jarvis wants to read https://${id}.example`,
  detail: "It will be able to see page content.",
  summary: `open https://${id}.example/`,
  reasons: [],
  tool: "nav.goto",
  sessionLabel: "jarvis",
  origin: `https://${id}.example`,
  expires: Date.now() + 120_000,
  answers: ["deny", "always", "once"],
  alwaysLabel: "Always allow read",
  ...over,
});

async function until(f: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
}

/** A fake extension that mirrors `prompts` and answers prompt.answer first-answer-wins. */
async function boot(presence: FakePresence = fakePresence("ok"), prompts: MirroredPrompt[] = [P("a")], enabled = true) {
  const r = await startDaemon({ presence });
  daemons.push(r.d);
  const ext = await pairedExt(r.d, undefined, ["files.resolve", "prompts.mirror"]);
  const answered = new Map<string, string>();
  ext.ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== "prompt.answer") return;
    const won = answered.get(m.promptId);
    if (won) return ext.send({ type: "prompt.answer.result", id: m.id, ok: false, outcome: "already_answered", by: won });
    answered.set(m.promptId, m.channel);
    ext.send({ type: "prompt.answer.result", id: m.id, ok: true, outcome: "applied" });
  });
  ext.send({ type: "prompts.sync", enabled, prompts });
  await until(() => r.d.approvals.prompts.enabled === enabled && r.d.approvals.prompts.size === (enabled ? prompts.length : 0));
  const answer = (promptId: string, answer: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => rest(r.base, "/v1/approvals/answer", r.cfg.secret, { promptId, answer, ...extra }, headers);
  return { ...r, ext, presence, answered, answer };
}

const answersSent = (ext: FakeExt) => ext.msgs.filter((m) => m.type === "prompt.answer");

describe("approvals: listing", () => {
  it("advertises the feature and lists the mirrored prompts with the panel's text", async () => {
    const c = await boot();
    const welcome = c.ext.msgs.find((m) => m.type === "welcome");
    expect(welcome.features).toContain("prompts.mirror");
    const r = await rest(c.base, "/v1/approvals", c.cfg.secret);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, enabled: true, presence: c.presence.kind });
    expect(r.body.prompts).toEqual([P("a", { expires: r.body.prompts[0].expires })]);
  });
  it("is for the local owner only: tokens get 403", async () => {
    const c = await boot();
    const tok = createToken(c.cfg, "agent", "full");
    saveConfig(c.cfg);
    expect((await rest(c.base, "/v1/approvals", tok)).status).toBe(403);
    expect((await rest(c.base, "/v1/approvals/answer", tok, { promptId: "a", answer: "once" })).status).toBe(403);
    expect((await rest(c.base, "/v1/approvals/phone", tok, {})).status).toBe(403);
    expect(c.presence.calls).toHaveLength(0);
  });
  it("needs a bearer credential", async () => {
    const c = await boot();
    expect((await rest(c.base, "/v1/approvals", null)).status).toBe(401);
  });
});

describe("approvals: no answer without presence", () => {
  it("presence cancelled -> 403, nothing reaches the extension", async () => {
    const c = await boot(fakePresence("cancel"));
    const r = await c.answer("a", "once");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, outcome: "presence_failed", error: { code: "PERMISSION_DENIED" } });
    expect(answersSent(c.ext)).toEqual([]);
  });
  it("a forged proof (wrong key) -> 403, nothing reaches the extension", async () => {
    const c = await boot(fakePresence("forge"));
    const r = await c.answer("a", "once");
    expect(r.status).toBe(403);
    expect(r.body.outcome).toBe("presence_failed");
    expect(answersSent(c.ext)).toEqual([]);
  });
  it("proof-looking fields and headers in the request are ignored: presence still runs and still decides", async () => {
    const c = await boot(fakePresence("cancel"));
    const r = await c.answer("a", "once", { proof: { challengeId: "x", mac: "y" }, presence: "ok", mac: "AAAA", challengeId: "x", skipPresence: true, channel: "panel" }, { "x-tabagent-presence": "ok" });
    expect(c.presence.calls).toHaveLength(1);
    expect(r.status).toBe(403);
    expect(answersSent(c.ext)).toEqual([]);
  });
  it("no presence on this platform -> 501 with a pointer to the panel or the phone page", async () => {
    const c = await boot(fakePresence("unavailable"));
    const r = await c.answer("a", "once");
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ ok: false, outcome: "presence_unavailable", error: { code: "UNSUPPORTED" } });
    expect(r.body.error.hint).toMatch(/side panel/);
    expect(answersSent(c.ext)).toEqual([]);
  });
  it("a replayed proof is rejected and nothing is sent twice", async () => {
    const c = await boot(fakePresence("ok"), [P("a"), P("b")]);
    expect((await c.answer("a", "once")).body).toMatchObject({ ok: true, outcome: "applied", channel: "cli-presence" });
    const used = c.presence.calls[0];
    const challengeId = /\|([0-9a-f]{32})\|/.exec(used.message)![1];
    const replay = await c.d.approvals.submit("a", "once", { kind: "local", challengeId, mac: c.presence.macs[0] });
    expect(replay).toMatchObject({ ok: false, outcome: "presence_failed" });
    const other = await c.d.approvals.submit("b", "once", { kind: "local", challengeId, mac: c.presence.macs[0] });
    expect(other).toMatchObject({ ok: false, outcome: "presence_failed" });
    expect(answersSent(c.ext)).toHaveLength(1);
  });
  it("submit without any proof is rejected", async () => {
    const c = await boot();
    for (const proof of [undefined, null, {}, { kind: "local" }, { kind: "phone" }, { kind: "panel" }, { kind: "local", challengeId: "a".repeat(32), mac: "AAAA" }]) {
      expect(await c.d.approvals.submit("a", "once", proof as any)).toMatchObject({ ok: false, outcome: "presence_failed" });
    }
    expect(answersSent(c.ext)).toEqual([]);
  });
});

describe("approvals: with presence", () => {
  it("applies once through the extension and audits the channel", async () => {
    const c = await boot();
    const r = await c.answer("a", "always");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: "applied", channel: "cli-presence" });
    expect(answersSent(c.ext).map(({ promptId, answer, channel }) => ({ promptId, answer, channel }))).toEqual([{ promptId: "a", answer: "always", channel: "cli-presence" }]);
    // The Touch ID dialog names the answer and the prompt, exactly as the panel shows them.
    expect(c.presence.calls[0].reason).toContain("Always allow read");
    expect(c.presence.calls[0].reason).toContain("jarvis wants to read https://a.example");
    const audit = readFileSync(join(c.home, "audit.jsonl"), "utf8");
    expect(audit).toMatch(/"event":"approval.presence".*"outcome":"ok"/);
    expect(audit).toMatch(/"event":"approval.answer".*"channel":"cli-presence"/);
    expect(audit).not.toContain(c.presence.macs[0]);
  });
  it("a second answer for a resolved prompt is 'already answered' and does not run presence", async () => {
    const c = await boot();
    await c.answer("a", "once");
    c.ext.send({ type: "prompts.sync", enabled: true, prompts: [] });
    await until(() => c.d.approvals.prompts.size === 0);
    const r = await c.answer("a", "deny");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, outcome: "already_answered" });
    expect(c.presence.calls).toHaveLength(1);
  });
  it("the extension's 'already answered' (panel won the race) is passed through", async () => {
    const c = await boot();
    c.answered.set("a", "panel");
    const r = await c.answer("a", "once");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, outcome: "already_answered", by: "panel" });
  });
  it("answers the prompt does not offer, unknown and expired prompts are refused before presence", async () => {
    const c = await boot(fakePresence("ok"), [P("a", { answers: ["deny", "once"], alwaysLabel: undefined }), P("old", { expires: Date.now() + 150 })]);
    expect((await c.answer("a", "always")).status).toBe(400);
    expect((await c.answer("a", "maybe")).status).toBe(400);
    expect((await c.answer("zzz", "once")).status).toBe(404);
    await new Promise((r) => setTimeout(r, 200));
    const exp = await c.answer("old", "once");
    expect(exp.status).toBe(410);
    expect(exp.body.outcome).toBe("expired");
    expect(c.presence.calls).toHaveLength(0);
  });
  it("outside approvals off in the side panel -> 403 disabled, no presence prompt", async () => {
    const c = await boot(fakePresence("ok"), [P("a")], false);
    const list = await rest(c.base, "/v1/approvals", c.cfg.secret);
    expect(list.body).toMatchObject({ enabled: false, prompts: [] });
    const r = await c.answer("a", "once");
    expect(r.status).toBe(403);
    expect(r.body.outcome).toBe("disabled");
    expect(c.presence.calls).toHaveLength(0);
  });
  it("one presence check at a time; a cancelled check starts a short cooldown", async () => {
    const hang = fakePresence("hang");
    const c = await boot(hang, [P("a"), P("b")]);
    const first = c.answer("a", "once");
    await until(() => hang.calls.length === 1);
    const busy = await c.answer("b", "once");
    expect(busy.status).toBe(429);
    hang.release!();
    expect((await first).status).toBe(200);
    hang.behavior = "cancel";
    expect((await c.answer("b", "once")).status).toBe(403);
    const cool = await c.answer("b", "once");
    expect(cool.status).toBe(429);
    expect(cool.body.error.message).toMatch(/wait/i);
  });
  it("no extension -> 503 and nothing is sent", async () => {
    const c = await boot();
    c.ext.close();
    await until(() => !c.d.extensionConnected);
    const r = await c.answer("a", "once");
    expect([404, 503]).toContain(r.status);
    expect(c.presence.calls).toHaveLength(0);
  });
});

describe("approvals: race against the real prompt queue", () => {
  it("panel and outside channels answer at once: exactly one applies, the others get 'already answered'", async () => {
    let id = 0;
    const q = new PromptQueue({ now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as any), newId: () => `q${++id}` });
    const r = await startDaemon({ presence: fakePresence("ok") });
    daemons.push(r.d);
    const ext = await pairedExt(r.d, undefined, ["prompts.mirror"]);
    const decided: string[] = [];
    q.on((e) => {
      if (e.type === "removed") decided.push(`${e.outcome}:${e.channel}`);
      ext.send(mirrorMessage(true, q.list()));
    });
    ext.ws.on("message", (raw) => {
      const reply = onBridgeAnswer(JSON.parse(String(raw)), true, (pid, a, ch) => q.answerAs(pid, a, ch));
      if (reply) ext.send(reply);
    });
    const p = q.request({ kind: "site", sessionId: "s", sessionLabel: "jarvis", origin: "https://a.example", level: "read", tool: "nav.goto", summary: "open", reasons: [] });
    await until(() => r.d.approvals.prompts.size === 1);
    const [cli, panel] = await Promise.all([rest(r.base, "/v1/approvals/answer", r.cfg.secret, { promptId: p.promptId, answer: "deny" }), Promise.resolve().then(() => q.answerAs(p.promptId, "once", "panel"))]);
    const outcomes = [cli.body.outcome, panel.outcome].sort();
    expect(outcomes).toEqual(["already_answered", "applied"]);
    expect(decided).toHaveLength(1);
  });
});
