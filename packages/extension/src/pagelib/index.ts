// pagelib: DOM-side helpers. Runs in an *isolated world* (CDP isolated world in
// debugger mode, the content-script world in lite mode) and is installed as
// globalThis.__ta. Functions that return elements return { value, elements } and
// reference elements inside `value` as { el: <index> }; the background maps those
// indexes to refs.

import { clickGateInfo, clickSensitivity, comboOptions, describeFields, fieldInfo, isFormControl, keyGateInfo, keySensitivity, requestSubmit, resolveFileInput, submitInfo } from "./forms";
import { extractLinks, extractSchema, extractTable, markdown, nextControl, storage, text } from "./extract";

export type El = Element;
export interface Ret<T = unknown> {
  value: T;
  elements: El[];
}


// ---------------------------------------------------------------------------
// Element registry (used by lite mode for refs)
// ---------------------------------------------------------------------------
const reg = new Map<string, WeakRef<El>>();
const rev = new WeakMap<El, string>();
let regN = 0;
function liteRef(el: El): string {
  let r = rev.get(el);
  if (!r) {
    r = "l" + ++regN;
    rev.set(el, r);
    reg.set(r, new WeakRef(el));
  }
  return r;
}
function byLiteRef(r: string): El | null {
  const el = reg.get(r)?.deref();
  return el && el.isConnected ? el : null;
}

// ---------------------------------------------------------------------------
// Tree walking (pierces open shadow roots)
// ---------------------------------------------------------------------------
export function* walk(root: Node): Generator<El> {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const kids: Node[] = [];
    if (n instanceof Element) {
      if (n !== root) yield n;
      if (n.shadowRoot) kids.push(...Array.from(n.shadowRoot.children));
    }
    // nodeType, not instanceof: Document subclasses differ across realms (and in happy-dom).
    if (n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11) {
      kids.push(...Array.from((n as ParentNode).children));
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

export function deepQueryAll(root: ParentNode | null, selector: string): El[] {
  const r = (root ?? document) as Node;
  const out: El[] = [];
  for (const el of walk(r)) {
    try {
      if (el.matches(selector)) out.push(el);
    } catch {
      throw new Error(`Invalid selector: ${selector}`);
    }
  }
  return out;
}

export function parentOf(el: El): El | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function closestDeep(el: El, selector: string): El | null {
  let cur: El | null = el;
  while (cur) {
    if (cur.matches(selector)) return cur;
    cur = parentOf(cur);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Roles + accessible names (simplified ARIA)
// ---------------------------------------------------------------------------
export const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const lc = (s: string | null | undefined) => norm(s).toLowerCase();

function implicitRole(el: El): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : "generic";
    case "button":
      return "button";
    case "summary":
      return "button";
    case "select":
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "img":
      return (el as HTMLImageElement).alt === "" && el.hasAttribute("alt") ? "presentation" : "img";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "form":
      return "form";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "td":
      return "cell";
    case "th":
      return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "dialog":
      return "dialog";
    case "p":
      return "paragraph";
    case "article":
      return "article";
    case "fieldset":
      return "group";
    case "progress":
      return "progressbar";
    case "iframe":
      return "iframe";
    case "header":
      return closestDeep(el, "article,aside,main,nav,section") && el.parentElement?.closest("article,aside,main,nav,section")
        ? "generic"
        : "banner";
    case "footer":
      return el.parentElement?.closest("article,aside,main,nav,section") ? "generic" : "contentinfo";
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
    case "input": {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "checkbox") return el.getAttribute("role") === "switch" ? "switch" : "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "hidden") return "none";
      if (t === "file") return "button";
      return el.hasAttribute("list") ? "combobox" : "textbox";
    }
  }
  if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return "textbox";
  return "generic";
}

export function roleOf(el: El): string {
  const r = el.getAttribute("role");
  if (r) return r.split(/\s+/)[0].toLowerCase();
  return implicitRole(el);
}

export function textOf(el: El): string {
  const h = el as HTMLElement;
  return norm(typeof h.innerText === "string" ? h.innerText : el.textContent);
}

export function nameOf(el: El): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const t = by
      .split(/\s+/)
      .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
      .filter(Boolean)
      .map((e) => textOf(e!))
      .join(" ");
    if (norm(t)) return norm(t);
  }
  const al = el.getAttribute("aria-label");
  if (norm(al)) return norm(al);
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const inp = el as HTMLInputElement;
    if (["submit", "button", "reset"].includes(inp.type)) return norm(inp.value) || (inp.type === "submit" ? "Submit" : "");
    if (inp.type === "image") return norm(inp.alt) || "Submit";
    const labels = inp.labels ? Array.from(inp.labels) : [];
    const lt = labels.map((l) => labelText(l, el)).join(" ");
    if (norm(lt)) return norm(lt);
    if (norm(inp.placeholder)) return norm(inp.placeholder);
    if (norm(el.getAttribute("title"))) return norm(el.getAttribute("title"));
    return "";
  }
  if (tag === "img") return norm((el as HTMLImageElement).alt) || norm(el.getAttribute("title"));
  if (tag === "iframe") return norm(el.getAttribute("title"));
  if (tag === "fieldset") {
    const lg = el.querySelector("legend");
    if (lg) return textOf(lg);
  }
  if (tag === "table") {
    const cap = el.querySelector("caption");
    if (cap) return textOf(cap);
  }
  const role = roleOf(el);
  if (
    [
      "button",
      "link",
      "heading",
      "option",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "treeitem",
      "cell",
      "columnheader",
      "rowheader",
      "checkbox",
      "radio",
      "switch",
      "listitem",
      "paragraph",
      "row",
      "tooltip",
      "status",
      "alert",
      "summary",
    ].includes(role)
  ) {
    const t = textOf(el);
    if (t) return t.length > 200 ? t.slice(0, 200) + "…" : t;
  }
  return norm(el.getAttribute("title"));
}

