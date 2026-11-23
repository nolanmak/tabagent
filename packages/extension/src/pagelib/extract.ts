// pagelib extraction (#10, D33): tables, links, schema, markdown, text, next
// control. Runs in the page's isolated world; unit-tested with happy-dom.
import { deepQueryAll, isDisabled, isVisible, lc, matchText, nameOf, norm, textOf, type El, type Ret } from "./index";

export const MAX_TEXT = 20000;
export const TABLE_ROW_CAP = 1000;

// ---------------------------------------------------------------------------
// visibility without layout (works in happy-dom too)
// ---------------------------------------------------------------------------
function hiddenSelf(el: El): boolean {
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const st = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
  return !!st && (st.display === "none" || st.visibility === "hidden");
}

export function hiddenDeep(el: El): boolean {
  for (let cur: El | null = el; cur; cur = cur.parentElement) if (hiddenSelf(cur)) return true;
  return false;
}

function absUrl(u: string | null | undefined): string {
  if (!u) return "";
  try {
    return new URL(u, document.baseURI).href;
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
interface Cell {
  text: string;
  header: boolean;
}

function spanOf(c: El, attr: "colspan" | "rowspan"): number {
  const v = parseInt(c.getAttribute(attr) ?? c.getAttribute(`aria-${attr}`) ?? "1", 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 1;
}

function ownRows(t: El): { cells: El[]; inHead: boolean }[] {
  if (t.tagName === "TABLE") {
    return Array.from((t as HTMLTableElement).rows).map((r) => ({ cells: Array.from(r.cells), inHead: r.parentElement?.tagName === "THEAD" }));
  }
  const rows = Array.from(t.querySelectorAll("[role=row]")).filter((r) => r.parentElement?.closest("[role=table],[role=grid],[role=treegrid],table") === t || r.closest("[role=table],[role=grid],[role=treegrid]") === t);
  return rows.map((r) => ({
    cells: Array.from(r.querySelectorAll("[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]")).filter((c) => c.closest("[role=row]") === r),
    inHead: r.closest("[role=rowgroup]")?.getAttribute("data-head") === "true",
  }));
}

/** Expand a table into a rectangular grid, honouring colspan and rowspan. */
function grid(t: El): { rows: Cell[][]; headRows: number } {
  const src = ownRows(t);
  const out: Cell[][] = [];
  const carry: (Cell & { left: number })[] = [];
  let headRows = 0;
  src.forEach((r, ri) => {
    const row: Cell[] = [];
    let col = 0;
    const take = () => {
      while (carry[col] && carry[col].left > 0) {
        row[col] = { text: carry[col].text, header: carry[col].header };
        carry[col].left--;
        col++;
      }
    };
    for (const c of r.cells) {
      take();
      const header = c.tagName === "TH" || /^(columnheader|rowheader)$/.test(c.getAttribute("role") ?? "");
      const text = textOf(c);
      const cs = spanOf(c, "colspan");
      const rs = spanOf(c, "rowspan");
      for (let k = 0; k < cs; k++) {
        row[col] = { text: k === 0 || header ? text : "", header };
        if (rs > 1) carry[col] = { text: k === 0 || header ? text : "", header, left: rs - 1 };
        col++;
      }
    }
    take();
    for (let k = 0; k < row.length; k++) row[k] ??= { text: "", header: false };
    out.push(row);
    if (r.inHead && ri === headRows) headRows++;
  });
  return { rows: out, headRows };
}

function tablesIn(root: El | Document): El[] {
  const sel = "table,[role=table],[role=grid],[role=treegrid]";
  if (root instanceof Element && root.matches(sel)) return [root];
  return deepQueryAll(root as ParentNode, sel).filter((t) => !t.parentElement?.closest(sel));
}

export function extractTable(root: El | null, index?: number | null, cap?: number | null) {
  cap ??= TABLE_ROW_CAP;
  const tables = tablesIn(root ?? document);
  if (!tables.length) return { error: "No tables found" };
  let pickIndex = 0;
  if (index != null) {
    if (!tables[index]) return { error: `Table index ${index} out of range (${tables.length} tables)` };
    pickIndex = index;
  } else {
    let best = -1;
    tables.forEach((t, i) => {
      const size = grid(t).rows.reduce((a, r) => a + r.length, 0);
      if (size > best) {
        best = size;
        pickIndex = i;
      }
    });
  }
  const g = grid(tables[pickIndex]);
  let headerRow: Cell[] | null = null;
  let body = g.rows;
  if (g.headRows > 0) {
    headerRow = g.rows[g.headRows - 1];
    body = g.rows.slice(g.headRows);
  } else if (g.rows[0]?.length && g.rows[0].every((c) => c.header)) {
    headerRow = g.rows[0];
    body = g.rows.slice(1);
  }
  const width = Math.max(headerRow?.length ?? 0, ...body.map((r) => r.length), 0);
  const headers: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    const h = headerRow?.[i]?.text || `col${i + 1}`;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    headers.push(n > 1 ? `${h}_${n}` : h);
  }
  const nonEmpty = body.filter((r) => r.some((c) => c.text));
  const truncated = nonEmpty.length > cap;
  const rows = nonEmpty.slice(0, cap).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => (o[h] = r[i]?.text ?? ""));
    return o;
  });
  return { headers, rows, count: rows.length, ...(truncated ? { truncated: true, totalRows: nonEmpty.length } : {}), tableIndex: pickIndex, totalTables: tables.length };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
