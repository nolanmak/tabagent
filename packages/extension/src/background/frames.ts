// #19 frame maths (pure).
//
// A point measured in a frame's own viewport (getBoundingClientRect inside the
// frame) maps to the top-level viewport by adding, for every ancestor <iframe>,
// the position of that iframe's content box within its parent's viewport.
// Scrolling is already folded into getBoundingClientRect at each level, so a
// scrolled parent just yields a smaller (possibly negative) owner rect.

export interface OwnerMetrics {
  /** iframe element's getBoundingClientRect() in its parent frame's viewport. */
  rect: { left: number; top: number };
  /** iframe.clientLeft/clientTop (border widths). */
  clientLeft: number;
  clientTop: number;
  paddingLeft: number;
  paddingTop: number;
  /** CSS scale applied to the iframe (transform), default 1. */
  scale?: number;
}

export interface Offset {
  x: number;
  y: number;
  scale: number;
}

/** Where a frame's viewport origin sits inside its parent frame's viewport. */
export function contentOffset(m: OwnerMetrics): Offset {
  const scale = m.scale ?? 1;
  return { x: m.rect.left + (m.clientLeft + m.paddingLeft) * scale, y: m.rect.top + (m.clientTop + m.paddingTop) * scale, scale };
}

/** Compose offsets ordered innermost frame first. */
export function translate(pt: { x: number; y: number }, chain: Offset[]): { x: number; y: number } {
  let { x, y } = pt;
  for (const o of chain) {
    x = o.x + x * o.scale;
    y = o.y + y * o.scale;
  }
  return { x, y };
}

export function translateBox(b: { x: number; y: number; w: number; h: number }, chain: Offset[]) {
  const p = translate({ x: b.x, y: b.y }, chain);
  const s = chain.reduce((a, o) => a * o.scale, 1);
  return { x: p.x, y: p.y, w: b.w * s, h: b.h * s };
}

export interface FrameNode {
  key: string;
  parentKey?: string;
}

/** Chain of frame keys from `key` up to (excluding) the top frame. */
export function ancestry(frames: FrameNode[], key: string): string[] {
  const byKey = new Map(frames.map((f) => [f.key, f]));
  const out: string[] = [];
  let cur = byKey.get(key);
  const seen = new Set<string>();
  while (cur && cur.parentKey && !seen.has(cur.key)) {
    seen.add(cur.key);
    out.push(cur.key);
    cur = byKey.get(cur.parentKey);
  }
  return out;
}

/** `${sessionId ?? ""}|${frameId}` */
export function frameKey(sessionId: string | undefined, frameId: string) {
  return `${sessionId ?? ""}|${frameId}`;
}

export function splitKey(key: string): [string | undefined, string] {
  const i = key.indexOf("|");
  const sid = key.slice(0, i);
  return [sid || undefined, key.slice(i + 1)];
}