function labelText(label: HTMLLabelElement, control: El): string {
  // Label text minus the control's own text (for wrapping labels).
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
  void control;
  return norm(clone.textContent);
}

export function isVisible(el: El): boolean {
  const h = el as HTMLElement;
  if (!el.isConnected) return false;
  if (typeof h.checkVisibility === "function") {
    if (!h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true } as never)) return false;
  } else {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function isDisabled(el: El): boolean {
  if ((el as HTMLInputElement).disabled) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  const fs = el.closest("fieldset[disabled]");
  if (fs && !fs.querySelector(":scope > legend")?.contains(el)) return true;
  return false;
}

export function isEditable(el: El): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"].includes(t) && !(el as HTMLInputElement).readOnly;
  }
  return (el as HTMLElement).isContentEditable;
}

export function describeEl(el: El): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const name = nameOf(el);
  return `<${tag}${id}${cls}>${name ? ` "${name.slice(0, 40)}"` : ""}`;
}

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------
interface FindQuery {
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  css?: string;
  xpath?: string;
  limit?: number;
}

/** "/re/flags" is a regex only if it has flags or regex metacharacters; "/p/" stays a substring. */
export function asRegex(s: string): RegExp | null {
  const m = s.match(/^\/(.+)\/([dgimsuy]*)$/);
  if (!m) return null;
  if (!m[2] && !/[\\^$.*+?()[\]{}|]/.test(m[1])) return null;
  try {
    return new RegExp(m[1], m[2].replace("g", "") || "i");
  } catch {
    return null;
  }
}

export function matchText(hay: string, needle: string): boolean {
  const re = asRegex(needle);
  if (re) return re.test(hay);
  return lc(hay).includes(lc(needle));
}

function find(_self: unknown, q: FindQuery): Ret {
  let cands: El[];
  if (q.css) cands = deepQueryAll(document, q.css);
  else if (q.xpath) {
    const snap = document.evaluate(q.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    cands = [];
    for (let i = 0; i < snap.snapshotLength; i++) {
      const n = snap.snapshotItem(i);
      if (n instanceof Element) cands.push(n);
    }
  } else cands = Array.from(walk(document));

  if (q.role) cands = cands.filter((e) => roleOf(e) === q.role!.toLowerCase());
  if (q.name) cands = cands.filter((e) => matchText(nameOf(e), q.name!));
  if (q.label) cands = cands.filter((e) => isFormControl(e) && matchText(nameOf(e), q.label!));
  if (q.text) {
    const hits = cands.filter((e) => !["script", "style", "noscript", "head", "html", "body"].includes(e.tagName.toLowerCase()) && matchText(textOf(e) || nameOf(e), q.text!));
    const set = new Set(hits);
    // keep innermost matches
    let inner = hits.filter((e) => !Array.from(e.children).some((c) => set.has(c)) && !(e.shadowRoot && Array.from(e.shadowRoot.children).some((c) => set.has(c))));
    // promote to interactive ancestor
    inner = inner.map((e) => closestDeep(e, "a[href],button,[role=button],[role=link],label,summary,[role=tab],[role=menuitem],[role=option]") ?? e);
    cands = Array.from(new Set(inner));
  }
  const vis = cands.filter(isVisible);
  const ordered = [...vis, ...cands.filter((c) => !vis.includes(c))];
  const limit = q.limit ?? 20;
  const els = ordered.slice(0, limit);
  return {
    value: {
      total: cands.length,
      matches: els.map((e, i) => ({ el: i, role: roleOf(e), name: nameOf(e).slice(0, 120), tag: e.tagName.toLowerCase(), visible: isVisible(e) })),
    },
    elements: els,
  };
}

// ---------------------------------------------------------------------------
// Actionability
// ---------------------------------------------------------------------------
/** One frame, or 50ms if frames are paused (hidden/background tabs don't run rAF). */
function raf(): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, 50);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });
}

