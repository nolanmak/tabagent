// Decode a tool result the way an agent sees it: first line JSON, hoisted page blocks after it,
// page-derived values wrapped in PAGE_DATA blocks (D21). Returns plain data for assertions.
import { PAGE_DATA_OPEN, unwrap } from "../packages/protocol/src/index";
import type { CallResult } from "./harness";

function decode(v: unknown): unknown {
  if (typeof v === "string" && v.startsWith(PAGE_DATA_OPEN)) {
    const inner = unwrap(v);
    if (/^[[{]/.test(inner) || inner === "null" || /^-?\d/.test(inner) || inner === "true" || inner === "false") {
      try {
        return JSON.parse(inner);
      } catch {
        /* plain text that happens to start like JSON */
      }
    }
    return inner;
  }
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  return v;
}

export function payload(r: CallResult): any {
  const text = r.text;
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  let obj: any;
  try {
    obj = JSON.parse(first);
  } catch {
    obj = {};
  }
  const re = /(?:^|\n)(\w+):\n(<<<PAGE_DATA ([0-9a-zA-Z]+)\n[\s\S]*?\nPAGE_DATA \3>>>)/g;
  for (const m of text.slice(first.length).matchAll(re)) obj[m[1]] = m[2];
  return decode(obj);
}

/** True when `text` carries page data inside a PAGE_DATA wrapper (so it was wrapped). */
export function isWrapped(text: string, needle: string): boolean {
  const re = /<<<PAGE_DATA ([0-9a-zA-Z]+)\n([\s\S]*?)\nPAGE_DATA \1>>>/g;
  for (const m of text.matchAll(re)) if (m[2].includes(needle)) return true;
  return false;
}
