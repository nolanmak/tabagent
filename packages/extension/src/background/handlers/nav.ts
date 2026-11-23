// nav.goto / back / forward / reload / wait (#26, D15, D24, D35).
import { driverFor } from "../driver";
import { noteAction } from "../downloads";
import { taErr } from "../errors";
import { requireSite } from "../permissions";
import { baselines } from "../refstore";
import { resolveTab } from "../sessions";
import { assertLiteSupport, assertNoDialog, levelOf, onTab, titleOf, withTabLock, type Ctx } from "../tabctx";
import { describeWait, normalizeWait, pollUntil, urlMatcher } from "../wait";

type Handler = (c: Ctx) => Promise<unknown>;

const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

async function navResult(tabId: number, r: { url: string; warning?: string }, kind: string) {
  const title = await titleOf(tabId);
  return { ...r, title, __side: { navigation: { url: r.url, title, kind } } };
}

export const navHandlers: Record<string, Handler> = {
  async "nav.goto"(c) {
    const { url, waitUntil = "load", timeout = 30000 } = c.p;
    let target = String(url);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = "https://" + target;
    noteAction(c.meta.id);
    // D16: the target origin is checked before navigating.
    await requireSite(c.meta, target, levelOf(c, "act"), c.tool.name, `open ${target}`);
    const tabId = await resolveTab(c.s, c.p.tabId, true);
    return withTabLock(tabId, async () => {
      assertNoDialog(tabId, c.tool.name);
      const drv = await driverFor(tabId, target);
      assertLiteSupport(drv, c.tool);
      baselines.clearTab(tabId);
      const r = await drv.navigate(target, waitUntil, timeout);
      return navResult(tabId, r, "navigate");
    });
  },

  async "nav.back"(c) {
    return onTab(c, levelOf(c, "act"), async (t) => {
      await t.drv.history("back", c.p.timeout ?? 30000);
      return navResult(t.tabId, { url: await t.drv.currentUrl() }, "back");
    });
  },
  async "nav.forward"(c) {
    return onTab(c, levelOf(c, "act"), async (t) => {
      await t.drv.history("forward", c.p.timeout ?? 30000);
      return navResult(t.tabId, { url: await t.drv.currentUrl() }, "forward");
    });
  },
  async "nav.reload"(c) {
    return onTab(c, levelOf(c, "act"), async (t) => {
      await t.drv.history("reload", c.p.timeout ?? 30000);
      return navResult(t.tabId, { url: await t.drv.currentUrl() }, "reload");
    });
  },

  async "nav.wait"(c) {
    const w = normalizeWait(c.p);
    return onTab(
      c,
      "read",
      async (t) => {
        const started = Date.now();
        let ok = false;
        switch (w.kind) {
          case "load":
            ok = await t.drv.waitLoad(w.timeout);
            break;
          case "networkidle":
            ok = await t.drv.networkIdle(500, w.timeout);
            break;
          case "selector":
            ok = await pollUntil(async () => !!(await t.drv.call("waitSelector", [w.value])), w.timeout, clock, 100);
            break;
          case "text":
            ok = await pollUntil(async () => !!(await t.drv.call("waitText", [w.value])), w.timeout, clock, 100);
            break;
          case "url": {
            const m = urlMatcher(w.value!);
            ok = await pollUntil(async () => m(await t.drv.currentUrl()), w.timeout, clock, 100);
            break;
          }
          case "fn":
            // D18(c): the router's sensitive gate ran before we got here (registry sensitiveWhen for=fn).
            if (t.drv.kind !== "cdp") throw taErr("UNSUPPORTED", "nav.wait for=fn needs full (debugger) mode");
            ok = await pollUntil(async () => !!(await t.drv.evaluate(`!!(${w.value})`, "isolated")), w.timeout, clock, 100);
            break;
        }
        if (!ok) throw taErr("TIMEOUT", `Timed out after ${w.timeout}ms waiting for ${describeWait(w)}`, "Take a page.snapshot to see the current state.");
        return { ok: true, waitedMs: Date.now() - started, url: await t.drv.currentUrl() };
      },
      { lock: false },
    );
  },
};
