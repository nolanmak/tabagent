// Pure snapshot renderer: CDP accessibility trees (or the lite DOM walker's
// AX-shaped nodes) -> compact, ref-annotated text. No chrome.*, no CDP.
//
// D23: `interactive` (default) = interactive nodes with refs, plus landmarks and
// headings as unreferenced structure. `full` = everything, including text.
// Budget: maxTokens (default 6000), token = ceil(chars / 4). Over budget, a hard
// stop with `… truncated, N more nodes; narrow with root=<ref>` (D23, M1).
// Refs are minted only for lines that are actually shown.
// D18: password / card values render as `value="••••"`.
import { taErr } from "./errors";

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface FrameTree {
  key: string;
  nodes: AXNode[];
  /** The <iframe> element hosting this frame, in the parent frame. */
  ownerBackendNodeId?: number;
  ownerFrameKey?: string;
  /** backendNodeIds of password / card inputs in this frame (values masked). */
  sensitive?: number[];
}

export interface RefSource {
  /** Existing ref for a node, if it already has one. */
  peek(frameKey: string, backendNodeId: number): string | undefined;
  /** Existing or new ref. */
  mint(frameKey: string, backendNodeId: number): string;
  /** The number a newly minted ref would get (for budget estimates). */
  nextNumber(): number;
}

export interface RenderOpts {
  mode?: "interactive" | "full";
  maxTokens?: number;
  root?: { frameKey: string; backendNodeId: number };
  refs: RefSource;
}

export interface ShownRef {
  ref: string;
  frameKey: string;
  backendNodeId: number;
  interactive: boolean;
}

export interface RenderResult {
  text: string;
  lines: string[];
  refs: string[];
  shown: ShownRef[];
  truncated: boolean;
  /** Nodes dropped by the hard stop. */
  omitted: number;
  tokens: number;
}

export const DEFAULT_MAX_TOKENS = 6000;
export const MASK = "••••";
export const tokensOf = (s: string) => Math.ceil(s.length / 4);

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider",
  "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "MenuListOption", "PopUpButton", "textField",
  "ToggleButton", "DisclosureTriangle", "TextField", "ComboBoxSelect", "ComboBoxMenuButton", "Date", "DateTime", "InputTime", "ColorWell",
]);
/** D23 structure shown (without refs) in interactive mode. */
const LANDMARKS = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "form", "search", "dialog", "alertdialog"]);
const NAMED_LANDMARKS = new Set(["region"]);
/** Structure shown in full mode. */
const STRUCT = new Set([
  "heading", "main", "navigation", "banner", "contentinfo", "complementary", "form", "search", "dialog", "alertdialog",
  "alert", "status", "table", "row", "cell", "columnheader", "rowheader", "gridcell", "list", "listitem", "image", "img",
  "article", "tablist", "tabpanel", "menu", "menubar", "toolbar", "tree", "grid", "paragraph", "blockquote",
  "figure", "term", "definition", "DescriptionList", "progressbar", "meter", "log", "marquee", "timer", "note", "code", "region", "group", "radiogroup",
]);
const FULL_NAMED_ONLY = new Set(["region", "group", "figure", "radiogroup"]);
/** Containers that get a ref in full mode (so root= can target them). */
const REF_STRUCT = new Set(["form", "table", "grid", "dialog", "alertdialog", "list", "tabpanel", "region", "group", "radiogroup", "menu", "tree", "article"]);
const TEXTUAL = new Set(["paragraph", "listitem", "cell", "gridcell", "columnheader", "rowheader", "term", "definition", "blockquote", "code", "heading", "status", "alert", "log", "note"]);
const NAME_COVERS_TEXT = new Set(["link", "button", "heading", "option", "tab", "menuitem", "cell", "columnheader", "rowheader", "listitem", "MenuListOption", "checkbox", "radio", "switch", "gridcell"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton", "textField", "PopUpButton", "TextField", "Date", "DateTime", "InputTime"]);
const ROLE_ALIAS: Record<string, string> = {
  MenuListOption: "option",
  PopUpButton: "combobox",
  ComboBoxSelect: "combobox",
  image: "img",
  Iframe: "iframe",
  IframePresentational: "iframe",
  textField: "textbox",
  TextField: "textbox",
  DescriptionList: "list",
  ToggleButton: "button",
  Date: "textbox",
  DateTime: "textbox",
  InputTime: "textbox",
  ColorWell: "button",
};
const SKIP = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}

export function quote(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s*\n+\s*/g, " ")}"`;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------
interface TNode {
  /** Printed line, or a transparent node whose children are spliced in. */
  line?: { head: string; tail: string; refKey?: [string, number]; interactive: boolean };
  role: string;
  /** For collapse: the node that can be passed as root=. */
  key?: [string, number];
  children: TNode[];
}