export function extractLinks(root: El | null, filter?: string | null, limit?: number | null) {
  limit ??= 500;
  const seen = new Set<string>();
  const out: { text: string; href: string }[] = [];
  let truncated = false;
  for (const a of deepQueryAll((root ?? document) as ParentNode, "a[href],area[href]")) {
    const raw = a.getAttribute("href") ?? "";
    if (!raw || /^\s*javascript:/i.test(raw)) continue;
    if (hiddenDeep(a)) continue;
    const href = absUrl(raw);
    if (seen.has(href)) continue;
    const text = (nameOf(a) || textOf(a)).slice(0, 200);
    if (filter && !matchText(text, filter) && !matchText(href, filter)) continue;
    seen.add(href);
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    out.push({ text, href });
  }
  return { links: out, count: out.length, ...(truncated ? { truncated: true } : {}) };
}

// ---------------------------------------------------------------------------
// Schema (D33): JSON-LD, microdata, then repeated items
// ---------------------------------------------------------------------------
export interface Selectors {
  item?: string;
  fields: Record<string, string>;
}

type Props = Record<string, { type?: string; format?: string }>;

const JSONLD = 'script[type="application/ld+json"]';

function schemaProps(schema?: Record<string, unknown>): Props {
  if (!schema) return {};
  const item = (schema.type === "array" ? schema.items : schema) as Record<string, unknown> | undefined;
  return ((item?.properties as Props) ?? {}) as Props;
}

function coerceValue(v: unknown, spec: { type?: string } | undefined): unknown {
  if (v == null || !spec?.type) return v ?? null;
  if (spec.type === "number" || spec.type === "integer") {
    if (typeof v === "number") return spec.type === "integer" ? Math.round(v) : v;
    const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    return spec.type === "integer" ? Math.round(parseFloat(m[0])) : parseFloat(m[0]);
  }
  if (spec.type === "boolean") return typeof v === "boolean" ? v : /^(true|yes|1|in ?stock|available)$/i.test(String(v).trim()) || /InStock$/.test(String(v));
  if (spec.type === "string" && typeof v === "object") return (v as any).name ?? (v as any)["@id"] ?? JSON.stringify(v);
  return v;
}

function flattenLd(v: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(v)) v.forEach((x) => flattenLd(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) flattenLd(o["@graph"], out);
    else {
      const { "@context": _c, ...rest } = o;
      void _c;
      out.push(rest);
    }
  }
}

