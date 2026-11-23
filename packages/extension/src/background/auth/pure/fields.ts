// Field descriptors (built by pagelib/auth.ts) and the pure detections over them:
// login form (#33), one-time-code destination (#34). Plain data in, plain data out.
// Descriptors never carry a field's value: only the facts needed to classify it.

export interface FieldDesc {
  /** Index into the descriptor list; the caller maps it to a ref. */
  i: number;
  tag: "input" | "textarea" | "select";
  /** Lower-cased input type ("" for textarea/select). */
  type: string;
  /** Lower-cased autocomplete tokens, space separated. */
  autocomplete: string;
  name: string;
  id: string;
  /** Accessible label (label element, aria-label, aria-labelledby). */
  label: string;
  placeholder: string;
  visible: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Index of the owning form among the page's forms, -1 for none. */
  form: number;
  /** -1 when not set. */
  maxLength: number;
  inputMode: string;
  /** Chrome filled this field from its password manager (`:autofill`). Value is never read. */
  autofilled?: boolean;
}

const TEXTLIKE = new Set(["", "text", "email", "tel", "username"]);
const USER_HINT = /user|e-?mail|login|account|phone|identifier|benutzer|usuario/i;
const SEARCH_HINT = /search|query|\bq\b|coupon|promo|newsletter|subscribe/i;
const CODE_HINT = /code|verif|otp|passcode|2fa|two.?factor|one.?time|token|\bpin\b|security/i;

function hay(f: FieldDesc) {
  return `${f.name} ${f.id} ${f.label} ${f.placeholder}`;
}
function usable(f: FieldDesc) {
  return f.visible && !f.disabled && !f.readOnly && f.tag === "input";
}
function ac(f: FieldDesc, token: string) {
  return f.autocomplete.split(/\s+/).includes(token);
}
function isOtp(f: FieldDesc) {
  return ac(f, "one-time-code");
}
function isPassword(f: FieldDesc) {
  return f.type === "password" && !isOtp(f);
}
function isUserish(f: FieldDesc) {
  if (!TEXTLIKE.has(f.type) || isOtp(f)) return false;
  if (SEARCH_HINT.test(hay(f)) && !ac(f, "username") && !ac(f, "email")) return false;
  return true;
}

export type LoginForm =
  | { ok: true; kind: "classic" | "username-only" | "password-only"; username?: number; password?: number; form: number }
  | { ok: false; signup?: boolean; reason: string };

/**
 * #33: a visible password field plus the nearest preceding text/email field in the same form.
 * Username-first steps (no password yet) and password-only steps are recognised so a second
 * auth.login call fills whichever is present. A form with two visible password fields, or one
 * marked autocomplete=new-password, is a sign-up / change-password form: not a login.
 */
export function detectLogin(fields: readonly FieldDesc[]): LoginForm {
  const vis = fields.filter(usable);
  const pw = vis.filter(isPassword);
  const byForm = new Map<number, FieldDesc[]>();
  for (const f of pw) byForm.set(f.form, [...(byForm.get(f.form) ?? []), f]);
  let sawSignup = false;
  for (const [form, pws] of byForm) {
    const signup = pws.length > 1 || pws.some((f) => ac(f, "new-password"));
    if (signup) {
      sawSignup = true;
      continue;
    }
    const p = pws[0];
    const before = vis.filter((f) => f.i < p.i && isUserish(f) && (form === -1 || f.form === form));
    const u = before.find((f) => ac(f, "username")) ?? before[before.length - 1];
    return u ? { ok: true, kind: "classic", username: u.i, password: p.i, form } : { ok: true, kind: "password-only", password: p.i, form };
  }
  if (sawSignup) return { ok: false, signup: true, reason: "The page has a sign-up or change-password form (two password fields or new-password), not a login form" };
  // Username-first step: one username-like field, explicitly marked or named so.
  const cands = vis.filter((f) => isUserish(f) && (ac(f, "username") || ac(f, "webauthn") || (USER_HINT.test(hay(f)) && !CODE_HINT.test(hay(f)))));
  const marked = cands.filter((f) => ac(f, "username"));
  const pick = marked.length === 1 ? marked[0] : cands.length === 1 ? cands[0] : null;
  if (pick) {
    const siblings = vis.filter((f) => f.form === pick.form && f.form !== -1 && TEXTLIKE.has(f.type) && f.i !== pick.i);
    if (pick.form === -1 || siblings.length === 0 || ac(pick, "username")) return { ok: true, kind: "username-only", username: pick.i, form: pick.form };
  }
  return { ok: false, reason: "No login form found on this page" };
}

export type CodeDest = { ok: true; split: false; field: number } | { ok: true; split: true; fields: number[] } | { ok: false; reason: string; count: number };

function splitGroup(cands: FieldDesc[]): number[] | null {
  // 4-8 one-character boxes in one form, in document order.
  const byForm = new Map<number, FieldDesc[]>();
  for (const f of cands) if (f.maxLength === 1) byForm.set(f.form, [...(byForm.get(f.form) ?? []), f]);
  const groups = [...byForm.values()].filter((g) => g.length >= 4 && g.length <= 8);
  return groups.length === 1 ? groups[0].sort((a, b) => a.i - b.i).map((f) => f.i) : null;
}

/**
 * #34 destination: the single visible autocomplete=one-time-code field, else the single visible
 * short numeric/text field whose label says code/verification; split inputs (six one-digit boxes)
 * come back as an ordered list to type digit by digit. Anything else is BAD_REQUEST for the caller.
 */
export function detectCodeField(fields: readonly FieldDesc[]): CodeDest {
  const vis = fields.filter((f) => usable(f) && (TEXTLIKE.has(f.type) || f.type === "number" || f.type === "password"));
  const otp = vis.filter(isOtp);
  if (otp.length === 1) {
    // one-time-code on the first of several boxes is common: treat the group as split
    const g = splitGroup(vis.filter((f) => f.form === otp[0].form && f.maxLength === 1));
    if (g && g.includes(otp[0].i) && otp[0].maxLength === 1) return { ok: true, split: true, fields: g };
    return { ok: true, split: false, field: otp[0].i };
  }
  if (otp.length > 1) {
    const g = splitGroup(otp);
    if (g && g.length === otp.length) return { ok: true, split: true, fields: g };
    return { ok: false, reason: `${otp.length} one-time-code fields on the page; pass ref`, count: otp.length };
  }
  const labelled = vis.filter((f) => f.type !== "password" && CODE_HINT.test(hay(f)) && !USER_HINT.test(`${f.name} ${f.id}`));
  const boxes = splitGroup(vis.filter((f) => f.type !== "password" && f.maxLength === 1));
  if (boxes && (labelled.length === 0 || labelled.every((f) => boxes.includes(f.i)))) return { ok: true, split: true, fields: boxes };
  const short = labelled.filter((f) => f.maxLength === -1 || (f.maxLength >= 4 && f.maxLength <= 10) || f.inputMode === "numeric" || f.type === "number" || f.type === "tel");
  if (short.length === 1) return { ok: true, split: false, field: short[0].i };
  if (short.length > 1) return { ok: false, reason: `${short.length} possible code fields; pass ref`, count: short.length };
  return { ok: false, reason: "No one-time-code field found on this page; pass ref", count: 0 };
}

/** One-time-code fields are masked in snapshots, diffs and form.describe (DA2). */
export function isOneTimeCodeAutocomplete(autocomplete: string | null | undefined): boolean {
  return !!autocomplete && autocomplete.toLowerCase().split(/\s+/).includes("one-time-code");
}
