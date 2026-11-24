// Sensitive-action detection (D18 a/b, #13). Pure functions over plain descriptors.
// Best-effort English heuristics; false positives are handled by per-origin
// pre-approval, not by weakening the lists.

export const MASK = "••••";

export interface FieldLike {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  label?: string | null;
}

export type SensitiveCategory = "a" | "b";
export interface Detection {
  category: SensitiveCategory;
  reason: string;
}

const CARD = /\bcard\s*(number|no\.?|#)|\bcard\s*num|\bcc[-_\s]?(num|number)\b|\bcardnumber\b|\bcredit\s*card\b|\bdebit\s*card\b/i;
const CVC = /\b(cvc|cvv|cvv2|cvc2|csc|cid)\b|security\s*code|card\s*verification/i;
const SSN = /\bssn\b|social\s*security|\bsocial[-_]?sec/i;

/** Squash camelCase/snake/kebab identifiers so "cardNumber"/"card_number" read as words. */
function words(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ");
}

/** Reason the field is sensitive, or null. */
export function fieldSensitivity(f: FieldLike): string | null {
  const type = (f.type ?? "").toLowerCase();
  const ac = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (type === "password") return "password field";
  if (ac.includes("current-password") || ac.includes("new-password")) return "password field";
  if (ac.some((t) => t.startsWith("cc-"))) return "payment card field";
  const hay = [f.name, f.id, f.label].map(words).join(" ");
  const raw = [f.name, f.id].filter(Boolean).join(" ");
  if (CARD.test(hay) || /\b(card_?number|ccnum|cardnum)/i.test(raw)) return "payment card field";
  if (CVC.test(hay)) return "payment card field";
  if (SSN.test(hay)) return "SSN field";
  return null;
}

export function isSensitiveField(f: FieldLike): boolean {
  return fieldSensitivity(f) !== null;
}

/** Distinct reasons for a form's fields, in first-seen order. */
export function formSensitivity(fields: FieldLike[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const r = fieldSensitivity(f);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

export function maskValue(f: FieldLike, value: string): string {
  return value && isSensitiveField(f) ? MASK : value;
}

// "Resend code" is positive by design (it sends something), hence (re)?send.
const KEYWORDS = /\b(buy|purchase|pay|place\s+order|check\s?out|delete|remove\s+account|(?:re)?send|transfer|wire|confirm\s+payment)\b/i;
const CLICKABLE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch"]);

/** D18(b): keyword match on a clickable element's accessible name. */
export function clickSensitivity(el: { role?: string | null; name?: string | null }): Detection[] {
  const role = (el.role ?? "").toLowerCase();
  const name = (el.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || !CLICKABLE.has(role)) return [];
  if (!KEYWORDS.test(name)) return [];
  return [{ category: "b", reason: `"${name.slice(0, 60)}" matches a purchase/delete/send/transfer action` }];
}

export interface ClickTarget {
  role?: string | null;
  name?: string | null;
  /** The element submits its form when clicked (submit button / image input). */
  isSubmit?: boolean;
  /** Fields of the form it submits. */
  formFields?: FieldLike[];
}

/** All gates a click reaches: (a) submitting a sensitive form, (b) keyword. */
export function submitSensitivity(t: ClickTarget): Detection[] {
  const out: Detection[] = [];
  if (t.isSubmit && t.formFields) for (const r of formSensitivity(t.formFields)) out.push({ category: "a", reason: `submits a form with a ${r}` });
  out.push(...clickSensitivity(t));
  return out;
}

/**
 * Does pressing this chord send Enter? Resolved the way the driver resolves it (review H3):
 * aliases (Return), any modifiers, any case, and a raw CR or LF key.
 */
export function submitsOnKey(chord: string): boolean {
  if (chord === "\r" || chord === "\n") return true;
  let key = chord.trim();
  if (key !== "+") {
    const parts = key.split("+");
    key = parts.pop() || (parts.length ? "+" : "");
  }
  return /^(enter|return|numpadenter)$/i.test(key);
}

/** act.type presses a real Enter for every newline in its text (review H3). */
export function textSubmits(text: string): boolean {
  return /[\r\n]/.test(text);
}

/** D18(a) via the keyboard: Enter in a single-line control inside a sensitive form. */
export function keySensitivity(key: string, ctx: { inForm: boolean; formFields?: FieldLike[]; textarea?: boolean }): Detection[] {
  if (!submitsOnKey(key)) return [];
  if (!ctx.inForm || ctx.textarea || !ctx.formFields) return [];
  return formSensitivity(ctx.formFields).map((r) => ({ category: "a" as const, reason: `Enter submits a form with a ${r}` }));
}

/** Confirmation content for a submit: control name plus field labels, sensitive values masked. */
export function submitConfirmation(o: { control?: string | null; fields: (FieldLike & { value?: string | null })[] }): { summary: string; reasons: string[] } {
  const summary = `submit "${(o.control || "form").slice(0, 60)}"`;
  const lines = o.fields
    .filter((f) => f.label || f.name)
    .slice(0, 20)
    .map((f) => {
      const v = String(f.value ?? "");
      const shown = maskValue(f, v);
      return `${f.label || f.name}: ${shown.length > 40 ? shown.slice(0, 40) + "…" : shown}`;
    });
  return { summary, reasons: lines.length ? [`Fields: ${lines.join("; ")}`] : [] };
}