function jsonLdItems(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of Array.from(document.querySelectorAll(JSONLD))) {
    try {
      flattenLd(JSON.parse(s.textContent ?? ""), out);
    } catch {
      /* invalid JSON-LD block: skip */
    }
  }
  return out;
}

function getPath(o: unknown, path: string): unknown {
  let cur: any = o;
  for (const k of path.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[0]?.[k] : cur[k];
  }
  return cur;
}

/** Find a property path in an object: own key (case-insensitive), else one level down. */
function findPath(o: Record<string, unknown>, p: string): string | null {
  const want = p.toLowerCase();
  const own = Object.keys(o).find((k) => k.toLowerCase() === want);
  if (own) return own;
  for (const [k, v] of Object.entries(o)) {
    const inner = Array.isArray(v) ? v[0] : v;
    if (inner && typeof inner === "object") {
      const sub = Object.keys(inner as object).find((x) => x.toLowerCase() === want);
      if (sub) return `${k}.${sub}`;
    }
  }
  return null;
}

function project(items: Record<string, unknown>[], props: Props): { data: Record<string, unknown>[]; fields: Record<string, string> } {
  const names = Object.keys(props);
  if (!names.length) return { data: items, fields: {} };
  const fields: Record<string, string> = {};
  for (const p of names) {
    for (const it of items) {
      const path = findPath(it, p);
      if (path) {
        fields[p] = path;
        break;
      }
    }
  }
  if (!Object.keys(fields).length) return { data: [], fields };
  // Keep the items that carry the most requested fields (a Product, not the Organization beside it).
  const cover = (it: Record<string, unknown>) => names.filter((p) => findPath(it, p)).length;
  const best = Math.max(...items.map(cover));
  const data = items
    .filter((it) => best > 0 && cover(it) === best)
    .map((it) => Object.fromEntries(names.map((p) => [p, fields[p] ? coerceValue(getPath(it, fields[p]) ?? null, props[p]) : null])));
  return { data, fields };
}

function microValue(el: El): unknown {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute("itemscope")) return microItem(el);
  if (el.hasAttribute("content")) return el.getAttribute("content");
  if (["img", "audio", "video", "source", "iframe", "embed"].includes(tag)) return absUrl(el.getAttribute("src"));
  if (["a", "area", "link"].includes(tag)) return absUrl(el.getAttribute("href"));
  if (tag === "time" && el.hasAttribute("datetime")) return el.getAttribute("datetime");
  if ((tag === "data" || tag === "meter") && el.hasAttribute("value")) return el.getAttribute("value");
  return textOf(el);
}

function microItem(scope: El): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const type = scope.getAttribute("itemtype");
  if (type) o["@type"] = type.split(/[/#]/).pop();
  for (const el of Array.from(scope.querySelectorAll("[itemprop]"))) {
    if (el.parentElement?.closest("[itemscope]") !== scope) continue;
    for (const name of (el.getAttribute("itemprop") ?? "").split(/\s+/).filter(Boolean)) {
      const v = microValue(el);
      if (name in o) o[name] = Array.isArray(o[name]) ? [...(o[name] as unknown[]), v] : [o[name], v];
      else o[name] = v;
    }
  }
  return o;
}

function microdataItems(): Record<string, unknown>[] {
  return Array.from(document.querySelectorAll("[itemscope]"))
    .filter((e) => !e.hasAttribute("itemprop"))
    .map(microItem);
}

// --- repeated items -------------------------------------------------------
function classTokens(el: El): string[] {
  return typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && !/\d{3,}/.test(c)) : [];
}

function signature(el: El): string {
  const cls = classTokens(el).sort();
  return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
}

/** Relative CSS path from `item` down to `el` (child combinators, classes, nth-of-type). */
function relPath(el: El, item: El): string {
  const parts: string[] = [];
  for (let cur: El | null = el; cur && cur !== item; cur = cur.parentElement) {
    let seg = cur.tagName.toLowerCase();
    const cls = classTokens(cur).slice(0, 2);
    if (cls.length) seg += "." + cls.join(".");
    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
  }
  return parts.join(" > ");
}

