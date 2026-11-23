// pagelib: DOM-side helpers. Runs in an *isolated world* (CDP isolated world in
// debugger mode, the content-script world in lite mode) and is installed as
// globalThis.__ta. Functions that return elements return { value, elements } and
// reference elements inside `value` as { el: <index> }; the background maps those
// indexes to refs.

type El = Element;
interface Ret<T = unknown> {
  value: T;
  elements: El[];
}

const MAX_TEXT = 20000;

// ---------------------------------------------------------------------------
// Element registry (lite mode): numeric ids that stand in for backendNodeIds.
// DOC_ID identifies this document instance; a new document gets a new pagelib
// instance and a new DOC_ID, which makes refs from the old document stale.
// ---------------------------------------------------------------------------
const reg = new Map<number, WeakRef<El>>();
const rev = new WeakMap<El, number>();
let regN = 0;
const DOC_ID = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
function liteId(el: El): number {
  let r = rev.get(el);
  if (!r) {
    r = ++regN;
    rev.set(el, r);
    reg.set(r, new WeakRef(el));
  }
  return r;
}
function byLiteId(id: number): El | null {
  const el = reg.get(id)?.deref();
  return el && el.isConnected ? el : null;
}

// ---------------------------------------------------------------------------
// Tree walking (pierces open shadow roots)
// ---------------------------------------------------------------------------
function* walk(root: Node): Generator<El> {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const kids: Node[] = [];
    if (n instanceof Element) {
      if (n !== root) yield n;
      if (n.shadowRoot) kids.push(...Array.from(n.shadowRoot.children));
    }
    if (n instanceof Element || n.nodeType === 9 || n instanceof DocumentFragment) {
      kids.push(...Array.from((n as ParentNode).children));
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

function deepQueryAll(root: ParentNode | null, selector: string): El[] {
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

function parentOf(el: El): El | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function closestDeep(el: El, selector: string): El | null {
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
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const lc = (s: string | null | undefined) => norm(s).toLowerCase();

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

function roleOf(el: El): string {
  const r = el.getAttribute("role");
  if (r) return r.split(/\s+/)[0].toLowerCase();
  return implicitRole(el);
}

function textOf(el: El): string {
  const h = el as HTMLElement;
  return norm(typeof h.innerText === "string" ? h.innerText : el.textContent);
}

function nameOf(el: El): string {
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

function isVisible(el: El): boolean {
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

function isDisabled(el: El): boolean {
  if ((el as HTMLInputElement).disabled) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  const fs = el.closest("fieldset[disabled]");
  if (fs && !fs.querySelector(":scope > legend")?.contains(el)) return true;
  return false;
}

function isEditable(el: El): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"].includes(t) && !(el as HTMLInputElement).readOnly;
  }
  return (el as HTMLElement).isContentEditable;
}

function describeEl(el: El): string {
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

function matchText(hay: string, needle: string): boolean {
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
function nativeSetter(el: El) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value")!.set!;
}

function fire(el: El, type: string) {
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

function valueOf(el: El) {
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

function getChecked(el: El): boolean | null {
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
// Forms
// ---------------------------------------------------------------------------
function isFormControl(el: El): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return !["hidden", "submit", "button", "reset", "image"].includes((el as HTMLInputElement).type);
  if (tag === "select" || tag === "textarea") return true;
  if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return true;
  const r = el.getAttribute("role");
  return !!r && ["textbox", "combobox", "checkbox", "radio", "switch", "searchbox", "spinbutton", "slider", "listbox"].includes(r);
}

function controls(container: ParentNode | null): El[] {
  return Array.from(walk((container ?? document) as Node)).filter(isFormControl);
}

function fieldType(el: El): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return (el as HTMLInputElement).type || "text";
  if (tag === "select") return (el as HTMLSelectElement).multiple ? "select-multiple" : "select";
  if (tag === "textarea") return "textarea";
  if ((el as HTMLElement).isContentEditable) return "contenteditable";
  return el.getAttribute("role") ?? tag;
}

function groupOf(el: El): string | null {
  if (el instanceof HTMLInputElement && el.type === "radio") {
    const fs = el.closest("fieldset");
    const legend = fs?.querySelector("legend");
    const rg = el.closest("[role=radiogroup]");
    return norm(legend?.textContent) || (rg ? nameOf(rg) : "") || el.name || null;
  }
  if (el.getAttribute("role") === "radio") {
    const rg = el.closest("[role=radiogroup]");
    return rg ? nameOf(rg) : null;
  }
  return null;
}

function describeForm(container: El | null): Ret {
  const els = controls(container);
  const forms = container ? (container.tagName === "FORM" ? [container] : deepQueryAll(container, "form")) : deepQueryAll(document, "form");
  const all: El[] = [...els];
  const fields = els.map((el, i) => {
    const f: Record<string, unknown> = {
      el: i,
      label: nameOf(el) || null,
      type: fieldType(el),
      name: el.getAttribute("name") || el.id || null,
    };
    if ((el as HTMLInputElement).required || el.getAttribute("aria-required") === "true") f.required = true;
    if (isDisabled(el)) f.disabled = true;
    if (!isVisible(el)) f.hidden = true;
    const ch = getChecked(el);
    if (ch !== null) f.checked = ch;
    else if (el instanceof HTMLSelectElement) {
      f.options = Array.from(el.options)
        .slice(0, 50)
        .map((o) => (o.selected ? `[${o.text.trim()}]` : o.text.trim()));
    } else {
      const v = valueOf(el);
      const t = (el as HTMLInputElement).type;
      f.value = t === "password" && v ? "••••" : v;
    }
    const g = groupOf(el);
    if (g) f.group = g;
    if ((el as HTMLInputElement).placeholder) f.placeholder = (el as HTMLInputElement).placeholder;
    const ac = el.getAttribute("autocomplete");
    if (ac && ac !== "off" && ac !== "on") f.autocomplete = ac;
    return f;
  });
  const formInfo = forms.map((fm) => {
    all.push(fm);
    const f = fm as HTMLFormElement;
    return { el: all.length - 1, name: f.getAttribute("name") || f.id || nameOf(f) || null, action: f.getAttribute("action"), method: (f.method || "get").toUpperCase(), sensitive: formSensitivity(f).length ? formSensitivity(f) : undefined };
  });
  return { value: { forms: formInfo, fields }, elements: all };
}

function candidates(el: El): string[] {
  return [nameOf(el), el.getAttribute("name"), el.id, (el as HTMLInputElement).placeholder, el.getAttribute("aria-label"), el.getAttribute("data-testid"), el.getAttribute("autocomplete")]
    .map((s) => lc(s).replace(/[*:]+$/g, "").trim())
    .filter(Boolean);
}

function scoreMatch(key: string, el: El): number {
  const k = lc(key).replace(/[*:]+$/g, "").trim();
  let best = 0;
  for (const c of candidates(el)) {
    if (c === k) best = Math.max(best, 4);
    else if (c.startsWith(k) || k.startsWith(c)) best = Math.max(best, 2.5);
    else if (c.includes(k)) best = Math.max(best, 1.5);
    else if (k.includes(c) && c.length > 2) best = Math.max(best, 1);
  }
  return best;
}

/** Resolve form.fill keys to concrete elements + actions. */
function planFill(container: El | null, fields: Record<string, string | boolean | string[]>): Ret {
  const els = controls(container).filter((e) => !isDisabled(e));
  const elements: El[] = [];
  const used = new Set<El>();
  const plan: Record<string, unknown>[] = [];
  const add = (e: El) => {
    elements.push(e);
    return elements.length - 1;
  };
  for (const [key, val] of Object.entries(fields)) {
    // radio groups: key matches group label/name, value matches radio label/value
    const radios = els.filter((e) => (e as HTMLInputElement).type === "radio" || e.getAttribute("role") === "radio");
    const groupHits = radios.filter((r) => {
      const g = groupOf(r);
      return (g && (lc(g) === lc(key) || lc(g).includes(lc(key)))) || lc(r.getAttribute("name")) === lc(key);
    });
    if (groupHits.length && typeof val === "string") {
      const pick = groupHits.find((r) => lc(nameOf(r)) === lc(val) || lc((r as HTMLInputElement).value) === lc(val)) ?? groupHits.find((r) => lc(nameOf(r)).includes(lc(val)));
      if (!pick) {
        plan.push({ key, status: "error", error: `No option "${val}" in group. Options: ${groupHits.map((r) => nameOf(r) || (r as HTMLInputElement).value).join(" | ")}` });
        continue;
      }
      plan.push({ key, kind: "radio", el: add(pick), checked: getChecked(pick) });
      continue;
    }
    let best: El | null = null;
    let bestScore = 0;
    for (const e of els) {
      if (used.has(e)) continue;
      if ((e as HTMLInputElement).type === "radio") continue;
      const s = scoreMatch(key, e) + (isVisible(e) ? 0.1 : 0);
      if (s > bestScore) {
        best = e;
        bestScore = s;
      }
    }
    if (!best || bestScore < 1) {
      plan.push({ key, status: "error", error: `No field matching "${key}". Fields: ${els.map((e) => nameOf(e) || e.getAttribute("name")).filter(Boolean).slice(0, 30).join(" | ")}` });
      continue;
    }
    used.add(best);
    const t = fieldType(best);
    const kind =
      t === "checkbox" || best.getAttribute("role") === "checkbox" || best.getAttribute("role") === "switch"
        ? "checkbox"
        : t.startsWith("select") || best.getAttribute("role") === "combobox" || best.getAttribute("role") === "listbox"
          ? "select"
          : t === "file"
            ? "file"
            : "text";
    plan.push({ key, kind, el: add(best), checked: getChecked(best), label: nameOf(best) });
  }
  return { value: plan, elements };
}

const SENSITIVE_NAME = /card|cc-?num|ccnum|cvv|cvc|csc|security.?code|expir|ssn|social.?sec|iban|routing|account.?num|tax.?id/i;

function formSensitivity(form: El | null): string[] {
  if (!form) return [];
  const reasons = new Set<string>();
  for (const el of controls(form)) {
    const inp = el as HTMLInputElement;
    const ac = el.getAttribute("autocomplete") ?? "";
    const hay = [el.getAttribute("name"), el.id, ac, nameOf(el)].join(" ");
    if (inp.type === "password" && inp.value) reasons.add("password field");
    if (/^cc-/.test(ac) || /card|cc-?num|ccnum|cvv|cvc|csc/i.test(hay)) reasons.add("payment card field");
    if (/ssn|social.?sec/i.test(hay)) reasons.add("SSN field");
    if (/iban|routing|account.?num/i.test(hay)) reasons.add("bank account field");
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(inp.value ?? "") && SENSITIVE_NAME.test(hay)) reasons.add("SSN-like value");
  }
  return Array.from(reasons);
}

const RISKY = /\b(buy|purchase|place (your )?order|pay(ment)?|pay now|checkout|check out|delete|remove|destroy|send|transfer|wire|withdraw|confirm (payment|order|purchase)|submit order|subscribe|unsubscribe|cancel (my )?(account|subscription)|close account|deactivate|book now|donate)\b/i;

function clickSensitivity(el: El) {
  const label = nameOf(el) || textOf(el).slice(0, 80);
  const reasons: string[] = [];
  if (RISKY.test(label)) reasons.push(`"${label.slice(0, 60)}" looks like a purchase/delete/send action`);
  const isSubmit = (el instanceof HTMLButtonElement && (el.type === "submit" || !el.getAttribute("type"))) || (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type));
  if (isSubmit) {
    const f = (el as HTMLButtonElement).form;
    for (const r of formSensitivity(f)) reasons.push(`submits a form with a ${r}`);
  }
  return { label, reasons };
}

function keySensitivity(_self: unknown, key: string) {
  const el = deepActive();
  if (!el || !/enter/i.test(key)) return { reasons: [] };
  const f = (el as HTMLInputElement).form;
  return { reasons: formSensitivity(f ?? null).map((r) => `Enter submits a form with a ${r}`) };
}

function deepActive(): El | null {
  let a: El | null = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function formFor(el: El | null): Ret<{ el: number; submit: number | null; sensitive: string[] } | null> {
  let form: HTMLFormElement | null = null;
  if (el) form = el instanceof HTMLFormElement ? el : ((el as HTMLInputElement).form ?? (el.closest("form") as HTMLFormElement | null));
  if (!form) {
    const forms = deepQueryAll(document, "form").filter(isVisible) as HTMLFormElement[];
    form = forms[0] ?? null;
  }
  if (!form) return { value: null, elements: [] };
  const submit = Array.from(form.querySelectorAll('button[type=submit],input[type=submit],input[type=image],button:not([type])')).find(isVisible) ?? null;
  const elements: El[] = [form];
  if (submit) elements.push(submit);
  return { value: { el: 0, submit: submit ? 1 : null, sensitive: formSensitivity(form) }, elements };
}

function requestSubmit(form: El) {
  (form as HTMLFormElement).requestSubmit();
  return true;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
function cellText(c: El) {
  return textOf(c);
}

function tableInfo(t: El) {
  const isHtml = t.tagName === "TABLE";
  let headerCells: El[] = [];
  let bodyRows: El[][] = [];
  if (isHtml) {
    const tbl = t as HTMLTableElement;
    const rows = Array.from(tbl.rows);
    const theadRow = tbl.tHead?.rows[0];
    if (theadRow) headerCells = Array.from(theadRow.cells);
    else if (rows[0] && Array.from(rows[0].cells).every((c) => c.tagName === "TH")) headerCells = Array.from(rows[0].cells);
    bodyRows = rows.filter((r) => r !== theadRow && !(headerCells.length && r === rows[0] && !theadRow) && r.parentElement?.tagName !== "THEAD").map((r) => Array.from(r.cells));
  } else {
    const rows = deepQueryAll(t, "[role=row]");
    for (const r of rows) {
      const ch = Array.from(r.querySelectorAll("[role=columnheader]"));
      if (ch.length && !headerCells.length) headerCells = ch;
      else bodyRows.push(Array.from(r.querySelectorAll("[role=cell],[role=gridcell],[role=rowheader]")));
    }
  }
  return { headerCells, bodyRows };
}

function extractTable(root: El | null, index?: number) {
  const tables = root && (root.matches("table,[role=table],[role=grid]")) ? [root] : deepQueryAll(root ?? document, "table,[role=table],[role=grid]").filter((t) => !t.parentElement?.closest("table"));
  if (!tables.length) return { error: "No tables found on the page" };
  let pick: El;
  let pickIndex = 0;
  if (index != null) {
    if (!tables[index]) return { error: `Table index ${index} out of range (${tables.length} tables)` };
    pick = tables[index];
    pickIndex = index;
  } else {
    let bestSize = -1;
    pick = tables[0];
    tables.forEach((t, i) => {
      const { bodyRows } = tableInfo(t);
      const size = bodyRows.reduce((a, r) => a + r.length, 0);
      if (size > bestSize) {
        bestSize = size;
        pick = t;
        pickIndex = i;
      }
    });
  }
  const { headerCells, bodyRows } = tableInfo(pick);
  const width = Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 0);
  const headers: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let h = headerCells[i] ? cellText(headerCells[i]) : "";
    if (!h) h = `col${i + 1}`;
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    headers.push(n ? `${h}_${n + 1}` : h);
  }
  const rows = bodyRows
    .filter((r) => r.length)
    .map((r) => {
      const o: Record<string, string> = {};
      r.forEach((c, i) => {
        o[headers[i] ?? `col${i + 1}`] = cellText(c);
      });
      return o;
    });
  return { headers, rows, count: rows.length, tableIndex: pickIndex, totalTables: tables.length, caption: nameOf(pick) || undefined };
}

function extractLinks(_self: unknown, filter?: string, limit = 200) {
  const seen = new Set<string>();
  const out: { text: string; href: string }[] = [];
  for (const a of deepQueryAll(document, "a[href]") as HTMLAnchorElement[]) {
    const href = a.href;
    if (!href || href.startsWith("javascript:")) continue;
    const text = nameOf(a) || textOf(a);
    if (filter && !matchText(text, filter) && !matchText(href, filter)) continue;
    const k = text + "\u0000" + href;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ text: text.slice(0, 200), href });
    if (out.length >= limit) break;
  }
  return { links: out, count: out.length };
}

function cssPath(el: El, stopAt?: El | null): string {
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !stopAt) return "#" + el.id;
  const parts: string[] = [];
  let cur: El | null = el;
  while (cur && cur !== stopAt && cur.tagName !== "HTML") {
    let seg = cur.tagName.toLowerCase();
    const cls = typeof cur.className === "string" ? cur.className.trim().split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 2) : [];
    if (cls.length) seg += "." + cls.join(".");
    const parent: El | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName && (cls.length ? cls.every((k) => c.classList.contains(k)) : true));
      if (same.length > 1) seg += `:nth-of-type(${Array.from(parent.children).filter((c) => c.tagName === cur!.tagName).indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id) && !stopAt) {
      parts[0] = "#" + cur.id;
      break;
    }
    cur = parent;
  }
  return parts.join(" > ");
}

function signature(el: El): string {
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((c) => c && !/\d{3,}/.test(c)).sort().join(".") : "";
  return el.tagName.toLowerCase() + (cls ? "." + cls : "");
}

function propSelectors(p: string): string[] {
  const k = p.replace(/[^\w-]/g, "");
  const kebab = k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const set = new Set([k, kebab, k.toLowerCase()]);
  const out: string[] = [];
  for (const s of set) {
    out.push(`[itemprop="${s}"]`, `[data-field="${s}"]`, `[data-testid="${s}"]`, `[name="${s}"]`, `.${CSS.escape(s)}`, `[class*="${s}"]`, `[data-testid*="${s}"]`, `[aria-label*="${s}" i]`);
  }
  return out;
}

function findPropEl(scope: El | Document, p: string): { el: El; sel: string } | null {
  for (const sel of propSelectors(p)) {
    let el: El | null = null;
    try {
      el = scope.querySelector(sel);
    } catch {
      continue;
    }
    if (el) return { el, sel };
  }
  // label/value pairs: <dt>Price</dt><dd>..</dd>, <th>Price</th><td>..</td>, "Price: x"
  const k = lc(p.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "));
  const labelEls = Array.from((scope as ParentNode).querySelectorAll("dt,th,label,strong,b,span,div")).filter((e) => lc(textOf(e)).replace(/:$/, "") === k);
  for (const le of labelEls) {
    const sib = le.nextElementSibling;
    if (sib && textOf(sib)) return { el: sib, sel: `${le.tagName.toLowerCase()}:contains(${p}) + *` };
  }
  return null;
}

function coerce(el: El, p: string, schema: Record<string, unknown>): unknown {
  const type = (schema?.type as string) ?? "string";
  const fmt = schema?.format as string | undefined;
  const pl = p.toLowerCase();
  if (fmt === "uri" || /url|link|href/.test(pl)) {
    const a = el.closest("a[href]") ?? el.querySelector("a[href]");
    if (a) return (a as HTMLAnchorElement).href;
    if (el instanceof HTMLImageElement) return el.src;
  }
  if (/image|img|photo|thumbnail|src/.test(pl)) {
    const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
    if (img) return (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src;
  }
  const txt = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.getAttribute("content") ?? textOf(el);
  if (type === "number" || type === "integer") {
    const m = txt.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    return type === "integer" ? Math.round(parseFloat(m[0])) : parseFloat(m[0]);
  }
  if (type === "boolean") return /^(true|yes|1|in stock|available)$/i.test(txt.trim());
  return txt;
}

function extractSchema(_self: unknown, schema: Record<string, unknown>, hint?: string) {
  const isArray = schema.type === "array";
  const itemSchema = (isArray ? (schema.items as Record<string, unknown>) : schema) ?? {};
  const props = (itemSchema.properties as Record<string, Record<string, unknown>>) ?? {};
  const names = Object.keys(props);
  if (!names.length) return { error: "Schema needs properties (an object, or an array whose items have properties)" };

  let items: El[] = [];
  let itemSel: string | null = hint ?? null;
  if (hint) items = deepQueryAll(document, hint);
  else if (isArray) {
    // auto-detect a repeated container
    const counts = new Map<string, Set<El>>();
    const cover = new Map<string, Set<string>>();
    for (const p of names) {
      for (const sel of propSelectors(p)) {
        let hits: El[] = [];
        try {
          hits = Array.from(document.querySelectorAll(sel));
        } catch {
          continue;
        }
        if (hits.length < 2) continue;
        for (const h of hits) {
          let a: El | null = h.parentElement;
          let depth = 0;
          while (a && a !== document.body && depth < 6) {
            const sig = signature(a);
            if (!counts.has(sig)) counts.set(sig, new Set());
            counts.get(sig)!.add(a);
            if (!cover.has(sig)) cover.set(sig, new Set());
            cover.get(sig)!.add(p);
            a = a.parentElement;
            depth++;
          }
        }
        break;
      }
    }
    let best: string | null = null;
    let bestScore = 0;
    for (const [sig, set] of counts) {
      const n = set.size;
      if (n < 2) continue;
      // prefer sigs that cover the most props, then the innermost (most items)
      const score = (cover.get(sig)!.size / names.length) * 1000 + n;
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
  if (!isArray && !items.length) items = [document.documentElement];
  if (!items.length) return { error: "Could not detect repeated items; pass hint (CSS selector of each item)" };

  const fieldSel: Record<string, string> = {};
  const data = items.slice(0, 500).map((it) => {
    const o: Record<string, unknown> = {};
    for (const p of names) {
      const hit = findPropEl(it, p);
      if (hit) {
        fieldSel[p] ??= hit.sel;
        o[p] = coerce(hit.el, p, props[p]);
      } else o[p] = null;
    }
    return o;
  });
  return { data: isArray ? data : data[0], count: isArray ? data.length : 1, selectors: { item: itemSel, fields: fieldSel } };
}

function nextLink(_self: unknown, text?: string, selector?: string): Ret<{ el: number } | null> {
  let el: El | null = null;
  if (selector) el = deepQueryAll(document, selector).find(isVisible) ?? null;
  if (!el) el = deepQueryAll(document, "a[rel=next],link[rel=next]").find((e) => e.tagName === "A" && isVisible(e)) ?? null;
  if (!el) {
    const re = text ? null : /^(next( page)?|›|»|→|>)$/i;
    el =
      deepQueryAll(document, "a[href],button,[role=button],[role=link]").find((e) => {
        if (!isVisible(e) || isDisabled(e)) return false;
        const n = nameOf(e) || textOf(e);
        return text ? lc(n) === lc(text) || lc(n).startsWith(lc(text)) : re!.test(norm(n)) || /next/i.test(e.getAttribute("aria-label") ?? "");
      }) ?? null;
  }
  return el ? { value: { el: 0 }, elements: [el] } : { value: null, elements: [] };
}

// ---------------------------------------------------------------------------
// Markdown / text
// ---------------------------------------------------------------------------
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head", "button", "input", "select", "textarea"]);

function mainRoot(): El {
  const m = document.querySelector("main,[role=main]");
  if (m && textOf(m).length > 200) return m;
  const arts = Array.from(document.querySelectorAll("article"));
  if (arts.length) return arts.sort((a, b) => textOf(b).length - textOf(a).length)[0];
  return document.body;
}

function md(el: Node, ctx: { list?: string; depth: number }, skipChrome: boolean): string {
  if (el.nodeType === Node.TEXT_NODE) return (el.textContent ?? "").replace(/\s+/g, " ");
  if (!(el instanceof Element)) return "";
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return "";
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return "";
  if (skipChrome && ["nav", "footer", "aside", "header"].includes(tag)) return "";
  if (skipChrome && ["navigation", "contentinfo", "complementary", "banner"].includes(el.getAttribute("role") ?? "")) return "";
  if (!isVisible(el) && tag !== "br" && el.getClientRects().length === 0 && getComputedStyle(el).display === "none") return "";
  const kids = () => Array.from(el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes).map((c) => md(c, ctx, skipChrome)).join("");
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(+tag[1])} ${norm(kids())}\n\n`;
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
    case "dl":
      return `\n\n${kids()}\n\n`;
    case "br":
      return "  \n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b": {
      const t = norm(kids());
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = norm(kids());
      return t ? `*${t}*` : "";
    }
    case "code":
      return el.closest("pre") ? kids() : `\`${norm(el.textContent)}\``;
    case "pre":
      return `\n\n\`\`\`\n${el.textContent ?? ""}\n\`\`\`\n\n`;
    case "blockquote":
      return "\n\n" + norm(kids()).split(/\n/).map((l) => "> " + l).join("\n") + "\n\n";
    case "a": {
      const t = norm(kids());
      const href = (el as HTMLAnchorElement).href;
      return t ? (href && !href.startsWith("javascript:") ? `[${t}](${href})` : t) : "";
    }
    case "img": {
      const alt = (el as HTMLImageElement).alt;
      return alt ? `![${alt}](${(el as HTMLImageElement).src})` : "";
    }
    case "ul":
    case "ol": {
      let i = 0;
      const items = Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li) => {
          i++;
          const pre = tag === "ol" ? `${i}. ` : "- ";
          const body = norm(md(li, { list: tag, depth: ctx.depth + 1 }, skipChrome).replace(/\n+/g, " "));
          return "  ".repeat(ctx.depth) + pre + body;
        });
      return "\n\n" + items.join("\n") + "\n\n";
    }
    case "li":
      return kids();
    case "dt":
      return `\n**${norm(kids())}**\n`;
    case "dd":
      return `: ${norm(kids())}\n`;
    case "table": {
      const t = extractTable(el);
      if ("error" in t || !t.headers?.length) return "";
      const head = `| ${t.headers.join(" | ")} |\n| ${t.headers.map(() => "---").join(" | ")} |`;
      const rows = t.rows.map((r) => `| ${t.headers.map((h) => (r[h] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
      return `\n\n${head}\n${rows}\n\n`;
    }
  }
  return kids();
}

function markdown(_self: unknown, maxChars = MAX_TEXT) {
  const root = mainRoot();
  let out = md(root, { depth: 0 }, root === document.body);
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = document.title;
  const truncated = out.length > maxChars;
  return { title, url: location.href, markdown: truncated ? out.slice(0, maxChars) + "\n\n… [truncated]" : out, truncated };
}

function text(el: El | null) {
  const t = ((el ?? document.body) as HTMLElement).innerText ?? "";
  return { text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + "\n… [truncated]" : t, truncated: t.length > MAX_TEXT };
}

// ---------------------------------------------------------------------------
// Driver support: lite-mode DOM walker (AX-shaped output, rendered by the same
// pure renderer as CDP trees), auto-wait observations, find, DOM quiet.
// ---------------------------------------------------------------------------
interface LiteAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

const LITE_ROLE: Record<string, string> = { iframe: "Iframe", presentation: "none", img: "image" };
const SKIP_WALK = new Set(["script", "style", "noscript", "template", "head", "link", "meta"]);

function isOverlay(el: El): boolean {
  return el.hasAttribute("data-tabagent-overlay");
}

const SENSITIVE_INPUT = /card|cc-?num|ccnum|cvv|cvc|csc|security.?code/i;
function isSensitiveInput(el: El): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "password") return true;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/^cc-(number|csc|exp)/.test(ac) || /\bone-time-code\b/.test(ac)) return true;
  return SENSITIVE_INPUT.test(el.name || "") || SENSITIVE_INPUT.test(el.id || "");
}

/** D18: password and card inputs (values are masked in snapshots and diffs). */
function sensitiveInputs(self: El | null): Ret {
  const els = Array.from(walk((self ?? document) as Node)).filter(isSensitiveInput);
  return { value: els.map((_e, i) => ({ el: i })), elements: els };
}

function domAxTree(self: El | null) {
  const nodes: LiteAXNode[] = [];
  const sensitive: number[] = [];
  let n = 0;
  const add = (node: Omit<LiteAXNode, "nodeId">, parent?: LiteAXNode): LiteAXNode => {
    const x: LiteAXNode = { nodeId: String(++n), ...node, ...(parent ? { parentId: parent.nodeId } : {}) };
    nodes.push(x);
    if (parent) (parent.childIds ??= []).push(x.nodeId);
    return x;
  };
  const visitChildren = (container: Node, parent: LiteAXNode) => {
    const kids: Node[] = [];
    if (container instanceof Element && container.shadowRoot) kids.push(...Array.from(container.shadowRoot.childNodes));
    kids.push(...Array.from(container.childNodes));
    for (const k of kids) visit(k, parent);
  };
  const visit = (node: Node, parent: LiteAXNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = norm(node.textContent);
      if (t) add({ role: { value: "StaticText" }, name: { value: t } }, parent);
      return;
    }
    if (!(node instanceof Element)) return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP_WALK.has(tag) || isOverlay(el) || el.getAttribute("aria-hidden") === "true") return;
    if (el instanceof HTMLElement && el.hidden && tag !== "option") return;
    const st = getComputedStyle(el);
    if (st.display === "none" && tag !== "option") return;
    const hiddenVis = st.visibility === "hidden";
    let role = roleOf(el);
    if (tag === "select") role = (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
    const name = ["generic", "none", "presentation", "paragraph", "listitem", "row"].includes(role) ? "" : nameOf(el);
    const props: { name: string; value: { value: unknown } }[] = [];
    const ch = getChecked(el);
    if (ch !== null && ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) props.push({ name: "checked", value: { value: String(ch) } });
    if (el.getAttribute("aria-expanded")) props.push({ name: "expanded", value: { value: el.getAttribute("aria-expanded") === "true" } });
    if (el.getAttribute("aria-selected") === "true" || (el instanceof HTMLOptionElement && el.selected && role === "option")) props.push({ name: "selected", value: { value: true } });
    if (isDisabled(el)) props.push({ name: "disabled", value: { value: true } });
    if ((el as HTMLInputElement).required) props.push({ name: "required", value: { value: true } });
    if ((el as HTMLInputElement).readOnly && (tag === "input" || tag === "textarea")) props.push({ name: "readonly", value: { value: true } });
    if (role === "heading") props.push({ name: "level", value: { value: Number(el.tagName.match(/^H(\d)$/)?.[1] ?? el.getAttribute("aria-level") ?? 2) } });
    if (el.hasAttribute("tabindex") && (el as HTMLElement).tabIndex >= 0) props.push({ name: "focusable", value: { value: true } });
    let value: string | undefined;
    if (tag === "select") value = (el as HTMLSelectElement).selectedOptions[0]?.text.trim() ?? "";
    else if (isEditable(el) || ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role)) value = valueOf(el);
    const ax = add(
      {
        ...(hiddenVis ? { ignored: true } : {}),
        role: { value: LITE_ROLE[role] ?? role },
        ...(name ? { name: { value: name } } : {}),
        ...(value !== undefined ? { value: { value } } : {}),
        ...(props.length ? { properties: props } : {}),
        backendDOMNodeId: liteId(el),
      },
      parent,
    );
    if (isSensitiveInput(el)) sensitive.push(ax.backendDOMNodeId!);
    if (tag === "iframe") return;
    visitChildren(el, ax);
  };
  const root = add({ role: { value: self ? "generic" : "RootWebArea" }, name: { value: document.title }, ...(self ? { backendDOMNodeId: liteId(self) } : {}) });
  if (self) visitChildren(self, root);
  else if (document.body) visitChildren(document.body, root);
  return { nodes, sensitive, docId: DOC_ID, url: location.href, title: document.title };
}

/** One auto-wait observation (frame-local CSS px). */
async function observe(el: El, opts: { scroll?: boolean } = {}) {
  if (!el.isConnected) return { attached: false, visible: false, enabled: false, box: null, inView: false };
  if (opts.scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const visible = isVisible(el);
  const enabled = !isDisabled(el);
  const editable = isEditable(el);
  const a = el.getBoundingClientRect();
  await raf();
  const b = el.getBoundingClientRect();
  const rects = el.getClientRects();
  const r = rects.length ? rects[0] : b;
  const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1));
  const y = r.top + Math.min(r.height / 2, Math.max(1, r.height - 1));
  const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const box = (q: DOMRect) => ({ x: q.left, y: q.top, w: q.width, h: q.height });
  return { attached: true, visible, enabled, editable, box: box(a), box2: box(b), inView, point: { x, y }, hit: inView && visible ? hitTest(el, x, y) : undefined };
}

interface FindSpec2 {
  by: "text" | "role" | "label" | "css" | "xpath";
  value: string;
  name?: string;
  limit?: number;
}

/** page.find: document order, up to limit+1 so the caller can flag truncation. */
function findNodes(self: El | null, q: FindSpec2): Ret {
  const root = (self ?? document) as Node;
  const limit = (q.limit ?? 20) + 1;
  let cands: El[];
  if (q.by === "css") cands = deepQueryAll(root as ParentNode, q.value);
  else if (q.by === "xpath") {
    let snap: XPathResult;
    try {
      snap = document.evaluate(q.value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch {
      throw new Error(`Invalid xpath: ${q.value}`);
    }
    cands = [];
    for (let i = 0; i < snap.snapshotLength; i++) {
      const n = snap.snapshotItem(i);
      if (n instanceof Element) cands.push(n);
    }
  } else {
    cands = Array.from(walk(root)).filter((e) => !isOverlay(e) && !SKIP_WALK.has(e.tagName.toLowerCase()));
    if (q.by === "role") cands = cands.filter((e) => roleOf(e) === q.value.toLowerCase());
    else if (q.by === "label") cands = cands.filter((e) => isFormControl(e) && lc(nameOf(e)).includes(lc(q.value)));
    else if (q.by === "text") {
      const needle = lc(q.value);
      const hits = cands.filter((e) => !["html", "body"].includes(e.tagName.toLowerCase()) && (lc(textOf(e)).includes(needle) || lc(nameOf(e)).includes(needle)));
      const set = new Set(hits);
      const inner = hits.filter((e) => !Array.from(e.children).some((c) => set.has(c)) && !(e.shadowRoot && Array.from(e.shadowRoot.children).some((c) => set.has(c))));
      cands = Array.from(new Set(inner.map((e) => closestDeep(e, "a[href],button,[role=button],[role=link],summary,[role=tab],[role=menuitem],[role=option],label") ?? e)));
    }
  }
  if (q.name) cands = cands.filter((e) => lc(nameOf(e)).includes(lc(q.name)));
  const els = cands.slice(0, limit);
  return { value: { total: cands.length, matches: els.map((e, i) => ({ el: i, role: roleOf(e), name: nameOf(e).slice(0, 120) })) }, elements: els };
}

/** D24: resolve once the DOM has been quiet for `quiet` ms (max `max` ms). Timers, not rAF: works in background tabs. */
function quietDom(_self: unknown, quiet = 100, max = 1000): Promise<{ quiet: boolean; waited: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => done(true), quiet);
    });
    function done(q: boolean) {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve({ quiet: q, waited: Date.now() - t0 });
    }
    hard = setTimeout(() => done(false), max);
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => done(true), quiet);
  });
}

/** Metrics of an <iframe> element for frame -> top-level coordinate translation. */
function ownerMetrics(iframe: El) {
  const r = iframe.getBoundingClientRect();
  const s = getComputedStyle(iframe);
  return { rect: { left: r.left, top: r.top }, clientLeft: iframe.clientLeft, clientTop: iframe.clientTop, paddingLeft: parseFloat(s.paddingLeft || "0"), paddingTop: parseFloat(s.paddingTop || "0") };
}

function rectsOf(_self: unknown, ...els: El[]) {
  return els.map((e) => {
    if (!e || !e.isConnected) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
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

/** Lite mode drag: synthetic HTML5 drag events from `el` to the element with lite id `toId`. */
function syntheticDragTo(el: El, toId: number) {
  const to = byLiteId(toId);
  if (!to) throw new Error("drop target is no longer in the page");
  const dt = new DataTransfer();
  const at = (e: El) => {
    const r = e.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  };
  el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(el) }));
  to.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(to) }));
  to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(to) }));
  to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(to) }));
  el.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer: dt, ...at(el) }));
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
// Overlay (D40): elements carry data-tabagent-overlay, pointer-events:none, are
// aria-hidden (so excluded from snapshots) and hidden while a screenshot is
// taken. Set-of-marks labels use their own host, which stays visible.
// ---------------------------------------------------------------------------
const OVERLAY_ID = "__tabagent_overlay__";
const MARKS_ID = "__tabagent_marks__";
const shadowFor = new WeakMap<HTMLElement, ShadowRoot>();
function overlayShadow(id = OVERLAY_ID, kind = "activity"): ShadowRoot {
  let host = document.getElementById(id) as HTMLElement | null;
  if (host && shadowFor.has(host)) return shadowFor.get(host)!;
  host?.remove();
  host = document.createElement("div");
  host.id = id;
  host.setAttribute("data-tabagent-overlay", kind);
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
  overlayTimer = setTimeout(() => document.getElementById(OVERLAY_ID)?.remove(), 1500) as unknown as number;
  return true;
}

/** Hide (or restore) the activity overlay, e.g. while a screenshot is taken. */
function hideOverlay(_self: unknown, hidden: boolean) {
  const host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (host) host.style.visibility = hidden ? "hidden" : "visible";
  return !!host;
}

function drawMarks(_self: unknown, marks: { label: string; x: number; y: number; w: number; h: number }[]) {
  const sr = overlayShadow(MARKS_ID, "marks");
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
  document.getElementById(MARKS_ID)?.remove();
  return true;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function storage(_self: unknown, kind: "local" | "session") {
  const s = kind === "session" ? sessionStorage : localStorage;
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!;
    const v = s.getItem(k) ?? "";
    out[k] = v.length > 2000 ? v.slice(0, 2000) + "…" : v;
  }
  return { origin: location.origin, entries: out, count: s.length };
}

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

/**
 * Lite mode entry: resolve an element id from this document, run `name`, and
 * return element ids for returned elements. A docId from another document, or
 * an element that's gone, reports `stale`.
 */
async function callLite(_self: unknown, name: string, id: number | null, docId: string | null, args: unknown[]) {
  if (docId && docId !== DOC_ID) return { stale: "navigated", docId: DOC_ID };
  let self: El | null = null;
  if (id != null) {
    self = byLiteId(id);
    if (!self) return { stale: "gone", docId: DOC_ID };
  }
  const r = await invoke(self, name, args);
  return { value: r.value, ids: r.elements.map((e) => (e ? liteId(e) : -1)), docId: DOC_ID };
}

const api = {
  invoke: (self: El | null, name: string, args: unknown[]) => invoke(self, name, args),
  callLite,
  // lite registry
  docId: () => DOC_ID,
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
  // forms
  describeForm,
  planFill,
  formFor,
  requestSubmit,
  formSensitivity: (el: El) => formSensitivity(el),
  clickSensitivity,
  keySensitivity,
  // extraction
  extractTable,
  extractLinks,
  extractSchema,
  nextLink,
  markdown,
  text,
  storage,
  pageState,
  waitSelector,
  waitText,
  // driver (snapshot, auto-wait, find, frames)
  domAxTree,
  sensitiveInputs,
  observe,
  findNodes,
  quietDom,
  ownerMetrics,
  rectsOf,
  hideOverlay,
  // lite mode
  syntheticDragTo,
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
