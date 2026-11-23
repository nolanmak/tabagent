// page.text, page.markdown, extract.* (#10, D33).
import { TabAgentError, TIMEOUTS } from "@tabagent/protocol";
import { toCsv } from "../../pure/csv";
import { paginate, type NextControl } from "../../pure/paginate";
import { requireSite } from "../permissions";
import { onTab, titleOf, type Ctx, type TabCtx } from "./ctx";
import { checkClickGate } from "./gates";

type Handler = (c: Ctx) => Promise<unknown>;

async function table(t: TabCtx, ref?: string, index?: number) {
  const r = (await t.drv.call("extractTable", [index], ref ? { ref } : {})) as any;
  if (r.error) throw new TabAgentError("NOT_FOUND", r.error, "Pass ref of a table/grid, or check the page has one with page.snapshot.");
  return r as { headers: string[]; rows: Record<string, string>[]; count: number; truncated?: boolean; totalRows?: number; tableIndex: number; totalTables: number };
}

export const extractHandlers: Record<string, Handler> = {
  async "page.text"(c) {
    return onTab(c, "read", async (t) => t.drv.call("text", [c.p.maxChars], c.p.ref ? { ref: c.p.ref } : {}));
  },

  async "page.markdown"(c) {
    return onTab(c, "read", async (t) => t.drv.call("markdown", [c.p.maxChars ?? 20000]));
  },

  async "extract.table"(c) {
    return onTab(c, "read", async (t) => {
      const r = await table(t, c.p.ref, c.p.index);
      const meta = { count: r.count, tableIndex: r.tableIndex, totalTables: r.totalTables, ...(r.truncated ? { truncated: true, totalRows: r.totalRows } : {}) };
      if (c.p.format === "csv") return { csv: toCsv(r.headers, r.rows), ...meta };
      return { headers: r.headers, rows: r.rows, ...meta };
    });
  },

  async "extract.links"(c) {
    return onTab(c, "read", async (t) => t.drv.call("extractLinks", [c.p.filter, c.p.limit ?? 500], c.p.root ? { ref: c.p.root } : {}));
  },

  async "extract.schema"(c) {
    return onTab(c, "read", async (t) => t.drv.call("extractSchema", [{ schema: c.p.schema, selectors: c.p.selectors, hint: c.p.hint }]));
  },

  async "extract.paginate"(c) {
    const { extractor, next, maxPages = 5, schema, selectors } = c.p as { extractor: "table" | "links" | "schema"; next?: string; maxPages?: number; schema?: Record<string, unknown>; selectors?: unknown };
    const perPage = Math.min(c.p.timeout ?? TIMEOUTS.action * 2, 120_000);
    let headers: string[] | undefined;
    return onTab(c, "read", async (t) => {
      let page = 0;
      const callEnd = Date.now() + 120_000;
      const r = await paginate<unknown>(
        {
          url: () => t.drv.currentUrl(),
          extract: async () => {
            page++;
            if (Date.now() > callEnd) throw new TabAgentError("TIMEOUT", "extract.paginate hit its 120s cap");
            if (!(await t.drv.waitLoad(perPage))) throw new TabAgentError("TIMEOUT", `Page ${page} did not finish loading in ${perPage}ms`);
            if (extractor === "table") {
              const tb = await table(t);
              headers ??= tb.headers;
              return tb.rows;
            }
            if (extractor === "links") return ((await t.drv.call("extractLinks", [undefined, 1000])) as any).links;
            const s = (await t.drv.call("extractSchema", [{ schema, selectors }])) as any;
            return Array.isArray(s.data) ? s.data : s.data ? [s.data] : [];
          },
          findNext: async () => {
            // A ref only exists on the page it came from; later pages use CSS or detection.
            const asRef = next && /^e\d+$/.test(next) && page === 1;
            const v = (await t.drv.call("nextControl", asRef ? [] : [next && !/^e\d+$/.test(next) ? next : undefined], asRef ? { ref: next } : {})) as { ref: string; disabled: boolean; href: string | null } | null;
            return v ? ({ ref: v.ref, disabled: v.disabled, href: v.href } satisfies NextControl) : null;
          },
          click: async (nx) => {
            await checkClickGate(c, t, nx.ref);
            const before = t.drv.navEpoch();
            await t.drv.click(nx.ref, { timeout: perPage });
            await t.drv.settle(before, perPage);
            t.url = await t.drv.currentUrl();
          },
          authorize: (url, level) => requireSite(c.meta, url, level, c.tool.name, level === "act" ? "click Next to paginate" : `open ${url}`),
        },
        { maxPages },
      );
      const key = extractor === "table" ? "rows" : extractor === "links" ? "links" : "data";
      const out: Record<string, unknown> = { [key]: r.rows, count: r.count, pages: r.pages, urls: r.urls, stopped: r.stopped, ...(headers ? { headers } : {}), ...(r.error ? { error: r.error } : {}) };
      if (r.pages > 1) out.__side = { navigation: { url: r.urls[r.urls.length - 1], title: await titleOf(t.tabId), kind: "link" } };
      return out;
    });
  },
};