function propWords(p: string): string[] {
  const kebab = p.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return [...new Set([p.toLowerCase(), kebab, kebab.replace(/-/g, "_")])];
}

const LINK_PROP = /url|link|href/i;
const IMAGE_PROP = /image|img|photo|thumbnail|picture/i;

/** Locate a field inside one item by itemprop, data-*, class name, heading or label. */
function findField(item: El, p: string, spec: { format?: string } | undefined): El | null {
  const words = propWords(p);
  const all = Array.from(item.querySelectorAll("*"));
  const byAttr = all.find((e) => words.some((w) => [e.getAttribute("itemprop"), e.getAttribute("data-field"), e.getAttribute("data-testid"), e.getAttribute("name")].some((a) => a?.toLowerCase() === w)));
  if (byAttr) return byAttr;
  const byClass = all.find((e) => classTokens(e).some((c) => words.some((w) => c.toLowerCase() === w || c.toLowerCase().endsWith("-" + w) || c.toLowerCase().endsWith("_" + w) || c.toLowerCase().startsWith(w + "-"))));
  if (byClass) return byClass;
  if (/^(title|name|heading|headline)$/i.test(p)) {
    const h = item.querySelector("h1,h2,h3,h4,h5,h6");
    if (h) return h;
  }
  if (LINK_PROP.test(p) || spec?.format === "uri") {
    const a = item.matches("a[href]") ? null : item.querySelector("a[href]");
    if (a) return a;
  }
  if (IMAGE_PROP.test(p)) {
    const img = item.querySelector("img");
    if (img) return img;
  }
  const want = lc(p.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "));
  for (const le of Array.from(item.querySelectorAll("dt,th,label,strong,b"))) {
    if (lc(textOf(le)).replace(/:$/, "") === want && le.nextElementSibling && textOf(le.nextElementSibling)) return le.nextElementSibling;
  }
  return null;
}

function attrFor(el: El, p: string, spec?: { format?: string }): string | null {
  const tag = el.tagName.toLowerCase();
  if ((LINK_PROP.test(p) || spec?.format === "uri") && el.hasAttribute("href")) return "href";
  if (IMAGE_PROP.test(p) && tag === "img") return "src";
  if (el.hasAttribute("content")) return "content";
  return null;
}

function readSel(item: El, sel: string): unknown {
  const at = sel.lastIndexOf("@");
  const css = at > 0 ? sel.slice(0, at) : sel;
  const attr = at > 0 ? sel.slice(at + 1) : null;
  let el: El | null;
  try {
    el = css === "" || css === ":scope" ? item : css.startsWith(">") ? queryRel(item, css) : item.querySelector(css);
  } catch {
    return null;
  }
  if (!el) return null;
  if (attr) {
    const v = el.getAttribute(attr);
    return attr === "href" || attr === "src" ? absUrl(v) : v;
  }
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : textOf(el);
}

/** "> a.b > c:nth-of-type(2)": walk child steps from `item` (no reliance on :scope). */
function queryRel(item: El, path: string): El | null {
  const steps = path.replace(/^>\s*/, "").split(/\s*>\s*/);
  let level: El[] = [item];
  for (const step of steps) {
    const next: El[] = [];
    for (const p of level) for (const c of Array.from(p.children)) if (c.matches(step)) next.push(c);
    if (!next.length) return null;
    level = next;
  }
  return level[0];
}

function applySelectors(sel: Selectors, props: Props): Record<string, unknown>[] {
  const items = sel.item ? deepQueryAll(document, sel.item) : [document.documentElement];
  return items.slice(0, 500).map((it) => Object.fromEntries(Object.entries(sel.fields).map(([p, s]) => [p, coerceValue(readSel(it, s), props[p])])));
}

function detectRepeated(props: Props, hint?: string): Selectors | null {
  const names = Object.keys(props);
  if (!names.length) return null;
  let items: El[] = [];
  let itemSel: string | null = hint ?? null;
  if (hint) items = deepQueryAll(document, hint);
  else {
    const counts = new Map<string, Set<El>>();
    const cover = new Map<string, Set<string>>();
    const candidates = Array.from(document.body?.querySelectorAll("*") ?? []);
    // Group siblings with the same signature; a group of >= 2 is a candidate item set.
    const groups = new Map<string, El[]>();
    for (const el of candidates) {
      if (!el.parentElement || ["SCRIPT", "STYLE", "TR", "TD", "TH", "OPTION"].includes(el.tagName)) continue;
      const key = signature(el);
      const list = groups.get(key) ?? [];
      list.push(el);
      groups.set(key, list);
    }
    for (const [sig, els] of groups) {
      if (els.length < 2) continue;
      const covered = new Set<string>();
      for (const p of names) if (els.slice(0, 5).some((e) => findField(e, p, props[p]))) covered.add(p);
      if (!covered.size) continue;
      counts.set(sig, new Set(els));
      cover.set(sig, covered);
    }
    let best: string | null = null;
    let bestScore = 0;
    for (const [sig, set] of counts) {
      // Prefer the set covering most fields, then the one with a class name, then more items, then deeper (smaller) items.
      const score = (cover.get(sig)!.size / names.length) * 1000 + (sig.includes(".") ? 100 : 0) + Math.min(set.size, 50) - textOf([...set][0]).length / 10000;
      if (score > bestScore) {
        bestScore = score;
        best = sig;
      }
    }
    if (best) {
      items = Array.from(counts.get(best)!);
      itemSel = best;
    }
  }
  if (!items.length || !itemSel) return null;
  const fields: Record<string, string> = {};
  for (const p of names) {
    for (const it of items.slice(0, 10)) {
      const el = findField(it, p, props[p]);
      if (el) {
        const path = relPath(el, it);
        const attr = attrFor(el, p, props[p]);
        fields[p] = (path ? "> " + path : ":scope") + (attr ? "@" + attr : "");
        break;
      }
    }
  }
  return Object.keys(fields).length ? { item: itemSel, fields } : null;
}

export function extractSchema(o: { schema?: Record<string, unknown>; selectors?: Selectors; hint?: string } = {}) {
  const props = schemaProps(o.schema);
  if (o.selectors) {
    if (o.selectors.item === JSONLD) {
      const items = jsonLdItems();
      const fields = o.selectors.fields;
      const cover = (it: Record<string, unknown>) => Object.values(fields).filter((p) => getPath(it, p) !== undefined).length;
      const best = Math.max(0, ...items.map(cover));
      const data = Object.keys(fields).length ? items.filter((it) => best > 0 && cover(it) === best).map((it) => Object.fromEntries(Object.entries(fields).map(([k, p]) => [k, coerceValue(getPath(it, p) ?? null, props[k])]))) : items;
      return { data, selectors: o.selectors, source: "json-ld" };
    }
    return { data: applySelectors(o.selectors, props), selectors: o.selectors, source: "selectors" };
  }
  if (!o.hint) {
    const ld = jsonLdItems();
    if (ld.length) {
      const pr = project(ld, props);
      if (pr.data.length) return { data: pr.data, selectors: { item: JSONLD, fields: pr.fields }, source: "json-ld" };
    }
    const md = microdataItems();
    if (md.length) {
      const pr = project(md, props);
      if (pr.data.length) return { data: pr.data, selectors: { item: "[itemscope]:not([itemprop])", fields: microFields(pr.fields) }, source: "microdata" };
    }
  }
  const sel = detectRepeated(props, o.hint);
  if (!sel) return { data: [], selectors: { fields: {} }, source: "none" };
  return { data: applySelectors(sel, props), selectors: sel, source: "repeated" };
}

/** Microdata paths (offers.price) as itemprop CSS selectors, so they can be re-applied. */
function microFields(paths: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(paths)) {
    const segs = p.split(".");
    const css = segs.map((s) => `[itemprop~="${s}"]`).join(" ");
    const last = segs[segs.length - 1];
    out[k] = css + (/^(url|href|link)$/i.test(last) ? "@href" : /^(image|photo|logo)$/i.test(last) ? "@src" : "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pagination: find the next control
// ---------------------------------------------------------------------------
const NEXT_TEXT = /^(next( page)?|next ›|next »|more results|›|»|→|>)$/i;

export function nextControl(_self: unknown, selector?: string): Ret<{ el: number; disabled: boolean; href: string | null } | null> {
  let el: El | null = _self instanceof Element ? _self : null;
  if (el) {
    /* the caller passed the next control's ref */
  } else if (selector) el = deepQueryAll(document, selector)[0] ?? null;
  else {
    el = deepQueryAll(document, "a[rel~=next],button[rel~=next]").find((e) => !hiddenDeep(e)) ?? null;
    el ??=
      deepQueryAll(document, "a,button,[role=button],[role=link],input[type=button],input[type=submit]").find((e) => {
        if (hiddenDeep(e)) return false;
        const n = norm(nameOf(e) || textOf(e));
        return NEXT_TEXT.test(n) || /^next\b/i.test(e.getAttribute("aria-label") ?? "");
      }) ?? null;
  }
  if (!el) return { value: null, elements: [] };
  const isLink = el.tagName === "A";
  const rawHref = el.getAttribute("href");
  const disabled = isDisabled(el) || (isLink && !rawHref) || /\bdisabled\b/.test(typeof el.className === "string" ? el.className : "");
  return { value: { el: 0, disabled, href: isLink && rawHref && !/^\s*(#|javascript:)/i.test(rawHref) ? absUrl(rawHref) : null }, elements: [el] };
}

// ---------------------------------------------------------------------------
// Markdown and text
// ---------------------------------------------------------------------------
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head", "button", "input", "select", "textarea", "object", "embed"]);
const CHROME_TAGS = new Set(["nav", "aside", "footer"]);
const CHROME_ROLES = new Set(["navigation", "contentinfo", "complementary", "banner", "search"]);
const AD = /(^|[\s_-])(ad|ads|advert|adverts|advertisement|sponsored|sponsor|promo|promoted|adsbygoogle)([\s_-]|$)/i;

function isChrome(el: El): boolean {
  const tag = el.tagName.toLowerCase();
  if (CHROME_TAGS.has(tag)) return true;
  if (tag === "header" && !el.parentElement?.closest("article,section,main")) return true;
  if (CHROME_ROLES.has(el.getAttribute("role") ?? "")) return true;
  const cls = typeof el.className === "string" ? el.className : "";
  if (AD.test(cls) || AD.test(el.id) || el.hasAttribute("data-ad") || el.hasAttribute("data-ad-slot")) return true;
  return false;
}

export function mainRoot(): El {
  const m = document.querySelector("main,[role=main]");
  if (m && textOf(m).length > 200) return m;
  const arts = Array.from(document.querySelectorAll("article"));
  if (arts.length) return arts.sort((a, b) => textOf(b).length - textOf(a).length)[0];
  return m ?? document.body;
}

interface Ctx {
  depth: number;
  plain: boolean;
  root: El;
}

function render(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const el = node as El;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) && !(ctx.plain && tag === "button")) return ""; // button labels are visible text
  if (hiddenSelf(el)) return "";
  if (el !== ctx.root && isChrome(el)) return "";
  const kids = () => Array.from((el.shadowRoot ?? el).childNodes).map((c) => render(c, ctx)).join("");
  const block = (s: string) => `\n\n${s}\n\n`;
  const p = ctx.plain;
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return block(p ? norm(kids()) : `${"#".repeat(+tag[1])} ${norm(kids())}`);
    case "br":
      return p ? "\n" : "  \n";
    case "hr":
      return p ? "\n\n" : "\n\n---\n\n";
    case "strong":
    case "b": {
      const t = norm(kids());
      return t && !p ? `**${t}**` : t;
    }
    case "em":
    case "i": {
      const t = norm(kids());
      return t && !p ? `*${t}*` : t;
    }
    case "code":
      if (el.closest("pre")) return el.textContent ?? "";
      return p ? norm(el.textContent) : `\`${norm(el.textContent)}\``;
    case "pre":
      return block(p ? (el.textContent ?? "").replace(/\n+$/, "") : "```\n" + (el.textContent ?? "").replace(/\n+$/, "") + "\n```");
    case "blockquote":
      return block(
        norm(kids())
          .split("\n")
          .map((l) => (p ? l : "> " + l))
          .join("\n"),
      );
    case "a": {
      const t = norm(kids());
      const raw = el.getAttribute("href");
      if (!t || p || !raw || /^\s*javascript:/i.test(raw)) return t;
      return `[${t}](${absUrl(raw)})`;
    }
    case "img": {
      const alt = (el as HTMLImageElement).alt;
      return alt && !p ? `![${alt}](${absUrl(el.getAttribute("src"))})` : "";
    }
    case "ul":
    case "ol": {
      let i = 0;
      const items = Array.from(el.children)
        .filter((c) => c.tagName === "LI" && !hiddenSelf(c))
        .map((li) => {
          i++;
          const pre = tag === "ol" ? `${i}. ` : "- ";
          const body = norm(render(li, { ...ctx, depth: ctx.depth + 1 }).replace(/\n+/g, " "));
          return "  ".repeat(ctx.depth) + (p && tag === "ul" ? "" : pre) + body;
        });
      return block(items.join("\n"));
    }
    case "dt":
      return p ? `\n${norm(kids())}\n` : `\n**${norm(kids())}**\n`;
    case "dd":
      return p ? `${norm(kids())}\n` : `: ${norm(kids())}\n`;
    case "table": {
      const t = extractTable(el);
      if ("error" in t || !t.headers?.length) return "";
      if (p) return block([t.headers.join("\t"), ...t.rows.map((r) => t.headers.map((h) => r[h]).join("\t"))].join("\n"));
      const esc = (s: string) => s.replace(/\|/g, "\\|");
      const head = `| ${t.headers.map(esc).join(" | ")} |\n| ${t.headers.map(() => "---").join(" | ")} |`;
      const rows = t.rows.map((r) => `| ${t.headers.map((h) => esc(r[h] ?? "")).join(" | ")} |`).join("\n");
      return block(`${head}${rows ? "\n" + rows : ""}`);
    }
    case "p":
    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "form":
    case "fieldset":
    case "figure":
    case "figcaption":
    case "dl":
    case "details":
    case "summary":
    case "li":
      return tag === "li" ? kids() : block(kids());
  }
  return kids();
}

function tidy(s: string): string {
  return s
    .split("\n")
    .map((l) => (/^\s*$/.test(l) ? "" : l.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Arguments cross CDP as JSON, so an omitted argument arrives as null: default with ??.
export function markdown(_self: unknown, maxChars?: number | null) {
  maxChars ??= MAX_TEXT;
  const root = mainRoot();
  const out = tidy(render(root, { depth: 0, plain: false, root }));
  const truncated = out.length > maxChars;
  return { title: document.title, markdown: truncated ? out.slice(0, maxChars) : out, ...(truncated ? { truncated: true, totalChars: out.length } : {}) };
}

/** page.text: visible text of the main content (or of `el`), no markup. */
export function text(el: El | null, maxChars?: number | null) {
  maxChars ??= MAX_TEXT;
  const root = el ?? mainRoot();
  const out = tidy(render(root, { depth: 0, plain: true, root }));
  const truncated = out.length > maxChars;
  return { text: truncated ? out.slice(0, maxChars) : out, ...(truncated ? { truncated: true, totalChars: out.length } : {}) };
}
