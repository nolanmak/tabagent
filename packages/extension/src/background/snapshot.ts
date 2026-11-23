// Render CDP accessibility trees into compact, ref-annotated text.

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

export interface RNode {
  line: string;
  role: string;
  children: RNode[];
}

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider",
  "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "MenuListOption", "PopUpButton", "textField",
]);
const STRUCT = new Set([
  "heading", "main", "navigation", "banner", "contentinfo", "complementary", "form", "search", "dialog", "alertdialog",
  "alert", "status", "table", "row", "cell", "columnheader", "rowheader", "gridcell", "list", "listitem", "image", "img",
  "article", "tablist", "tabpanel", "menu", "menubar", "toolbar", "tree", "grid", "paragraph", "Iframe", "blockquote",
  "figure", "term", "definition", "DescriptionList", "progressbar", "meter", "log", "marquee", "timer", "note", "code",
]);
const NAMED_ONLY = new Set(["region", "group", "figure", "section", "image", "img", "radiogroup"]);
const REF_STRUCT = new Set(["form", "table", "grid", "dialog", "alertdialog", "list", "tabpanel", "Iframe", "region", "group", "radiogroup", "listbox", "menu"]);
const TEXT_ROLES = new Set(["StaticText", "InlineTextBox"]);
const ROLE_ALIAS: Record<string, string> = { MenuListOption: "option", PopUpButton: "combobox", image: "img", Iframe: "iframe", textField: "textbox", DescriptionList: "list" };

export interface FrameTree {
  key: string;
  nodes: AXNode[];
  ownerBackendNodeId?: number; // iframe element in parent frame
}

export interface RenderOpts {
  mode: "interactive" | "full";
  /** Assign/lookup a ref for a node. */
  refFor: (frameKey: string, backendNodeId: number) => string;
  /** If set, only render the subtree rooted at this node. */
  root?: { frameKey: string; backendNodeId: number };
}

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}

function q(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n+/g, " ")}"`;
}

export function renderFrames(frames: FrameTree[], opts: RenderOpts): RNode[] {
  const byKey = new Map(frames.map((f) => [f.key, f]));
  // child frames indexed by (parentKey, ownerBackendNodeId)
  const childFrame = new Map<string, FrameTree>();
  for (const f of frames) if (f.ownerBackendNodeId != null) childFrame.set(`${f.ownerBackendNodeId}`, f);

  const renderFrame = (f: FrameTree, startId?: string): RNode[] => {
    const byId = new Map(f.nodes.map((n) => [n.nodeId, n]));
    const root = startId ? byId.get(startId) : f.nodes.find((n) => !n.parentId) ?? f.nodes[0];
    if (!root) return [];

    const textOf = (n: AXNode, budget: number): string => {
      // aggregate descendant StaticText
      let out = "";
      const walk = (id: string) => {
        if (out.length > budget) return;
        const c = byId.get(id);
        if (!c) return;
        const r = c.role?.value ?? "";
        if (r === "StaticText") {
          out += (out ? " " : "") + String(c.name?.value ?? "").trim();
          return;
        }
        if (INTERACTIVE.has(r)) return; // rendered separately
        for (const k of c.childIds ?? []) walk(k);
      };
      for (const k of n.childIds ?? []) walk(k);
      return out.replace(/\s+/g, " ").trim();
    };

    const visit = (id: string): RNode[] => {
      const n = byId.get(id);
      if (!n) return [];
      const rawRole = n.role?.value ?? "";
      const kids = (): RNode[] => (n.childIds ?? []).flatMap(visit);

      if (n.ignored) return kids();
      if (rawRole === "InlineTextBox" || rawRole === "LineBreak" || rawRole === "ListMarker") return [];
      if (rawRole === "StaticText") {
        const t = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
        if (!t) return [];
        if (opts.mode === "interactive" && t.length < 2) return [];
        const shown = opts.mode === "full" ? t : t.length > 80 ? t.slice(0, 80) + "…" : t;
        return [{ line: `- text ${q(shown)}`, role: "text", children: [] }];
      }

      // iframe: splice in the child frame's tree
      if ((rawRole === "Iframe" || rawRole === "IframePresentational") && n.backendDOMNodeId != null) {
        const cf = childFrame.get(`${n.backendDOMNodeId}`);
        const ref = opts.refFor(f.key, n.backendDOMNodeId);
        const name = String(n.name?.value ?? "");
        const line = `- iframe${name ? " " + q(name) : ""} [ref=${ref}]`;
        return [{ line, role: "iframe", children: cf ? renderFrame(cf) : [] }];
      }

      const isInteractive = INTERACTIVE.has(rawRole) || (prop(n, "focusable") === true && !!n.name?.value && !["RootWebArea", "WebArea", "generic", "paragraph", "StaticText"].includes(rawRole) && !STRUCT.has(rawRole));
      const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
      const keepStruct = STRUCT.has(rawRole) || (NAMED_ONLY.has(rawRole) && !!name);
      if (!isInteractive && !keepStruct) return kids();
      if (rawRole === "paragraph" || rawRole === "listitem" || rawRole === "cell" || rawRole === "gridcell" || rawRole === "term" || rawRole === "definition" || rawRole === "blockquote" || rawRole === "code") {
        // fall through with aggregated text
      }

      const role = ROLE_ALIAS[rawRole] ?? rawRole;
      let line = `- ${role}`;
      let label = name;
      let consumedText = false;
      if (!label && ["paragraph", "listitem", "cell", "gridcell", "columnheader", "rowheader", "term", "definition", "blockquote", "code", "heading", "status", "alert", "log", "note"].includes(rawRole)) {
        label = textOf(n, opts.mode === "full" ? 4000 : 200);
        consumedText = true;
      }
      if (label) {
        const shown = opts.mode === "full" || isInteractive || rawRole === "heading" ? label : label.length > 100 ? label.slice(0, 100) + "…" : label;
        line += " " + q(shown.length > 300 && opts.mode !== "full" ? shown.slice(0, 300) + "…" : shown);
        if (name && !consumedText) consumedText = ["link", "button", "heading", "option", "tab", "menuitem", "cell", "columnheader", "rowheader", "listitem", "MenuListOption", "checkbox", "radio", "switch"].includes(rawRole);
      }
      if (n.backendDOMNodeId != null && (isInteractive || REF_STRUCT.has(rawRole))) line += ` [ref=${opts.refFor(f.key, n.backendDOMNodeId)}]`;
      const v = n.value?.value;
      if (v !== undefined && v !== "" && ["textbox", "searchbox", "combobox", "slider", "spinbutton", "textField", "PopUpButton"].includes(rawRole)) {
        const sv = String(v);
        line += ` value=${q(sv.length > 80 ? sv.slice(0, 80) + "…" : sv)}`;
      } else if (["textbox", "searchbox"].includes(rawRole)) line += ` value=""`;
      for (const p of ["checked", "pressed", "expanded", "selected"]) {
        const pv = prop(n, p);
        if (pv !== undefined && pv !== "false" && pv !== false) line += ` ${p}=${pv === "true" ? "true" : pv}`;
        else if (p === "checked" && (rawRole === "checkbox" || rawRole === "radio" || rawRole === "switch")) line += ` checked=false`;
      }
      if (rawRole === "heading") {
        const lvl = prop(n, "level");
        if (lvl) line += ` level=${lvl}`;
      }
      if (prop(n, "disabled") === true) line += " disabled";
      if (prop(n, "required") === true) line += " required";
      if (prop(n, "readonly") === true) line += " readonly";
      if (prop(n, "focused") === true) line += " focused";
      if (prop(n, "invalid") && prop(n, "invalid") !== "false") line += " invalid";

      let children = kids();
      if (consumedText || isInteractive) children = children.filter((c) => c.role !== "text");
      // options inside a native select are noise in interactive mode unless expanded
      if (opts.mode === "interactive" && (rawRole === "combobox" || rawRole === "PopUpButton") && prop(n, "expanded") !== true) children = children.filter((c) => c.role !== "option" && c.role !== "MenuListPopup");
      return [{ line, role, children }];
    };

    if (startId) return visit(startId);
    const top = root.role?.value === "RootWebArea" ? (root.childIds ?? []).flatMap(visit) : visit(root.nodeId);
    return top;
  };

  if (opts.root) {
    const f = byKey.get(opts.root.frameKey);
    if (!f) return [];
    const n = f.nodes.find((x) => x.backendDOMNodeId === opts.root!.backendNodeId);
    if (!n) return [];
    return renderFrame(f, n.nodeId);
  }
  const main = frames[0];
  return main ? renderFrame(main) : [];
}