/** Remove text lines (also inside transparent wrappers) once a name already covers them. */
function dropText(ns: TNode[]): TNode[] {
  const out: TNode[] = [];
  for (const c of ns) {
    if (c.role === "text") continue;
    if (!c.line) {
      const kids = dropText(c.children);
      if (kids.length) out.push({ ...c, children: kids });
    } else out.push(c);
  }
  return out;
}

function isInteractiveNode(n: AXNode, rawRole: string, name: string): boolean {
  if (INTERACTIVE.has(rawRole)) return true;
  // focusable custom widgets with a name (role=button-less divs with tabindex + aria-label, etc.)
  return prop(n, "focusable") === true && !!name && !["RootWebArea", "WebArea", "generic", "paragraph", "StaticText", "Iframe", "IframePresentational", "none"].includes(rawRole) && !STRUCT.has(rawRole) && !LANDMARKS.has(rawRole);
}

function build(frames: FrameTree[], opts: { mode: "interactive" | "full"; root?: { frameKey: string; backendNodeId: number } }): TNode[] {
  const full = opts.mode === "full";
  const childFrame = new Map<string, FrameTree>();
  for (const f of frames) {
    if (f.ownerBackendNodeId == null) continue;
    childFrame.set(`${f.ownerFrameKey ?? ""}#${f.ownerBackendNodeId}`, f);
    if (!childFrame.has(`#${f.ownerBackendNodeId}`)) childFrame.set(`#${f.ownerBackendNodeId}`, f);
  }
  const frameFor = (parentKey: string, owner: number) => childFrame.get(`${parentKey}#${owner}`) ?? childFrame.get(`#${owner}`);

  const renderFrame = (f: FrameTree, startNodeId?: string): TNode[] => {
    const byId = new Map(f.nodes.map((n) => [n.nodeId, n]));
    const sensitive = new Set(f.sensitive ?? []);

    const textOf = (n: AXNode, budget: number): string => {
      let out = "";
      const walk = (id: string) => {
        if (out.length > budget) return;
        const c = byId.get(id);
        if (!c) return;
        const r = c.role?.value ?? "";
        if (r === "StaticText") {
          out += (out ? " " : "") + clean(c.name?.value);
          return;
        }
        if (INTERACTIVE.has(r)) return;
        for (const k of c.childIds ?? []) walk(k);
      };
      for (const k of n.childIds ?? []) walk(k);
      return clean(out);
    };

    const visit = (id: string): TNode[] => {
      const n = byId.get(id);
      if (!n) return [];
      const rawRole = n.role?.value ?? "";
      const key: [string, number] | undefined = n.backendDOMNodeId != null ? [f.key, n.backendDOMNodeId] : undefined;
      const kids = () => (n.childIds ?? []).flatMap(visit);
      const transparent = (): TNode[] => {
        const children = kids();
        return children.length ? [{ role: rawRole || "generic", key, children }] : [];
      };

      if (n.ignored) return transparent();
      if (SKIP.has(rawRole)) return [];
      if (rawRole === "StaticText") {
        if (!full) return [];
        const t = clean(n.name?.value);
        if (!t) return [];
        return [{ role: "text", line: { head: `- text ${quote(t)}`, tail: "", interactive: false }, children: [] }];
      }

      const name = clean(n.name?.value);

      if ((rawRole === "Iframe" || rawRole === "IframePresentational") && n.backendDOMNodeId != null) {
        const cf = frameFor(f.key, n.backendDOMNodeId);
        const head = `- iframe${name ? " " + quote(name) : ""}`;
        const refKey: [string, number] | undefined = full ? key : undefined;
        return [{ role: "iframe", key, line: { head, tail: "", refKey, interactive: false }, children: cf ? renderFrame(cf) : [] }];
      }

      const interactive = isInteractiveNode(n, rawRole, name);
      const heading = rawRole === "heading";
      const landmark = LANDMARKS.has(rawRole) || (NAMED_LANDMARKS.has(rawRole) && !!name);
      const show = interactive || heading || landmark || (full && (STRUCT.has(rawRole) && (!FULL_NAMED_ONLY.has(rawRole) || !!name)));
      if (!show) return transparent();

      const role = ROLE_ALIAS[rawRole] ?? rawRole;
      let head = `- ${role}`;
      let label = name;
      let consumedText = false;
      if (!label && TEXTUAL.has(rawRole) && (full || heading)) {
        label = textOf(n, full ? 4000 : 200);
        consumedText = true;
      }
      if (label) {
        const max = full ? 4000 : interactive || heading ? 200 : 100;
        head += " " + quote(label.length > max ? label.slice(0, max) + "…" : label);
        if (name && !consumedText) consumedText = NAME_COVERS_TEXT.has(rawRole);
      }
      const refKey = key && (interactive || (full && REF_STRUCT.has(rawRole))) ? key : undefined;

      let tail = "";
      const v = n.value?.value;
      if (VALUE_ROLES.has(rawRole) || rawRole === "textbox" || rawRole === "searchbox") {
        const sv = v === undefined || v === null ? "" : String(v);
        const masked = (n.backendDOMNodeId != null && sensitive.has(n.backendDOMNodeId)) || /^[•●*]{2,}$/.test(sv);
        if (masked && sv !== "") tail += ` value="${MASK}"`;
        else if (sv !== "") tail += ` value=${quote(sv.length > 80 ? sv.slice(0, 80) + "…" : sv)}`;
        else if (rawRole === "textbox" || rawRole === "searchbox") tail += ` value=""`;
      }
      for (const p of ["checked", "pressed", "expanded", "selected"]) {
        const pv = prop(n, p);
        if (pv !== undefined && pv !== "false" && pv !== false) tail += ` ${p}=${pv === "true" || pv === true ? "true" : pv}`;
        else if (p === "checked" && (rawRole === "checkbox" || rawRole === "radio" || rawRole === "switch")) tail += ` checked=false`;
      }
      if (heading) {
        const lvl = prop(n, "level");
        if (lvl) tail += ` level=${lvl}`;
      }
      if (prop(n, "disabled") === true) tail += " disabled";
      if (prop(n, "required") === true) tail += " required";
      if (prop(n, "readonly") === true) tail += " readonly";
      const inv = prop(n, "invalid");
      if (inv && inv !== "false") tail += " invalid";

      let children: TNode[] = heading && !full ? [] : kids();
      if (consumedText || interactive) children = dropText(children);
      if (!full && (rawRole === "combobox" || rawRole === "PopUpButton" || rawRole === "ComboBoxSelect") && prop(n, "expanded") !== true) children = [];
      // date/time fields: their spin-button parts are noise; the field takes the value
      if (["Date", "DateTime", "InputTime"].includes(rawRole)) children = [];
      // empty landmarks carry no information in interactive mode
      if (!full && landmark && !interactive && !children.some(hasOutput)) return [];
      return [{ role, key, line: { head, tail, refKey, interactive }, children }];
    };

    if (startNodeId) return visit(startNodeId);
    const root = f.nodes.find((n) => !n.parentId) ?? f.nodes[0];
    if (!root) return [];
    if (root.role?.value === "RootWebArea" || root.role?.value === "WebArea") return (root.childIds ?? []).flatMap(visit);
    return visit(root.nodeId);
  };

  if (opts.root) {
    const f = frames.find((x) => x.key === opts.root!.frameKey);
    const n = f?.nodes.find((x) => x.backendDOMNodeId === opts.root!.backendNodeId);
    if (!f || !n) throw taErr("REF_STALE", "The root ref is no longer in the page", "Take a new page.snapshot and use a fresh ref for root.");
    const out = renderFrame(f, n.nodeId);
    // A transparent root (e.g. a list in interactive mode) still renders its contents.
    return out;
  }
  const main = frames[0];
  if (!main) return [];
  return renderFrame(main);
}

