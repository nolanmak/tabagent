// #108: answering prompts outside the side panel, end to end with the real extension. The bridge runs in
// this process with a TEST-ONLY presence provider (simulated Touch ID) and a loopback stand-in for the
// tailnet listener; the built CLI cannot select either (see approvals-presence.test.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Harness } from "./harness";
import { fakePresence, type FakePresence } from "../packages/bridge/test/presence-fakes";

const presence: FakePresence = fakePresence("ok");

async function loopbackListen(handler: RequestListener) {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    ip: "127.0.0.1", // test seam only: production binds the tailnet address and refuses anything else
    port,
    close: async () => {
      const done = new Promise<void>((r) => srv.close(() => r()));
      srv.closeAllConnections?.();
      await done;
    },
  };
}

const test = base.extend<{}, { h: Harness }>({
  h: [
    async ({}, use) => {
      const h = new Harness({ inProcess: async () => ({ presence, handoffListen: loopbackListen }) });
      await h.start();
      await use(h);
      await h.stop();
    },
    { scope: "worker", timeout: 60_000 },
  ],
});
test.describe.configure({ mode: "serial" });

const bridgeApi = async (h: Harness, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${h.daemon.cfg.secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

const decisions = (h: Harness) =>
  readFileSync(join(h.home, "audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "decision");

/** Start a call that raises a site prompt; resolves with the pending prompt and the call's promise. */
async function raisePrompt(h: Harness, label: string, path = "/index.html") {
  await h.setPolicies({}, { paused: false, devAllowSensitive: false });
  const c = await h.mcp({ label });
  const before = new Set((await h.pendingPrompts()).map((p) => p.promptId));
  const call = h.call(c, "nav.goto", { url: `${h.A}${path}` });
  call.catch(() => {});
  let prompt: any = null;
  await expect.poll(async () => (prompt = (await h.pendingPrompts()).find((p) => !before.has(p.promptId)) ?? null), { timeout: 15_000 }).not.toBeNull();
  return { prompt, call };
}

async function setOutside(h: Harness, on: boolean): Promise<Page> {
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  const box = panel.locator("#outsideApprovals");
  if (on) await box.check();
  else await box.uncheck();
  await expect.poll(async () => (await h.sw.evaluate(async () => (globalThis as any).__tabagent.getSettings())).outsideApprovals).toBe(on);
  return panel;
}

test("off by default: the bridge sees no prompts and refuses outside answers without asking for presence", async ({ h }) => {
  const { prompt, call } = await raisePrompt(h, "off-agent");
  const list = await bridgeApi(h, "/v1/approvals");
  expect(list.body).toMatchObject({ ok: true, enabled: false, prompts: [] });
  const calls = presence.calls.length;
  const r = await bridgeApi(h, "/v1/approvals/answer", { promptId: prompt.promptId, answer: "once" });
  expect(r.status).toBe(403);
  expect(r.body.outcome).toBe("disabled");
  expect(presence.calls.length).toBe(calls);
  await h.sw.evaluate((id) => (globalThis as any).__tabagent.answerPrompt(id, "deny"), prompt.promptId);
  expect((await call).text).toContain("PERMISSION_DENIED");
});

test("tabagent approve path: the mirrored text equals the panel's; presence applies the answer once and is audited", async ({ h }) => {
  const panel = await setOutside(h, true);
  const { prompt, call } = await raisePrompt(h, "cli-agent");
  let mirrored: any = null;
  await expect.poll(async () => (mirrored = (await bridgeApi(h, "/v1/approvals")).body.prompts.find((p: any) => p.promptId === prompt.promptId) ?? null)).not.toBeNull();
  const item = panel.locator(`li[data-prompt-id="${prompt.promptId}"]`);
  await item.waitFor();
  expect(mirrored.title).toBe(await item.locator(".ptitle").textContent());
  expect(mirrored.detail).toBe(await item.locator(".pdetail").textContent());
  expect(mirrored.summary).toBe(await item.locator(".psummary").textContent());
  expect(await item.locator("button").allTextContents()).toEqual(["Deny", "Always allow act", "Allow once"]);
  expect(mirrored.answers).toEqual(["deny", "always", "once"]);

  presence.behavior = "cancel";
  const denied = await bridgeApi(h, "/v1/approvals/answer", { promptId: prompt.promptId, answer: "once" });
  expect(denied.status).toBe(403);
  expect((await h.pendingPrompts()).some((p) => p.promptId === prompt.promptId)).toBe(true);
  await new Promise((r) => setTimeout(r, 10_500)); // cooldown after a cancelled check

  presence.behavior = "ok";
  const ok = await bridgeApi(h, "/v1/approvals/answer", { promptId: prompt.promptId, answer: "once" });
  expect(ok.body).toMatchObject({ ok: true, outcome: "applied", channel: "cli-presence" });
  expect((await call).isError).toBe(false);
  await expect.poll(() => decisions(h).find((e) => e.data?.promptId === prompt.promptId)?.data?.channel).toBe("cli-presence");
  const again = await bridgeApi(h, "/v1/approvals/answer", { promptId: prompt.promptId, answer: "deny" });
  expect(again.status).toBe(409);
  await panel.close();
});

test("phone page: link from the side panel, same text, Allow once applies with channel phone", async ({ h }) => {
  await h.sw.evaluate(async () => (globalThis as any).__tabagent.updateSettings({ outsideApprovals: true }));
  writeHandoffRemote(h, true);
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  await panel.click("#phoneLinkBtn");
  await expect(panel.locator("#phoneLink")).toContainText("/approve/");
  const url = (await panel.locator("#phoneLink").textContent())!.split("\n")[0];
  const { prompt, call } = await raisePrompt(h, "phone-agent", "/article.html");
  const phone = await h.ctx.newPage();
  await phone.goto(url);
  const card = phone.locator("li.p").filter({ hasText: "phone-agent" });
  await card.waitFor({ timeout: 10_000 });
  const item = panel.locator(`li[data-prompt-id="${prompt.promptId}"]`);
  await item.waitFor();
  expect(await card.locator(".title").textContent()).toBe(await item.locator(".ptitle").textContent());
  await card.locator("button.once").click();
  expect((await call).isError).toBe(false);
  await expect.poll(() => decisions(h).find((e) => e.data?.promptId === prompt.promptId)?.data?.channel).toBe("phone");
  await phone.close();
  await panel.close();
});

test("race: panel and phone answer at once, exactly one applies", async ({ h }) => {
  await h.sw.evaluate(async () => (globalThis as any).__tabagent.updateSettings({ outsideApprovals: true }));
  writeHandoffRemote(h, true);
  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  await panel.click("#phoneLinkBtn");
  await expect(panel.locator("#phoneLink")).toContainText("/approve/");
  const url = (await panel.locator("#phoneLink").textContent())!.split("\n")[0];
  const phone = await h.ctx.newPage();
  await phone.goto(url);
  await phone.locator("#status").waitFor();
  const { prompt, call } = await raisePrompt(h, "race-agent", "/table.html");
  const card = phone.locator("li.p").filter({ hasText: "race-agent" });
  await card.waitFor({ timeout: 10_000 });
  const item = panel.locator(`li[data-prompt-id="${prompt.promptId}"]`);
  await item.waitFor();
  const phoneAnswer = phone.evaluate(async (pid) => {
    const r = await fetch(location.pathname + "/answer", { method: "POST", headers: { "x-tabagent-handoff": "1", "content-type": "application/json" }, body: JSON.stringify({ promptId: pid, answer: "deny" }) });
    return (await r.json()).outcome;
  }, prompt.promptId);
  const panelAnswer = panel.evaluate((pid) => chrome.runtime.sendMessage({ type: "ui.answer", promptId: pid, answer: "once" }).then((r: any) => r.outcome), prompt.promptId);
  const outcomes = (await Promise.all([phoneAnswer, panelAnswer])).sort();
  expect(outcomes).toEqual(["already_answered", "applied"]);
  const ds = decisions(h).filter((e) => e.data?.promptId === prompt.promptId);
  await expect.poll(() => decisions(h).filter((e) => e.data?.promptId === prompt.promptId).length).toBe(1);
  expect(ds.length).toBeLessThanOrEqual(1);
  await call;
  await phone.close();
  await panel.close();
});

function writeHandoffRemote(h: Harness, on: boolean) {
  const p = join(h.home, "config.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  raw.handoff = { ...(raw.handoff ?? {}), remote: on };
  writeFileSync(p, JSON.stringify(raw, null, 2));
}
