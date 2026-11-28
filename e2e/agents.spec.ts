// Send to agent (docs/specs/agent-inbox.md): the panel's ui.* messages through the real worker, the
// real bridge process and its /ext socket, against a stub `claude` on PATH and a fake Codex app-server.
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { claudeRecord, codexThread, FakeCodex, StubClaude } from "../packages/bridge/test/agents-fakes";
import { Harness } from "./harness";

interface W {
  h: Harness;
  claude: StubClaude;
  codex: FakeCodex;
  panel: Page;
}

const test = base.extend<{}, { w: W }>({
  w: [
    async ({}, use) => {
      const claude = new StubClaude();
      const codex = await new FakeCodex().listen();
      const oldPath = process.env.PATH;
      const oldSock = process.env.TABAGENT_CODEX_SOCKET;
      // Inherited by the bridge process the harness spawns.
      process.env.PATH = `${claude.dir}:${oldPath}`;
      process.env.TABAGENT_CODEX_SOCKET = codex.socket;
      const h = new Harness();
      try {
        await h.start();
      } finally {
        process.env.PATH = oldPath;
        if (oldSock === undefined) delete process.env.TABAGENT_CODEX_SOCKET;
        else process.env.TABAGENT_CODEX_SOCKET = oldSock;
      }
      const panel = await h.openPanel();
      await use({ h, claude, codex, panel });
      await h.stop();
      await codex.close();
      claude.cleanup();
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

/** Send a ui.* message from the side panel page, as the panel UI will (AD14 sender gate). */
function ui(w: W, msg: Record<string, unknown>): Promise<any> {
  return w.panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

test("ui.agents_list lists stub Claude and fake Codex agents; both sides advertise the agents feature", async ({ w }) => {
  w.claude.agents([claudeRecord(4242, 1795639119768, { cwd: w.claude.dir })]);
  w.codex.threads([codexThread("019a0000-0000-7000-8000-000000000001", { type: "idle" }, { name: "Codex thread" })]);
  const state = await ui(w, { type: "ui.state" });
  expect(state.agentsSupported).toBe(true);
  const r = await ui(w, { type: "ui.agents_list" });
  expect(r.supported).toBe(true);
  expect(r.sources).toEqual({ claude: "ok", codex: "ok" });
  const ids = r.agents.map((a: any) => `${a.id} ${a.delivery}`).sort();
  expect(ids).toEqual(["claude:4242:1795639119768 spawn", "codex:019a0000-0000-7000-8000-000000000001 queue"]);
  expect(w.claude.calls()).toEqual(["agents --json"]);
});