async function prepareAction(el: El, opts: { scroll?: boolean; needEditable?: boolean } = {}) {
  if (!el.isConnected) return { ok: false, reason: "detached" };
  if (opts.scroll !== false) {
    const r0 = el.getBoundingClientRect();
    const inView = r0.top >= 0 && r0.left >= 0 && r0.bottom <= innerHeight && r0.right <= innerWidth;
    if (!inView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  }
  if (!isVisible(el)) return { ok: false, reason: "not visible" };
  if (isDisabled(el)) return { ok: false, reason: "disabled" };
  if (opts.needEditable && !isEditable(el)) return { ok: false, reason: "not editable" };
  const a = el.getBoundingClientRect();
  await raf();
  await raf();
  const b = el.getBoundingClientRect();
  if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.width - b.width) > 1) return { ok: false, reason: "not stable (animating)" };
  // pick a point inside the element; use the first client rect for wrapped inline links
  const rects = el.getClientRects();
  const r = rects.length ? rects[0] : b;
  const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1));
  const y = r.top + Math.min(r.height / 2, Math.max(1, r.height - 1));
  const hit = hitTest(el, x, y);
  if (!hit.ok) return { ok: false, reason: `covered by ${hit.by}`, x, y };
  return { ok: true, x, y, w: r.width, h: r.height };
}

function hitTest(el: El, x: number, y: number): { ok: boolean; by?: string } {
  let hit: El | null = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return { ok: false, by: "nothing (off-screen)" };
  if (hit === el || el.contains(hit) || (el.shadowRoot && el.shadowRoot.contains(hit))) return { ok: true };
  // hit inside a shadow tree hosted by el
  let p: El | null = hit;
  while (p) {
    if (p === el) return { ok: true };
    p = parentOf(p);
  }
  // label for control
  if (hit instanceof HTMLLabelElement && hit.control === el) return { ok: true };
  const lab = hit.closest("label") as HTMLLabelElement | null;
  if (lab && lab.control === el) return { ok: true };
  // el is a label and hit is its control
  if (el instanceof HTMLLabelElement && el.control === hit) return { ok: true };
  return { ok: false, by: describeEl(hit) };
}

/** Offset of an iframe's viewport within its parent frame's viewport. */
function frameOffset(iframe: El) {
  const r = iframe.getBoundingClientRect();
  const s = getComputedStyle(iframe);
  return {
    x: r.left + iframe.clientLeft + parseFloat(s.paddingLeft || "0"),
    y: r.top + iframe.clientTop + parseFloat(s.paddingTop || "0"),
  };
}

function rectOf(el: El) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function info(el: El) {
  const tag = el.tagName.toLowerCase();
  return {
    tag,
    role: roleOf(el),
    name: nameOf(el).slice(0, 120),
    type: (el as HTMLInputElement).type ?? null,
    editable: isEditable(el),
    checked: getChecked(el),
    isSelect: tag === "select",
    isFile: tag === "input" && (el as HTMLInputElement).type === "file",
    isForm: tag === "form",
    inputType: tag === "input" ? (el as HTMLInputElement).type : tag,
    value: "value" in el ? String((el as HTMLInputElement).value ?? "") : null,
    visible: isVisible(el),
  };
}

function scrollIntoView(el: El) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  return rectOf(el);
}

