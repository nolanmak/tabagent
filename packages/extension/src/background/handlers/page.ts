// page.snapshot, page.screenshot, page.find (#6, #8, #26).
import { baselines } from "../refstore";
import { normalizeFind } from "../wait";
import { onTab, titleOf, type Ctx } from "../tabctx";

type Handler = (c: Ctx) => Promise<unknown>;

export const pageHandlers: Record<string, Handler> = {
  async "page.snapshot"(c) {
    return onTab(c, "read", async (t) => {
      const mode = c.p.mode ?? "interactive";
      const r = await t.drv.snapshot({ mode, root: c.p.root, maxTokens: c.p.maxTokens });
      const head = { url: await t.drv.currentUrl(), title: await titleOf(t.tabId) };
      const body = { snapshot: r.text, refs: r.refs.length, ...(r.truncated ? { truncated: true } : {}) };
      // Root and full-mode snapshots don't move the (interactive, whole-page) baseline.
      if (c.p.root || mode !== "interactive") return { ...head, ...body };
      baselines.set(c.meta.id, t.tabId, r.lines);
      return { ...head, ...body };
    });
  },

  async "page.screenshot"(c) {
    return onTab(c, "read", async (t) => {
      const target = c.p.target ?? (c.p.ref ? "ref" : c.p.fullPage ? "full" : "viewport");
      return t.drv.screenshot({ target, ref: c.p.ref, format: c.p.format, quality: c.p.quality, marks: c.p.marks });
    });
  },

  async "page.find"(c) {
    const spec = normalizeFind(c.p);
    return onTab(c, "read", async (t) => t.drv.find(spec));
  },
};
