// The chat page's session list (#156 rail, #159 compact picker). Below 860px the rail is hidden, so the header
// gets a button with the current session's title that opens the same list as a dropdown. Plain data in, plain
// data or escaped HTML out; ui/chat.ts wires it to the DOM.
import { groupAgents, vendorShown, type AgentRowView, type ConnectionTone } from "./agents";
import { esc } from "./html";
import { icon } from "./icons";

export interface SessionItem {
  id: string;
  title: string;
  /** "Claude · Connected · instant · 1m": vendor (unless the connection words name it), connection, age. */
  meta: string;
  tone: ConnectionTone;
  busy: boolean;
  current: boolean;
  /** This session's chat page, relative to chat.html. */
  href: string;
  cwd: string;
}

/** Every running session in the side panel's order (linked first, then newest; collapsed ones last). */
export function sessionItems(views: AgentRowView[], currentId: string): SessionItem[] {
  const { main, other } = groupAgents(views);
  return [...main, ...other].map((v) => ({
    id: v.id,
    title: v.title,
    meta: [...(vendorShown(v) ? [v.vendorLabel] : []), v.connection.label, v.age].join(" · "),
    tone: v.connection.tone,
    busy: v.busy,
    current: v.id === currentId,
    href: `chat.html?agent=${encodeURIComponent(v.id)}`,
    cwd: v.cwd,
  }));
}

export function statusDotHtml(tone: ConnectionTone, busy: boolean): string {
  return `<span class="status-dot tone-${tone}${busy ? " busy-dot" : ""}" aria-hidden="true"></span>`;
}

/** One session link: the rail and the picker share it. `attr` keys the link (focus restore, clicks). */
export function sessionLinkHtml(i: SessionItem, attr: string): string {
  return `<a href="${esc(i.href)}" ${attr}="${esc(i.id)}"${i.current ? ' aria-current="page"' : ""} title="${esc(i.cwd)}">${statusDotHtml(i.tone, i.busy)}<span class="rail-text"><span class="rail-title">${esc(i.title)}</span><span class="rail-meta">${esc(i.meta)}</span></span></a>`;
}

export interface PickerView {
  /** The button's text: the current session's title, else the page's own title ("Session not running"). */
  label: string;
  tone: ConnectionTone | null;
  busy: boolean;
  items: SessionItem[];
  /** Index of the current session in `items`, or -1. */
  currentIndex: number;
}

export function sessionPickerView(views: AgentRowView[], currentId: string, fallback: string): PickerView {
  const items = sessionItems(views, currentId);
  const currentIndex = items.findIndex((i) => i.current);
  const cur = items[currentIndex];
  return { label: cur?.title ?? fallback, tone: cur?.tone ?? null, busy: cur?.busy ?? false, items, currentIndex };
}

/** The button's inside: status dot, title, chevron. */
export function pickerButtonHtml(v: PickerView): string {
  const dot = v.tone ? statusDotHtml(v.tone, v.busy) : "";
  return `${dot}<span class="picker-title">${esc(v.label)}</span><span class="picker-chev" aria-hidden="true">${icon("chevronDown")}</span>`;
}

/** The dropdown's rows: links to each session's chat page, the current one marked. */
export function pickerListHtml(v: PickerView): string {
  return v.items.map((i) => `<li>${sessionLinkHtml(i, "data-picker-agent")}</li>`).join("") || `<li class="rail-empty">No sessions running.</li>`;
}

// ---------------------------------------------------------------------------
// Keyboard and open state
// ---------------------------------------------------------------------------

/** `active`: the focused row while open, -1 for none. */
export interface PickerState {
  open: boolean;
  active: number;
}

export const closedPicker: PickerState = { open: false, active: -1 };

export type PickerAction = { type: "toggle" } | { type: "close" } | { type: "key"; key: string; from: "button" | "list" };

/** `focus`: where the page should move focus after this action ("item" = the active row). */
export interface PickerResult {
  state: PickerState;
  handled: boolean;
  focus: "button" | "item" | null;
}

/**
 * The disclosure pattern: the button toggles; ↓/↑ on the button open it on the current session; in the list ↓/↑
 * wrap, Home/End jump, Enter follows the focused link (the browser's own), Esc closes back to the button and Tab
 * closes and moves on.
 */
export function pickerReducer(s: PickerState, a: PickerAction, ctx: { count: number; current: number }): PickerResult {
  const openAt = (fromEnd: boolean): PickerResult => {
    if (!ctx.count) return { state: { open: true, active: -1 }, handled: true, focus: null };
    const active = ctx.current >= 0 ? ctx.current : fromEnd ? ctx.count - 1 : 0;
    return { state: { open: true, active }, handled: true, focus: "item" };
  };
  const pass: PickerResult = { state: s, handled: false, focus: null };
  if (a.type === "close") return { state: closedPicker, handled: true, focus: null };
  if (a.type === "toggle") return s.open ? { state: closedPicker, handled: true, focus: "button" } : openAt(false);
  if (a.key === "Escape") return s.open ? { state: closedPicker, handled: true, focus: "button" } : pass;
  if (a.from === "button") {
    if (a.key !== "ArrowDown" && a.key !== "ArrowUp") return pass;
    if (s.open) return ctx.count ? { state: s, handled: true, focus: "item" } : pass;
    return openAt(a.key === "ArrowUp");
  }
  if (a.key === "Tab") return { state: closedPicker, handled: false, focus: null };
  if (!ctx.count) return pass;
  const n = ctx.count;
  const i = s.active < 0 ? 0 : s.active;
  const next: Record<string, number> = { ArrowDown: (i + 1) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 };
  if (!(a.key in next)) return pass;
  return { state: { open: true, active: next[a.key] }, handled: true, focus: "item" };
}
