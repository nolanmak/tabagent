// #8 screenshot planning (pure): clip rectangles, the 16,000 px cap, marks.

export const MAX_CAPTURE_HEIGHT = 16000;

export interface Metrics {
  /** CSS visual viewport: size and scroll position. */
  viewport: { w: number; h: number; pageX: number; pageY: number };
  /** Full document size (CSS px). */
  content: { w: number; h: number };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapturePlan {
  clip?: { x: number; y: number; width: number; height: number; scale: 1 };
  captureBeyondViewport: boolean;
  width: number;
  height: number;
  note?: string;
}

export type Target = "viewport" | "full" | "ref";

/** `box` is the element's box in top-level viewport coordinates (target=ref). */
export function planCapture(target: Target, m: Metrics, box?: Box): CapturePlan {
  if (target === "ref") {
    if (!box) throw new Error("planCapture(ref) needs a box");
    const w = Math.max(1, Math.round(box.w));
    let h = Math.max(1, Math.round(box.h));
    let note: string | undefined;
    if (h > MAX_CAPTURE_HEIGHT) {
      note = `Element is ${h}px tall; the image is capped at ${MAX_CAPTURE_HEIGHT}px.`;
      h = MAX_CAPTURE_HEIGHT;
    }
    return { clip: { x: box.x + m.viewport.pageX, y: box.y + m.viewport.pageY, width: w, height: h, scale: 1 }, captureBeyondViewport: true, width: w, height: h, ...(note ? { note } : {}) };
  }
  if (target === "full") {
    const w = Math.max(1, Math.ceil(m.content.w));
    const full = Math.max(1, Math.ceil(m.content.h));
    const h = Math.min(full, MAX_CAPTURE_HEIGHT);
    const note = full > MAX_CAPTURE_HEIGHT ? `Page is ${full}px tall; the image is capped at ${MAX_CAPTURE_HEIGHT}px. Scroll and take viewport screenshots for the rest.` : undefined;
    return { clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true, width: w, height: h, ...(note ? { note } : {}) };
  }
  return { captureBeyondViewport: false, width: Math.round(m.viewport.w), height: Math.round(m.viewport.h) };
}

export interface Mark {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Marks for refs whose boxes intersect the viewport (labels are the refs). */
export function marksInView(entries: { ref: string; box: Box | null }[], viewport: { w: number; h: number }, max = 300): Mark[] {
  const out: Mark[] = [];
  for (const e of entries) {
    const b = e.box;
    if (!b || b.w <= 0 || b.h <= 0) continue;
    if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= viewport.w || b.y >= viewport.h) continue;
    out.push({ label: e.ref, x: b.x, y: b.y, w: b.w, h: b.h });
    if (out.length >= max) break;
  }
  return out;
}
