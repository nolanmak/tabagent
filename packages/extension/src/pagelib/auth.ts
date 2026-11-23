// pagelib side of M6 auth (#33-#35). Runs in the isolated world like the rest of pagelib.
// Never reads a password or code value: descriptors carry type/autocomplete/labels/visibility only,
// and the chrome-autofill check uses the :autofill pseudo-class, not the value.
// The username shown in prompts is masked here, so the plain username never leaves the page either.

type El = Element;
export interface Ret<T = unknown> {
  value: T;
  elements: El[];
}

/** Fields TabAgent filled with a secret (and one-time-code fields): masked everywhere (DA2). */
const filled = new WeakSet<El>();

function visible(el: El): boolean {
  const h = el as HTMLElement;
  if (!h.isConnected) return false;
  const st = getComputedStyle(h);
  if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse" || Number(st.opacity) === 0) return false;
  const r = h.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

function labelOf(el: El): string {
  const h = el as HTMLInputElement;
  const parts: string[] = [];
  const al = h.getAttribute("aria-label");
  if (al) parts.push(al);
  const lb = h.getAttribute("aria-labelledby");
  if (lb) for (const id of lb.split(/\s+/)) parts.push(document.getElementById(id)?.textContent ?? "");
  for (const l of Array.from(h.labels ?? [])) parts.push(l.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function* allFields(root: Document | ShadowRoot | El): Generator<El> {
  const stack: (Document | ShadowRoot | El)[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const kids = Array.from((n as ParentNode).children ?? []);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (n instanceof Element) {
      if (n.shadowRoot) stack.push(n.shadowRoot);
      if (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT") yield n;
    }
  }
}

const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file", "range", "color"]);

export interface AuthFieldDesc {
  el: number;
  i: number;
  tag: "input" | "textarea" | "select";
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  form: number;
  maxLength: number;
  inputMode: string;
  autofilled: boolean;
}

function isAutofilled(el: El): boolean {
  try {
    return el.matches(":autofill");
  } catch {
    try {
      return el.matches(":-webkit-autofill");
    } catch {
      return false;
    }
  }
}

/** Descriptors for every form field in document order (open shadow roots included). */
export function authFields(): Ret<AuthFieldDesc[]> {
  const forms = Array.from(document.forms);
  const out: AuthFieldDesc[] = [];
  const elements: El[] = [];
  for (const el of allFields(document)) {
    const h = el as HTMLInputElement;
    const type = el.tagName === "INPUT" ? (h.getAttribute("type") ?? "text").toLowerCase() : "";
    if (SKIP_TYPES.has(type)) continue;
    const i = out.length;
    elements.push(el);
    out.push({
      el: i,
      i,
      tag: el.tagName.toLowerCase() as AuthFieldDesc["tag"],
      type: type === "text" ? "text" : type,
      autocomplete: (h.getAttribute("autocomplete") ?? "").toLowerCase().trim(),
      name: (h.getAttribute("name") ?? "").slice(0, 80),
      id: (h.id ?? "").slice(0, 80),
      label: labelOf(el),
      placeholder: (h.getAttribute("placeholder") ?? "").slice(0, 80),
      visible: visible(el),
      disabled: !!h.disabled,
      readOnly: !!h.readOnly,
      form: h.form ? forms.indexOf(h.form) : -1,
      maxLength: typeof h.maxLength === "number" && h.maxLength >= 0 ? h.maxLength : -1,
      inputMode: (h.getAttribute("inputmode") ?? "").toLowerCase(),
      autofilled: isAutofilled(el),
    });
  }
  return { value: out, elements };
}

/** Mask a field from now on (form.describe and anything else in pagelib consults isAuthMasked). */
export function authMark(self: El | null): boolean {
  if (!self) return false;
  filled.add(self);
  return true;
}

/** Hook for form.describe / snapshot value masking: TabAgent-filled fields and one-time-code fields. */
export function isAuthMasked(el: El): boolean {
  if (filled.has(el)) return true;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  return ac.includes("one-time-code");
}

function maskName(a: string): string {
  const s = a.trim();
  if (!s) return "•••";
  const at = s.lastIndexOf("@");
  const first = /^[\p{L}\p{N}_.+-]$/u.test([...s][0] ?? "") ? [...s][0] : "";
  if (at > 0) return `${first}•••@${s.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, "").slice(0, 253)}`;
  const chars = [...s];
  const last = chars.length > 2 && /^[\p{L}\p{N}_.+-]$/u.test(chars[chars.length - 1]) ? chars[chars.length - 1] : "";
  return `${first}•••${last}`;
}

/**
 * chrome-autofill (#32): Chrome's password manager pre-fills a saved credential on https pages.
 * Reports whether the visible login password field is in the :autofill state, plus the masked
 * username. The password value is never read.
 */
export function authAutofill(): { usernameMasked?: string } | null {
  const fields = authFields();
  const pw = fields.value.find((f) => f.type === "password" && f.visible && f.autofilled);
  if (!pw) return null;
  const before = fields.value.filter((f) => f.i < pw.i && f.visible && (f.type === "text" || f.type === "email" || f.type === "tel") && (pw.form === -1 || f.form === pw.form));
  const u = before[before.length - 1];
  const value = u ? ((fields.elements[u.i] as HTMLInputElement).value ?? "") : "";
  return { usernameMasked: value ? maskName(value) : undefined };
}

const CAPTCHA_SRC = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i;
const WEBAUTHN_TEXT = /use (your|a) passkey|security key|touch id|windows hello|face id|approve (the )?sign.?in (request )?on your (phone|device)|check your phone/i;

/** next classification signals: CAPTCHA frames and passkey / phone-approval prompts. */
export function authSignals(): { webauthn: boolean; captcha: boolean } {
  const frames = Array.from(document.querySelectorAll("iframe"));
  const captcha = frames.some((f) => CAPTCHA_SRC.test(f.getAttribute("src") ?? "")) || !!document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile");
  const text = (document.body?.innerText ?? "").slice(0, 5000);
  return { webauthn: WEBAUTHN_TEXT.test(text), captcha };
}

export const authApi = { authFields: (_self: El | null) => authFields(), authMark, authAutofill: (_self: El | null) => authAutofill(), authSignals: (_self: El | null) => authSignals(), isAuthMasked: (self: El | null) => (self ? isAuthMasked(self) : false) };