// ---------------------------------------------------------------------------
// Layout: budget
// ---------------------------------------------------------------------------
interface OutLine {
  depth: number;
  head: string;
  tail: string;
  refKey?: [string, number];
  interactive: boolean;
}

function hasOutput(n: TNode): boolean {
  return !!n.line || n.children.some(hasOutput);
}

function layout(roots: TNode[]): OutLine[] {
  const out: OutLine[] = [];
  const emit = (n: TNode, depth: number) => {
    let d = depth;
    if (n.line) {
      out.push({ depth, head: n.line.head, tail: n.line.tail, refKey: n.line.refKey, interactive: n.line.interactive });
      d = depth + 1;
    }
    for (const c of n.children) emit(c, d);
  };
  for (const r of roots) emit(r, 0);
  return out;
}

export function render(input: AXNode[] | FrameTree[], opts: RenderOpts): RenderResult {
  const frames: FrameTree[] = input.length && "nodes" in (input[0] as object) ? (input as FrameTree[]) : [{ key: "|main", nodes: input as AXNode[] }];
  const mode = opts.mode ?? "interactive";
  const budget = (opts.maxTokens ?? DEFAULT_MAX_TOKENS) * 4;
  const roots = build(frames, { mode, root: opts.root });

  // Upper bound for a new ref's length, so estimates never undershoot.
  let nodeCount = 0;
  const count = (n: TNode) => {
    nodeCount++;
    n.children.forEach(count);
  };
  roots.forEach(count);
  const newRefLen = `e${opts.refs.nextNumber() + nodeCount + 1}`.length;
  const refLen = (k: [string, number]) => (opts.refs.peek(k[0], k[1]) ?? "e".padEnd(newRefLen, "9")).length;
  const lineLen = (l: OutLine) => 2 * l.depth + 1 + l.head.length + l.tail.length + (l.refKey ? 7 + refLen(l.refKey) : 0);
  const total = (ls: OutLine[]) => ls.reduce((a, l) => a + lineLen(l), 0);

  let lines = layout(roots);
  let truncated = false;
  let omitted = 0;
  if (total(lines) > budget) {
    // Hard stop: keep lines while they fit, leaving room for the note.
    const noteFor = (n: number) => `- … truncated, ${n} more nodes; narrow with root=<ref>`;
    let used = 0;
    let keep = 0;
    const reserve = noteFor(lines.length).length + 1;
    while (keep < lines.length && used + lineLen(lines[keep]) + reserve <= budget) used += lineLen(lines[keep++]);
    omitted = lines.length - keep;
    lines = lines.slice(0, keep);
    lines.push({ depth: 0, head: noteFor(omitted), tail: "", interactive: false });
    truncated = true;
  }

  // Mint refs only for what is shown, in document order.
  const refs: string[] = [];
  const shown: ShownRef[] = [];
  const text: string[] = [];
  for (const l of lines) {
    const ind = "  ".repeat(l.depth);
    let s = ind + l.head;
    if (l.refKey) {
      const ref = opts.refs.mint(l.refKey[0], l.refKey[1]);
      refs.push(ref);
      shown.push({ ref, frameKey: l.refKey[0], backendNodeId: l.refKey[1], interactive: l.interactive });
      s += ` [ref=${ref}]`;
    }
    text.push(s + l.tail);
  }
  const joined = text.join("\n");
  return { text: joined, lines: text, refs, shown, truncated, omitted, tokens: tokensOf(joined) };
}
