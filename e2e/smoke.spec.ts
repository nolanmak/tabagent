import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixture";

const RUN_STARTED = Date.now();

test("pair, list tools, open a tab, navigate, list it", async ({ h }) => {
  // the harness launched Chromium, found the service worker, started the bridge and paired through the pairing page
  expect(h.sw.url()).toContain("background.js");
  expect(await h.sw.evaluate(() => (globalThis as any).__tabagent.status())).toBe("connected");
  const c = await h.mcp();
  const { tools } = await c.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["nav_back", "nav_forward", "nav_goto", "nav_reload", "tabs"]);
  const core = await h.mcp({ profile: "core" });
  expect((await core.listTools()).tools.map((t) => t.name).sort()).toEqual(["nav_goto", "tabs"]);
  const t = await h.ok(c, "tabs", { action: "new" });
  expect(t.json).toMatchObject({ tabId: expect.any(Number), url: "about:blank" });
  const nav = await h.ok(c, "nav.goto", { url: `${h.A}/index.html` });
  expect(nav.json.title).toBe("Fixtures home");
  const list = await h.ok(c, "tabs", { action: "list" });
  expect(list.json.tabs).toEqual([{ tabId: t.json.tabId, url: `${h.A}/index.html`, title: "Fixtures home", active: true }]);
});

test("harness isolation: temp TABAGENT_HOME and a free port; the developer's ~/.tabagent is untouched", async ({ h }) => {
  expect(h.home.startsWith(tmpdir()) || h.home.startsWith("/var/") || h.home.startsWith("/private/")).toBe(true);
  expect(h.port).not.toBe(47615);
  expect(statSync(join(h.home, "config.json")).isFile()).toBe(true);
  let realMtime = 0;
  try {
    realMtime = statSync(join(homedir(), ".tabagent", "config.json")).mtimeMs;
  } catch {
    /* no real config: nothing was written there either */
  }
  expect(realMtime).toBeLessThan(RUN_STARTED);
});