/** Serialize with optional list collapsing. */
export function serialize(nodes: RNode[], collapseOver = Infinity): string[] {
  const lines: string[] = [];
  const emit = (ns: RNode[], depth: number) => {
    let i = 0;
    while (i < ns.length) {
      const n = ns[i];
      // run of same-role siblings
      let j = i;
      while (j < ns.length && ns[j].role === n.role) j++;
      const run = j - i;
      const keep = run > collapseOver ? Math.max(3, Math.floor(collapseOver * 0.6)) : run;
      for (let k = i; k < i + keep; k++) {
        lines.push("  ".repeat(depth) + ns[k].line);
        emit(ns[k].children, depth + 1);
      }
      if (keep < run) lines.push("  ".repeat(depth) + `- … ${run - keep} more ${n.role} items (use root=<ref> or page.find to see them)`);
      i = j;
    }
  };
  emit(nodes, 0);
  return lines;
}

export function renderWithBudget(nodes: RNode[], maxTokens: number): { text: string; truncated: boolean } {
  const budgetChars = maxTokens * 4;
  let lines = serialize(nodes);
  let text = lines.join("\n");
  if (text.length <= budgetChars) return { text, truncated: false };
  for (const c of [20, 10, 5, 3]) {
    lines = serialize(nodes, c);
    text = lines.join("\n");
    if (text.length <= budgetChars) return { text, truncated: true };
  }
  const cut = text.slice(0, budgetChars);
  return { text: cut.slice(0, cut.lastIndexOf("\n")) + "\n- … [truncated to maxTokens; use root=<ref>, page.find, or a larger maxTokens]", truncated: true };
}

/** Line diff (LCS). Returns +/- lines; caps output. */
export function diffLines(a: string[], b: string[], cap = 60): { text: string; added: number; removed: number } {
  const n = a.length;
  const m = b.length;
  let out: string[] = [];
  let added = 0;
  let removed = 0;
  if (n * m > 4_000_000) {
    const sa = new Set(a);
    const sb = new Set(b);
    for (const l of a) if (!sb.has(l)) (out.push("- " + l.trim()), removed++);
    for (const l of b) if (!sa.has(l)) (out.push("+ " + l.trim()), added++);
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        out.push("- " + a[i].trim());
        removed++;
        i++;
      } else {
        out.push("+ " + b[j].trim());
        added++;
        j++;
      }
    }
  }
  if (out.length > cap) out = [...out.slice(0, cap), `… ${out.length - cap} more changed lines (take a page.snapshot)`];
  return { text: out.join("\n"), added, removed };
}
