// D21 untrusted-content wrapping, applied once at the bridge output edge (MCP, REST, CLI).
// Pure: plain data in, plain data out. The registry's `pageContent` paths drive it.
import type { ToolError } from "./errors";
import type { DialogInfo, DownloadInfo, Navigation } from "./messages";
import type { ToolDef } from "./registry";

export const PAGE_DATA_OPEN = "<<<PAGE_DATA";
export const PAGE_DATA_CLOSE = "PAGE_DATA";

export function newNonce(): string {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function wrapText(text: string, nonce: string): string {
  return `${PAGE_DATA_OPEN} ${nonce}\n${text}\n${PAGE_DATA_CLOSE} ${nonce}>>>`;
}

/** Strip every wrapper block (for tests and clients that want raw text). */
export function unwrap(text: string): string {
  return text.replace(/<<<PAGE_DATA ([0-9a-zA-Z]+)\n([\s\S]*?)\nPAGE_DATA \1>>>/g, "$2");
}

/** Recursively unwrap every string inside a JSON value. */
export function unwrapDeep<T>(v: T): T {
  if (typeof v === "string") return unwrap(v) as T;
  if (Array.isArray(v)) return v.map(unwrapDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapDeep(x)])) as T;
  return v;
}

type Json = unknown;
type Visit = (value: Json) => Json;

function parsePath(path: string): string[] {
  return path.split(".").flatMap((seg) => (seg.endsWith("[]") ? [seg.slice(0, -2), "[]"] : [seg]));
}

/** Apply fn at each value matching the path; returns a new tree (input untouched). */
function mapPath(node: Json, segs: string[], fn: Visit): Json {
  if (!segs.length) return node === undefined || node === null ? node : fn(node);
  const [head, ...rest] = segs;
  if (head === "[]") return Array.isArray(node) ? node.map((x) => mapPath(x, rest, fn)) : node;
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const obj = node as Record<string, Json>;
  if (!(head in obj)) return node;
  return { ...obj, [head]: mapPath(obj[head], rest, fn) };
}

function asText(v: Json): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Response leaving the bridge, before wrapping. */
export interface OutputResponse {
  ok: boolean;
  result?: unknown;
  error?: ToolError;
  snapshotDiff?: string;
  navigation?: Navigation;
  dialogs?: DialogInfo[];
  downloads?: DownloadInfo[];
  /**
   * AD8 piggyback: messages the user sent from the side panel, attached by the bridge to a successful
   * result after wrapping. Each one starts with the `[TabAgent: message from the user via the side panel]`
   * header; the stdio proxy renders each as its own text block before the tool output.
   */
  userMessages?: string[];
}

/** Every piece of page text that will be wrapped, in order. Used for the nonce collision check. */
function pageTexts(resp: OutputResponse, tool: Pick<ToolDef, "pageContent"> | undefined): string[] {
  const out: string[] = [];
  const grab: Visit = (v) => {
    out.push(asText(v));
    return v;
  };
  if (resp.result !== undefined && tool) for (const p of tool.pageContent) mapPath(resp.result, parsePath(p), grab);
  if (resp.snapshotDiff) out.push(resp.snapshotDiff);
  if (resp.navigation) out.push(resp.navigation.url, resp.navigation.title);
  for (const d of resp.dialogs ?? []) out.push(d.message, d.defaultPrompt ?? "");
  for (const d of resp.downloads ?? []) out.push(d.filename);
  if (resp.error?.untrusted) out.push(resp.error.message);
  return out;
}

/** Pick a nonce that does not occur in any of the texts (a page can't forge our closing marker). */
export function chooseNonce(texts: string[], nonce?: string | (() => string)): string {
  const gen = typeof nonce === "function" ? nonce : newNonce;
  let n = typeof nonce === "string" ? nonce : gen();
  for (let i = 0; texts.some((t) => t.includes(n)); i++) {
    if (i > 50) throw new Error("could not choose a wrapper nonce");
    n = gen();
    if (typeof nonce === "function" && i > 5) n = newNonce();
  }
  return n;
}

/** Wrap the page-derived fields of one tool result (pure). */
export function wrap(result: unknown, toolDef: Pick<ToolDef, "pageContent">, nonce?: string | (() => string)): unknown {
  return wrapResponse({ ok: true, result }, toolDef, nonce).response.result;
}

/**
 * Wrap a whole response: registry pageContent fields, snapshotDiff, navigation url/title, dialog messages,
 * download filenames and untrusted error messages. Hints and TabAgent's own notes stay outside.
 */
export function wrapResponse(
  resp: OutputResponse,
  tool: Pick<ToolDef, "pageContent"> | undefined,
  nonce?: string | (() => string),
): { nonce: string; response: OutputResponse } {
  const n = chooseNonce(pageTexts(resp, tool), nonce);
  const w = (v: Json) => wrapText(asText(v), n);
  const out: OutputResponse = { ...resp };
  if (resp.result !== undefined && tool) {
    let r: Json = resp.result;
    for (const p of tool.pageContent) r = mapPath(r, parsePath(p), w);
    out.result = r;
  }
  if (resp.snapshotDiff !== undefined) out.snapshotDiff = w(resp.snapshotDiff) as string;
  if (resp.navigation) out.navigation = { ...resp.navigation, url: w(resp.navigation.url) as string, title: w(resp.navigation.title) as string };
  if (resp.dialogs)
    out.dialogs = resp.dialogs.map((d) => ({ ...d, message: w(d.message) as string, ...(d.defaultPrompt !== undefined ? { defaultPrompt: w(d.defaultPrompt) as string } : {}) }));
  if (resp.downloads) out.downloads = resp.downloads.map((d) => ({ ...d, filename: w(d.filename) as string }));
  if (resp.error?.untrusted) out.error = { ...resp.error, message: w(resp.error.message) as string };
  return { nonce: n, response: out };
}
