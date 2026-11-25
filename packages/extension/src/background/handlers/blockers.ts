// form.blockers and the blocker hints on act.click / form.submit (nolanmak/tabagent#64).
// A disabled or ignored submit says which fields block it, so the agent fixes the field
// instead of giving up.
import { TabAgentError } from "@tabagent/protocol";
import { onTab, type Ctx, type TabCtx } from "./ctx";

export interface Blocker {
  ref: string;
  label: string | null;
  group?: string;
  kind: string;
  message: string;
}

export interface BlockersReport {
  form: { ref: string; label: string | null } | null;
  submit: { ref: string; label: string; disabled: boolean; hidden?: string } | null;
  blockers: Blocker[];
  more?: number;
}

/** Blockers shown inline in an error message or an action result. */
const INLINE = 5;
const IN_RESULT = 10;

export async function readBlockers(t: TabCtx, ref?: string): Promise<BlockersReport | null> {
  try {
    const r = (await t.drv.call("formBlockers", [], ref ? { ref } : {})) as BlockersReport | null;
    return r && Array.isArray(r.blockers) ? r : null;
  } catch {
    return null;
  }
}

/** `e3 "Are you a government entity?" (unselected), e5 "I agree…" (unchecked), and 2 more` */
export function blockerList(r: BlockersReport, max = INLINE): string {
  const shown = r.blockers.slice(0, max).map((b) => `${b.ref} "${b.group ?? b.label ?? "(no label)"}" (${b.kind})`);
  const rest = r.blockers.length - shown.length + (r.more ?? 0);
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
}

const FIX_HINT = "Fix these fields (form.blockers lists every one with its message), then submit again.";
const NONE_FOUND = "The page reports no empty or invalid field; it may be waiting on something TabAgent cannot see (a CAPTCHA, an upload, an earlier step). Take a page.screenshot.";

/** The sentence an error appends: what the form still needs. */
export function needsText(r: BlockersReport): string {
  return r.blockers.length ? `The form still needs: ${blockerList(r)}.` : NONE_FOUND;
}

/** act.click hit a disabled submit-like button: name the blockers in the NOT_ACTIONABLE error. */
export async function disabledSubmitError(t: TabCtx, ref: string, e: unknown): Promise<unknown> {
  if (!(e instanceof TabAgentError) || e.code !== "NOT_ACTIONABLE" || !/reason: disabled/.test(e.message)) return e;
  const r = await readBlockers(t, ref);
  if (!r) return e;
  return new TabAgentError("NOT_ACTIONABLE", `${e.message}: submit disabled. ${needsText(r)}`, r.blockers.length ? FIX_HINT : e.hint, { pageText: true });
}

/**
 * After a submit that neither navigated nor visibly changed the page: if the form still has
 * blockers, the page most likely refused the submit, so return them with the result.
 */
export async function blockersAfterSubmit<T>(c: Ctx, result: T, ref?: string): Promise<T> {
  const side = (result as { __side?: Record<string, unknown> } | undefined)?.__side;
  if (side?.navigation || side?.dialogs || side?.snapshotDiff) return result;
  const r = await onTab(c, "read", (t) => readBlockers(t, ref)).catch(() => null);
  if (!r?.blockers.length) return result;
  return { ...(result as object), blockers: r.blockers.slice(0, IN_RESULT), hint: `Nothing changed and the form still has ${r.blockers.length + (r.more ?? 0)} blocker(s). ${FIX_HINT}` } as T;
}
