// Keyboard focus across a list re-render (#159). The chat rail, the session picker and the side panel's agent
// rows rewrite their markup when an age ticks or a status changes; without this, a keyboard user's focus falls
// back to <body>. Rows are keyed by an attribute (the agent id), so focus goes back to the same agent.

/** Which keyed row had focus, and which control inside it (`part`: a data-* attribute name or a tag name). */
export interface FocusMark {
  key: string;
  part: string | null;
}

/** The row in `container` (by `attr`) that holds `active`, or null when focus is elsewhere. */
export function markFocus(container: Element, attr: string, active: Element | null): FocusMark | null {
  if (!active || !container.contains(active)) return null;
  const host = active.closest(`[${attr}]`);
  if (!host || !container.contains(host)) return null;
  const key = host.getAttribute(attr) ?? "";
  if (host === active) return { key, part: null };
  const data = active.getAttributeNames().find((n) => n.startsWith("data-") && n !== attr);
  return { key, part: data ?? active.tagName.toLowerCase() };
}

/** Focus the same row (or the same control in it) again. False when it is gone; focus is never stolen then. */
export function restoreFocus(container: Element, attr: string, mark: FocusMark | null): boolean {
  if (!mark) return false;
  const host = [...container.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === mark.key);
  if (!host) return false;
  const target = mark.part ? host.querySelector<HTMLElement>(mark.part.startsWith("data-") ? `[${mark.part}]` : mark.part) : (host as HTMLElement);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** Run `rewrite` (which replaces the container's markup) and put focus back where it was. */
export function keepFocus(container: Element, attr: string, rewrite: () => void): void {
  const mark = markFocus(container, attr, container.ownerDocument.activeElement);
  rewrite();
  restoreFocus(container, attr, mark);
}