function scrollBy(el: El | null, dx: number, dy: number) {
  const target: Element | Window = el ?? window;
  target.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
  return { scrollX, scrollY };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
export function nativeSetter(el: El) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value")!.set!;
}

export function fire(el: El, type: string) {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
}

function setValue(el: El, value: string) {
  const h = el as HTMLElement;
  h.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    nativeSetter(el).call(el, value);
    fire(el, "input");
    fire(el, "change");
    return { value: el.value };
  }
  if (h.isContentEditable) {
    h.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    return { value: h.textContent };
  }
  throw new Error(`Element ${describeEl(el)} is not fillable`);
}

/** Focus and select existing content so trusted insertText replaces it. */
function focusSelect(el: El) {
  const h = el as HTMLElement;
  h.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.select();
    } catch {
      /* some types don't support selection */
    }
    const t = (el as HTMLInputElement).type;
    const nativeInsert = !["date", "time", "datetime-local", "month", "week", "color", "range", "number", "email"].includes(t) || el instanceof HTMLTextAreaElement;
    return { mode: nativeInsert ? "insert" : "set", empty: el.value === "" };
  }
  if (h.isContentEditable) {
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(h);
    sel.removeAllRanges();
    sel.addRange(range);
    return { mode: "insert", empty: (h.textContent ?? "") === "" };
  }
  return { mode: "none", empty: true };
}

function focus(el: El, opts: { end?: boolean } = {}) {
  (el as HTMLElement).focus();
  if (opts.end && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    try {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    } catch {
      /* unsupported type */
    }
  }
  return true;
}

export function valueOf(el: El) {
  if ("value" in el) return String((el as HTMLInputElement).value);
  return (el as HTMLElement).textContent ?? "";
}

function selectOptions(el: El, values: string[]) {
  if (!(el instanceof HTMLSelectElement)) return { notSelect: true };
  const opts = Array.from(el.options);
  const chosen: HTMLOptionElement[] = [];
  for (const v of values) {
    const o = opts.find((o) => o.value === v) ?? opts.find((o) => lc(o.label) === lc(v) || lc(o.text) === lc(v)) ?? opts.find((o) => lc(o.text).includes(lc(v)));
    if (!o) return { error: `No option "${v}". Options: ${opts.map((o) => o.text.trim()).slice(0, 30).join(" | ")}` };
    chosen.push(o);
  }
  el.focus();
  if (el.multiple) for (const o of opts) o.selected = chosen.includes(o);
  else if (chosen[0]) {
    nativeSetter(el).call(el, chosen[0].value);
  }
  fire(el, "input");
  fire(el, "change");
  return { selected: chosen.map((o) => o.text.trim()) };
}

export function getChecked(el: El): boolean | null {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  const a = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected");
  if (a === "true") return true;
  if (a === "false") return false;
  return null;
}

function labelFor(el: El): Ret<{ el: number } | null> {
  const labels = (el as HTMLInputElement).labels;
  const vis = labels ? Array.from(labels).find(isVisible) : undefined;
  if (vis) return { value: { el: 0 }, elements: [vis] };
  // custom checkbox: visible sibling/ancestor
  const p = el.parentElement;
  if (p && isVisible(p) && p.querySelectorAll("input").length === 1) return { value: { el: 0 }, elements: [p] };
  return { value: null, elements: [] };
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------
export function deepActive(): El | null {
  let a: El | null = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// ---------------------------------------------------------------------------
// Lite-mode DOM snapshot (debugger mode uses the CDP AX tree instead)
// ---------------------------------------------------------------------------
const LANDMARKS = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "region", "form", "search", "dialog", "alertdialog", "heading", "table", "row", "cell", "columnheader", "rowheader", "list", "listitem", "img", "alert", "status", "tablist", "tabpanel", "menu", "menubar", "toolbar", "tree", "grid", "article", "group", "paragraph", "iframe"]);

