// js.eval, console.list, network.*, cookies.get, storage.get (#17, #18, D18 c/d).
import { originOf, TabAgentError, TIMEOUTS } from "@tabagent/protocol";
import { cookieUrlFor } from "../../pure/cookies";
import { runEval } from "../../pure/jseval";
import { tabState } from "../capture";
import { cdp, onTab, type Ctx, type TabCtx } from "./ctx";
import { staticGate } from "./gates";

type Handler = (c: Ctx) => Promise<unknown>;

function needCdp(t: TabCtx, tool: string) {
  if (t.drv.kind !== "cdp") throw new TabAgentError("UNSUPPORTED", `${tool} is not available in lite mode`, "Remove this site from Lite sites in the TabAgent side panel.");
  return cdp(t.drv).tab;
}

export const devHandlers: Record<string, Handler> = {
  async "js.eval"(c) {
    return onTab(c, "full", async (t) => {
      const tab = needCdp(t, "js.eval");
      await staticGate(c, t.url, "c", `run JavaScript: ${String(c.p.expression).slice(0, 120)}`, ["Runs code in the page with access to its data"]);
      await tab.ensure();
      tab.assertNoDialog();
      return runEval((m, p) => tab.send(m, p), { expression: c.p.expression, world: c.p.world ?? "main", frameId: tab.mainFrameId!, timeout: c.p.timeout ?? TIMEOUTS.action });
    });
  },

  async "console.list"(c) {
    return onTab(c, "read", async (t) => {
      await needCdp(t, "console.list").ensure();
      return tabState(t.tabId).capture.consoleList({ level: c.p.level, limit: c.p.limit });
    });
  },

  async "network.list"(c) {
    return onTab(c, "read", async (t) => {
      await needCdp(t, "network.list").ensure();
      return tabState(t.tabId).capture.list({ url: c.p.url, method: c.p.method, status: c.p.status, type: c.p.type ?? c.p.resourceType, limit: c.p.limit });
    });
  },

  async "network.get"(c) {
    return onTab(c, "full", async (t) => {
      const tab = needCdp(t, "network.get");
      const id = String(c.p.id ?? c.p.requestId);
      await staticGate(c, t.url, "d", `read request ${id} (headers and body)`, ["Request and response headers can include cookies and tokens"]);
      await tab.ensure();
      return tabState(t.tabId).capture.get(id, (requestId, sessionId) => tab.send("Network.getResponseBody", { requestId }, sessionId));
    });
  },

  async "network.waitFor"(c) {
    return onTab(
      c,
      "read",
      async (t) => {
        await needCdp(t, "network.waitFor").ensure();
        const r = await tabState(t.tabId).capture.waitFor({ url: c.p.url, method: c.p.method, status: c.p.status, timeout: c.p.timeout ?? TIMEOUTS.action });
        return { request: r, url: r.url };
      },
      { lock: false },
    );
  },

  async "cookies.get"(c) {
    return onTab(c, "full", async (t) => {
      const url = cookieUrlFor(t.url, c.p.url);
      await staticGate(c, t.url, "d", `read cookies for ${originOf(url)}`, ["Cookies can include session credentials"]);
      const cookies = await chrome.cookies.getAll({ url });
      return { origin: originOf(url), cookies: cookies.map((k) => ({ name: k.name, value: k.value, domain: k.domain, path: k.path, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite, ...(k.expirationDate ? { expires: k.expirationDate } : {}) })) };
    });
  },

  async "storage.get"(c) {
    return onTab(c, "full", async (t) => {
      await staticGate(c, t.url, "d", `read ${c.p.kind}Storage for ${originOf(t.url)}`, ["Web storage can include tokens"]);
      return t.drv.call("storage", [c.p.kind]);
    });
  },
};
