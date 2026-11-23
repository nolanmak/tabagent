// extract.paginate loop (D33). Pure: page operations are injected, and every
// hop is authorized like any click and navigation.
import { TabAgentError, type ErrorCode } from "@tabagent/protocol";

export interface NextControl {
  ref: string;
  disabled?: boolean;
  /** Target URL when the control is a link (checked before clicking). */
  href?: string | null;
}

export interface PageOps<Row = unknown> {
  url(): Promise<string>;
  extract(): Promise<Row[]>;
  findNext(): Promise<NextControl | null>;
  /** Click the next control and wait for the page to settle. */
  click(next: NextControl): Promise<void>;
  /** Throws PERMISSION_DENIED (or prompts) like the router's authorize. */
  authorize(url: string, level: "read" | "act"): Promise<void>;
}

export interface PaginateResult<Row = unknown> {
  rows: Row[];
  count: number;
  pages: number;
  urls: string[];
  stopped: string;
  error?: { code: ErrorCode; message: string };
}

export async function paginate<Row>(ops: PageOps<Row>, o: { maxPages?: number }): Promise<PaginateResult<Row>> {
  const maxPages = o.maxPages ?? 5;
  const rows: Row[] = [];
  const seen = new Set<string>();
  const urls: string[] = [];
  let stopped = "maxPages reached";
  let error: PaginateResult["error"];
  const fail = (e: unknown) => {
    error = e instanceof TabAgentError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
    stopped = "error";
  };
  try {
    let url = await ops.url();
    for (let page = 1; ; page++) {
      let items: Row[];
      try {
        items = await ops.extract();
      } catch (e) {
        fail(e);
        break;
      }
      urls.push(url);
      let fresh = 0;
      for (const it of items) {
        const k = JSON.stringify(it);
        if (!seen.has(k)) {
          seen.add(k);
          rows.push(it);
          fresh++;
        }
      }
      if (page > 1 && fresh === 0) {
        stopped = "page had only duplicate rows";
        break;
      }
      if (page >= maxPages) break;
      const next = await ops.findNext();
      if (!next) {
        stopped = "no next control";
        break;
      }
      if (next.disabled) {
        stopped = "next control is disabled";
        break;
      }
      try {
        if (next.href) await ops.authorize(next.href, "read");
        await ops.authorize(url, "act");
        await ops.click(next);
        const after = await ops.url();
        if (after === url) {
          stopped = "URL did not change";
          break;
        }
        url = after;
        await ops.authorize(url, "read");
      } catch (e) {
        fail(e);
        break;
      }
    }
  } catch (e) {
    fail(e);
  }
  return { rows, count: rows.length, pages: urls.length, urls, stopped, ...(error ? { error } : {}) };
}