function snapshotDom(root: El | null, mode: "interactive" | "full" = "interactive") {
  const lines: string[] = [];
  const visit = (el: El, depth: number) => {
    if (!isVisible(el) && !el.shadowRoot && roleOf(el) !== "option") {
      // still descend: children may be visible (e.g. display:contents) — cheap check
      if (getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden") return;
    }
    const role = roleOf(el);
    const name = nameOf(el);
    const keep = INTERACTIVE.has(role) || (LANDMARKS.has(role) && (mode === "full" || role !== "paragraph" || name.length < 120)) || ((role === "group" || role === "region") && !!name);
    let d = depth;
    if (keep && role !== "generic" && role !== "none" && role !== "presentation") {
      let line = `${"  ".repeat(depth)}- ${role}`;
      const shown = mode === "full" ? name : name.length > 100 ? name.slice(0, 100) + "…" : name;
      if (shown) line += ` "${shown.replace(/"/g, '\\"')}"`;
      if (INTERACTIVE.has(role)) line += ` [ref=${liteRef(el)}]`;
      const ch = getChecked(el);
      if (ch !== null) line += ` checked=${ch}`;
      if (isEditable(el) || el instanceof HTMLSelectElement) line += ` value="${valueOf(el).slice(0, 80)}"`;
      if (isDisabled(el)) line += " disabled";
      if (role === "heading") line += ` level=${el.tagName.match(/H(\d)/)?.[1] ?? el.getAttribute("aria-level") ?? "2"}`;
      lines.push(line);
      d = depth + 1;
      if (["button", "link", "option", "heading", "cell", "columnheader", "paragraph"].includes(role) && name) return;
    } else if (mode === "full") {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => norm(n.textContent))
        .join(" ")
        .trim();
      if (own) lines.push(`${"  ".repeat(depth)}- text "${own.slice(0, 300)}"`);
    }
    const kids = el.shadowRoot ? [...Array.from(el.shadowRoot.children), ...Array.from(el.children)] : Array.from(el.children);
    for (const c of kids) visit(c, d);
  };
  visit(root ?? document.body, 0);
  return { snapshot: lines.join("\n"), url: location.href, title: document.title };
}

// ---------------------------------------------------------------------------
// Synthetic input (lite mode only)
// ---------------------------------------------------------------------------
function syntheticClick(el: El, opts: { button?: number; clickCount?: number } = {}) {
  const r = el.getBoundingClientRect();
  const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: opts.button ?? 0, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new PointerEvent("pointerup", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 }));
  if ((opts.clickCount ?? 1) >= 2) el.dispatchEvent(new MouseEvent("dblclick", { ...init, detail: 2 }));
  return true;
}

function syntheticHover(el: El) {
  const r = el.getBoundingClientRect();
  const init: MouseEventInit = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerover", init));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new MouseEvent("mousemove", init));
  return true;
}

function syntheticKey(el: El | null, key: string) {
  const target = el ?? deepActive() ?? document.body;
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true, composed: true };
  const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (down && key === "Enter") {
    const f = (target as HTMLInputElement).form;
    if (f && target instanceof HTMLInputElement) f.requestSubmit();
    else if (target instanceof HTMLElement && (target.tagName === "BUTTON" || target.tagName === "A")) target.click();
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}

function syntheticType(el: El | null, s: string) {
  const target = (el ?? deepActive()) as HTMLInputElement | null;
  if (!target) throw new Error("No focused element to type into");
  target.focus();
  for (const ch of s) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, composed: true }));
    if ("value" in target) {
      nativeSetter(target).call(target, target.value + ch);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
    } else if ((target as HTMLElement).isContentEditable) {
      document.execCommand("insertText", false, ch);
    }
    target.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, composed: true }));
  }
  fire(target, "change");
  return true;
}

// ---------------------------------------------------------------------------
// Overlay (visibility while an agent drives)
// ---------------------------------------------------------------------------
const OVERLAY_ID = "__tabagent_overlay__";
const shadowFor = new WeakMap<HTMLElement, ShadowRoot>();
function overlayShadow(): ShadowRoot {
  let host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (host && shadowFor.has(host)) return shadowFor.get(host)!;
  host?.remove();
  host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("role", "presentation");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const sr = host.attachShadow({ mode: "closed" });
  shadowFor.set(host, sr);
  (document.body ?? document.documentElement).appendChild(host);
  return sr;
}

let overlayTimer: number | undefined;
function showActivity(el: El | null, label: string) {
  const sr = overlayShadow();
  sr.innerHTML = `<style>
    .b{position:fixed;inset:0;border:3px solid #7c3aed;box-sizing:border-box;}
    .t{position:fixed;top:6px;right:8px;background:#7c3aed;color:#fff;font:600 12px system-ui;padding:3px 8px;border-radius:10px;}
    .h{position:fixed;border:2px solid #f59e0b;background:rgba(245,158,11,.15);border-radius:3px;}
  </style><div class="b"></div><div class="t"></div>`;
  (sr.querySelector(".t") as HTMLElement).textContent = `🤖 ${label}`;
  if (el) {
    const r = el.getBoundingClientRect();
    const h = document.createElement("div");
    h.className = "h";
    h.style.cssText = `left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px`;
    sr.appendChild(h);
  }
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => clearOverlay(), 1500) as unknown as number;
  return true;
}

