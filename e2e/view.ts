// Result views for driver e2e specs. They read a tool result the same way
// whether the bridge prints one JSON document (D21 PAGE_DATA wrapping) or the
// spike's "meta JSON line + wrapped page text" layout.
import { unwrap, unwrapDeep } from "../packages/protocol/src/index";
import type { CallResult } from "./harness";

function strip(s: string) {
  return unwrap(s).replace(/<\/?untrusted-page-content>/g, "");
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export interface View {
  /** Parsed result object (unwrapped), with `__side` fields merged in. */
  json: any;
  /** Snapshot text if any, else the whole unwrapped text. */
  snap: string;
  /** Everything: unwrapped raw text plus every string value in the JSON. */
  all: string;
}

export function view(r: CallResult): View {
  const raw = strip(r.text);
  let json: any = null;
  try {
    json = unwrapDeep(JSON.parse(raw));
  } catch {
    json = r.json ? unwrapDeep(r.json) : null;
  }
  if (json && typeof json === "object") {
    const res = json.result && typeof json.result === "object" && !Array.isArray(json.result) ? json.result : null;
    json = { ...(res ?? {}), ...json, ...(json.__side ?? {}), ...(res?.__side ?? {}) };
  }
  let snap = typeof json?.snapshot === "string" ? json.snapshot : "";
  if (!snap) {
    // spike layout: page text follows the JSON line
    const lines = raw.split("\n");
    snap = (r.json ? lines.slice(1) : lines).join("\n");
  }
  const all = [raw, ...strings(json)].join("\n");
  return { json: json ?? {}, snap, all };
}

/** Ref on the first line matching `re` in a snapshot-format text. */
export function refIn(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l));
  const m = line?.match(/\[ref=(e\d+)\]/) ?? line?.match(/root=(e\d+)/);
  if (!m) throw new Error(`No ref matching ${re} in:\n${text}`);
  return m[1];
}

export const tokens = (s: string) => Math.ceil(s.length / 4);
