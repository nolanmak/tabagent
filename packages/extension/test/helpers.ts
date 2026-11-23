import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryStore, RefTable } from "../src/background/refs";
import type { AXNode, RefSource } from "../src/background/snapshot";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "fixtures/ax");
export const GOLDENS = join(here, "goldens");
export const HTML = join(here, "../../../e2e/fixtures");

export interface AxFixture {
  page: string;
  nodes: AXNode[];
  sensitive: number[];
}

export function loadAx(name: string): AxFixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

export const M1_PAGES = ["index", "form", "table", "article", "modal", "checkout", "custom-select", "drag", "masked", "delay", "shadow"];

/** A RefSource over a fresh RefTable for one tab + document. */
export function source(table = new RefTable(memoryStore()), tabId = 1, loaderId = "L1"): RefSource & { table: RefTable } {
  return {
    table,
    peek: (frameKey, backendNodeId) => table.peek({ tabId, frameKey, backendNodeId, loaderId }),
    mint: (frameKey, backendNodeId) => table.mint({ tabId, frameKey, backendNodeId, loaderId }),
    nextNumber: () => table.peekNext(),
  };
}

let nid = 0;
/** Build AX nodes from a compact spec: [role, name?, children?, extra?]. */
export type Spec = [string, string?, Spec[]?, Partial<AXNode>?];
export function ax(spec: Spec, parent?: string, out: AXNode[] = []): AXNode[] {
  const [role, name, kids, extra] = spec;
  const id = String(++nid);
  const n: AXNode = { nodeId: id, role: { value: role }, ...(name ? { name: { value: name } } : {}), backendDOMNodeId: 10_000 + nid, ...(parent ? { parentId: parent } : {}), ...(extra ?? {}) };
  out.push(n);
  n.childIds = [];
  for (const k of kids ?? []) {
    const before = out.length;
    ax(k, id, out);
    n.childIds.push(out[before].nodeId);
  }
  return out;
}

export function list(n: number, item: (i: number) => Spec): Spec {
  return ["list", "Items", Array.from({ length: n }, (_, i) => item(i + 1))];
}