function drawMarks(_self: unknown, marks: { label: string; x: number; y: number; w: number; h: number }[]) {
  const sr = overlayShadow();
  clearTimeout(overlayTimer);
  sr.innerHTML = `<style>.m{position:fixed;border:1.5px solid #e11d48;box-sizing:border-box}.l{position:absolute;top:-1px;left:-1px;background:#e11d48;color:#fff;font:700 10px/12px monospace;padding:0 2px}</style>`;
  for (const m of marks) {
    const d = document.createElement("div");
    d.className = "m";
    d.style.cssText = `left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px`;
    const l = document.createElement("span");
    l.className = "l";
    l.textContent = m.label;
    d.appendChild(l);
    sr.appendChild(d);
  }
  return true;
}

function clearOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  return true;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function pageState() {
  return { url: location.href, title: document.title, readyState: document.readyState };
}

function waitSelector(_self: unknown, sel: string) {
  return deepQueryAll(document, sel).some(isVisible);
}
function waitText(_self: unknown, t: string) {
  return matchText(document.body?.innerText ?? "", t);
}

function frameOwnerIndex(iframe: El) {
  return frameOffset(iframe);
}

function isRet(r: unknown): r is Ret {
  return !!r && typeof r === "object" && Array.isArray((r as Ret).elements) && "value" in (r as object);
}

/** Generic entry: always returns { value, elements }. */
async function invoke(self: El | null, name: string, args: unknown[]): Promise<Ret> {
  const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
  if (typeof fn !== "function") throw new Error(`pagelib: unknown function ${name}`);
  const r = await fn(self, ...args);
  return isRet(r) ? r : { value: r, elements: [] };
}

export function mapEls(v: unknown, refs: (string | null)[]): unknown {
  if (Array.isArray(v)) return v.map((x) => mapEls(x, refs));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "el" && typeof x === "number") o.ref = refs[x] ?? null;
      else if ((k === "submit") && typeof x === "number") o.submitRef = refs[x] ?? null;
      else o[k] = mapEls(x, refs);
    }
    return o;
  }
  return v;
}

/** Lite mode: resolve ref, run, map elements to lite refs. */
async function callLite(_self: unknown, name: string, ref: string | null, args: unknown[]) {
  let self: El | null = null;
  if (ref) {
    self = byLiteRef(ref);
    if (!self) return { stale: true };
  }
  const r = await invoke(self, name, args);
  const refs = r.elements.map((e) => liteRef(e));
  return { value: mapEls(r.value, refs) };
}

const api = {
  invoke: (self: El | null, name: string, args: unknown[]) => invoke(self, name, args),
  callLite,
  // lite registry
  liteRef: (_s: unknown, el: El) => liteRef(el),
  byLiteRef: (_s: unknown, r: string) => byLiteRef(r),
  // queries
  find,
  info,
  rectOf,
  describeEl: (el: El) => describeEl(el),
  // action prep
  prepareAction,
  hitTest,
  frameOffset: frameOwnerIndex,
  scrollIntoView,
  scrollBy,
  // values
  setValue,
  focusSelect,
  focus,
  valueOf,
  selectOptions,
  getChecked,
  labelFor,
  // forms (./forms.ts)
  describeFields,
  fieldInfo,
  clickGateInfo,
  keyGateInfo,
  submitInfo,
  requestSubmit,
  comboOptions,
  resolveFileInput,
  clickSensitivity,
  keySensitivity,
  // extraction (./extract.ts)
  extractTable,
  extractLinks,
  extractSchema: (_s: unknown, o: Parameters<typeof extractSchema>[0]) => extractSchema(o),
  nextControl,
  markdown,
  text,
  storage,
  pageState,
  waitSelector,
  waitText,
  // lite mode
  snapshotDom,
  syntheticClick,
  syntheticHover,
  syntheticKey,
  syntheticType,
  // overlay
  showActivity,
  drawMarks,
  clearOverlay,
  version: () => 1,
};

export type PageLib = typeof api;

(globalThis as unknown as { __ta: PageLib }).__ta = api;
