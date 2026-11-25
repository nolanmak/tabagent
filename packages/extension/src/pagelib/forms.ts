// pagelib forms (#9, #13): field descriptors, form identification, gate inputs.
// Decisions (matching, coercion, sensitivity) live in ../pure; this file only reads the DOM.
import { formSensitivity, maskValue, submitSensitivity, keySensitivity as keyDetect, type FieldLike } from "../pure/sensitive";
import { closestDeep, deepActive, deepQueryAll, getChecked, hiddenReason, isDisabled, isVisible, nameOf, norm, parentOf, roleOf, valueOf, walk, type El, type Ret } from "./index";
import { hiddenDeep } from "./extract";

const FORM_SEL = "form,[role=form]";
const ROLE_FIELDS = ["textbox", "combobox", "checkbox", "radio", "switch", "searchbox", "spinbutton", "slider", "listbox"];

export function isFormControl(el: El): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return !["hidden", "submit", "button", "reset", "image"].includes((el as HTMLInputElement).type);
  if (tag === "select" || tag === "textarea") return true;
  if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return true;
  if (el.getAttribute("contenteditable") === "true" && !el.parentElement?.closest("[contenteditable=true]")) return true;
  const r = el.getAttribute("role");
  if (!r || !ROLE_FIELDS.includes(r)) return false;
  // A listbox that is a combobox's popup is part of that combobox, not a field.
  if (r === "listbox" && el.id && el.ownerDocument.querySelector(`[aria-controls~="${el.id}"],[aria-owns~="${el.id}"]`)) return false;
  return true;
}

export function controls(container: ParentNode | null): El[] {
  return Array.from(walk((container ?? document) as Node)).filter(isFormControl);
}

// ---------------------------------------------------------------------------
// Twins (#64): Radix and similar libraries render a visible <button role=checkbox|radio>
// next to a hidden native <input> (aria-hidden, opacity:0) that carries `required` and
// `name` for the form. They are one field; the visible control is the one to act on.
// ---------------------------------------------------------------------------
const ARIA_CHECK = "[role=checkbox],[role=radio],[role=switch]";
const isNativeCheck = (el: El | null | undefined): el is HTMLInputElement => !!el && el.tagName === "INPUT" && ["checkbox", "radio"].includes((el as HTMLInputElement).type);
const isAriaCheck = (el: El | null | undefined): el is El => !!el && el.tagName !== "INPUT" && el.matches(ARIA_CHECK);

/** Kept out of sight for the form's sake, not the user's: aria-hidden or not rendered. */
function concealed(el: El): boolean {
  return !!closestDeep(el, "[aria-hidden=true]") || hiddenDeep(el) || !isVisible(el);
}

function kindMatches(native: HTMLInputElement, aria: El): boolean {
  const role = aria.getAttribute("role");
  if (native.type === "radio" ? role !== "radio" : role === "radio") return false;
  const v = aria.getAttribute("value");
  return v === null || v === native.value;
}

/** The visible ARIA control a hidden native checkbox/radio mirrors (adjacent sibling or wrapper), or null. */
export function twinControl(el: El): El | null {
  if (!isNativeCheck(el) || !concealed(el)) return null;
  for (const c of [el.previousElementSibling, el.nextElementSibling, el.parentElement?.closest(ARIA_CHECK) ?? null]) {
    if (isAriaCheck(c) && !c.closest("[aria-hidden=true]") && kindMatches(el, c)) return c;
  }
  return null;
}

/** The hidden native input behind an ARIA checkbox/radio/switch, or null. */
export function twinInput(el: El): HTMLInputElement | null {
  if (!isAriaCheck(el)) return null;
  for (const c of [el.nextElementSibling, el.previousElementSibling]) if (isNativeCheck(c) && twinControl(c) === el) return c;
  const inner = Array.from(el.querySelectorAll("input")).filter(isNativeCheck);
  return inner.length === 1 && twinControl(inner[0]) === el ? inner[0] : null;
}

/** Form controls with each hidden twin folded into its visible control. */
export function logicalControls(container: ParentNode | null): El[] {
  return controls(container).filter((el) => !twinControl(el));
}

// ---------------------------------------------------------------------------
// Labels (#64): the accessible name first, then what a sighted user reads as the label.
// ---------------------------------------------------------------------------
const LABEL_MAX = 200;
const clip = (t: string) => (t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) + "…" : t);
const CHECKISH = ["checkbox", "radio", "switch"];

/** Text inside `root` that is not inside `skip` and not hidden or script. */
function textExcept(root: El, skip: El[]): string {
  const out: string[] = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const p = n.parentElement;
    if (!p || skip.some((s) => s.contains(n))) continue;
    const off = p.closest("script,style,template,noscript,[hidden],[aria-hidden=true]");
    if (off && root.contains(off)) continue;
    if (norm(n.textContent)) out.push(n.textContent!);
  }
  return norm(out.join(" "));
}

/** label[for=id] text for an element whose `.labels` the host does not expose (ARIA buttons). */
function forLabels(el: El): string {
  if (!el.id) return "";
  const root = el.getRootNode() as Document | ShadowRoot;
  const labels = Array.from(root.querySelectorAll?.("label") ?? []).filter((l) => (l as HTMLLabelElement).htmlFor === el.id);
  return norm(labels.map((l) => textExcept(l, [])).join(" "));
}

/** Text next to a box-style control (`<button role=checkbox/> Email updates`), up to the next control. */
function adjacentText(el: El, skip: El[]): string {
  for (const dir of ["nextSibling", "previousSibling"] as const) {
    for (let n = el[dir]; n; n = n[dir]) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (norm(n.textContent)) return norm(n.textContent);
        continue;
      }
      if (!(n instanceof Element) || skip.includes(n)) continue;
      if (isFormControl(n) || controls(n).length) break;
      const t = textExcept(n, []);
      if (t) return t;
    }
  }
  return "";
}

/** Text of the nearest container that holds this control (or group) and no other control. */
function containerText(target: El, own: (c: El) => boolean): string {
  for (let a = parentOf(target), depth = 0; a && depth < 4 && a !== document.body; a = parentOf(a), depth++) {
    if (logicalControls(a).some((c) => !own(c))) break;
    const t = textExcept(a, [target]);
    if (t) return t;
    if (a.matches(FORM_SEL)) break;
  }
  return "";
}

/** The label of a field: accessible name, label[for], its twin's label, the container's or adjacent text. */
export function fieldLabel(el: El): string {
  const tw = twinControl(el);
  if (tw) return fieldLabel(tw);
  const own = nameOf(el) || forLabels(el);
  if (own) return clip(own);
  const native = twinInput(el);
  const viaTwin = native ? nameOf(native) : "";
  if (viaTwin) return clip(viaTwin);
  const skip = native ? [el, native] : [el];
  const t = containerText(el, (c) => c === el) || (CHECKISH.includes(fieldType(el)) ? adjacentText(el, skip) : "");
  return clip(t);
}

function fieldType(el: El): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (tag === "input") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (role === "combobox") return "combobox";
    if (t === "checkbox" && role === "switch") return "switch";
    return t;
  }
  if (tag === "select") return (el as HTMLSelectElement).multiple ? "select-multiple" : "select";
  if (tag === "textarea") return "textarea";
  if ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true") return "contenteditable";
  return role ?? tag;
}

function groupOf(el: El): string | null {
  const tw = twinControl(el);
  if (tw) return groupOf(tw);
  if (fieldType(el) !== "radio") return null;
  const rg = closestDeep(el, "[role=radiogroup]");
  if (rg) {
    const n = nameOf(rg) || containerText(rg, (c) => rg.contains(c));
    if (n) return clip(n);
  }
  const fs = el.closest("fieldset");
  const legend = fs?.querySelector("legend");
  if (legend) return norm(legend.textContent) || null;
  return el.getAttribute("name") ?? twinInput(el)?.name ?? null;
}

function optionsOf(el: El): { label: string; value: string; selected: boolean }[] | undefined {
  if (el instanceof HTMLSelectElement || el.tagName === "SELECT") {
    return Array.from((el as HTMLSelectElement).options)
      .slice(0, 200)
      .map((o) => ({ label: norm(o.label || o.text), value: o.value, selected: o.selected }));
  }
  if (el.getAttribute("role") === "listbox") {
    return Array.from(el.querySelectorAll("[role=option]")).map((o) => ({ label: nameOf(o), value: o.getAttribute("data-value") ?? nameOf(o), selected: o.getAttribute("aria-selected") === "true" }));
  }
  return undefined;
}

function rawValue(el: El): string {
  if (el.tagName === "SELECT") {
    return Array.from((el as HTMLSelectElement).selectedOptions)
      .map((o) => norm(o.label || o.text))
      .join(", ");
  }
  if ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true") return el.textContent ?? "";
  return valueOf(el);
}

function fieldLike(el: El): FieldLike {
  return { type: fieldType(el), autocomplete: el.getAttribute("autocomplete"), name: el.getAttribute("name") ?? twinInput(el)?.name ?? null, id: el.id || null, label: fieldLabel(el) || null };
}

function isRequired(el: El): boolean {
  const tw = twinInput(el);
  return !!(el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || !!tw?.required;
}

/** Everything the background needs about one field. Sensitive values are masked here, in the page. */
export function describeField(el: El, i: number) {
  const fl = fieldLike(el);
  const d: Record<string, unknown> = { el: i, label: fl.label, type: fl.type, name: fl.name, id: fl.id };
  if (fl.autocomplete && fl.autocomplete !== "on" && fl.autocomplete !== "off") d.autocomplete = fl.autocomplete;
  if (isRequired(el)) d.required = true;
  if (isDisabled(el)) d.disabled = true;
  d.visible = !hiddenDeep(el) && isVisible(el);
  const g = groupOf(el);
  if (g) d.group = g;
  const ch = getChecked(el);
  if (ch !== null) d.checked = ch;
  if (fl.type === "radio" || fl.type === "checkbox") d.value = (el as HTMLInputElement).value || (el.getAttribute("value") ?? twinInput(el)?.value ?? "");
  else d.value = maskValue(fl, rawValue(el));
  const opts = optionsOf(el);
  if (opts) d.options = opts;
  return d;
}

function formOf(el: El): El | null {
  if (el.matches(FORM_SEL)) return el;
  return closestDeep(el, FORM_SEL) ?? ((el as HTMLInputElement).form as El | null) ?? null;
}

function formLabel(f: El): string {
  return nameOf(f) || f.getAttribute("name") || f.id || "";
}

/**
 * Form identification (#9): `self` = a form or any element in one; else the only
 * visible form on the page; no forms = the whole document; several = error listing them.
 */
function resolveContainer(self: El | null): { container: El | Document; form: El | null } | { several: El[] } {
  if (self) {
    const f = formOf(self);
    return f ? { container: f, form: f } : { container: self, form: null };
  }
  const forms = deepQueryAll(document, FORM_SEL).filter((f) => !hiddenDeep(f) && controls(f).length > 0);
  if (forms.length === 1) return { container: forms[0], form: forms[0] };
  if (forms.length === 0) return { container: document, form: null };
  return { several: forms };
}

function severalError(forms: El[]): Ret {
  return { value: { error: "several forms", forms: forms.map((f, i) => ({ el: i, label: formLabel(f) || null, fields: controls(f).length })) }, elements: forms };
}

/** form.describe / form.fill: the fields of the identified form. */
export function describeFields(self: El | null): Ret {
  const r = resolveContainer(self);
  if ("several" in r) return severalError(r.several);
  const els = logicalControls(r.container as ParentNode);
  const elements: El[] = [...els];
  const fields = els.map((el, i) => describeField(el, i));
  let form: unknown = null;
  if (r.form) {
    elements.push(r.form);
    form = { el: elements.length - 1, label: formLabel(r.form) || null, sensitive: formSensitivity(els.map(fieldLike)) };
  }
  return { value: { form, fields }, elements };
}

/** One field by ref (for ref keys in form.fill). */
export function fieldInfo(el: El): Ret {
  return { value: describeField(el, 0), elements: [el] };
}

function isSubmitControl(el: El): boolean {
  if (el.tagName === "BUTTON") return ((el as HTMLButtonElement).type || "submit") === "submit";
  if (el.tagName === "INPUT") return ["submit", "image"].includes((el as HTMLInputElement).type);
  return false;
}

function fieldsWithValues(form: El | null): (FieldLike & { value: string })[] {
  if (!form) return [];
  return logicalControls(form).map((el) => ({ ...fieldLike(el), value: fieldType(el) === "checkbox" || fieldType(el) === "radio" ? String(getChecked(el) ?? "") : rawValue(el) }));
}

/** Gate inputs for a click (D18 a/b). Values leave the page only for masked confirmation text. */
export function clickGateInfo(el: El) {
  const form = isSubmitControl(el) ? ((el as HTMLButtonElement).form as El | null) ?? formOf(el) : null;
  return { role: roleOf(el), name: nameOf(el).slice(0, 200), isSubmit: !!form, formFields: form ? fieldsWithValues(form) : undefined };
}

/**
 * Gate inputs for a key press (D18a via Enter) on `self` (the ref the agent named) or else the
 * focused element. focusInFrame: focus is inside an embedded frame, whose own document must be
 * asked (review H3). hasFocus tells the background which frame's document holds the focus.
 */
export function keyGateInfo(self?: El | null) {
  const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : false;
  const el = self ?? deepActive();
  if (!el || el === document.body) return { inForm: false, hasFocus };
  if (!self && (el.tagName === "IFRAME" || el.tagName === "FRAME")) return { inForm: false, focusInFrame: true, hasFocus };
  const form = formOf(el);
  return { inForm: !!form, hasFocus, textarea: el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable, formFields: form ? fieldsWithValues(form) : undefined, formName: form ? formLabel(form) : undefined };
}

/** form.submit: the form, its submit control and fields (for the gate and confirmation). */
export function submitInfo(self: El | null): Ret {
  const r = resolveContainer(self);
  if ("several" in r) return severalError(r.several);
  if (!r.form) return { value: null, elements: [] };
  const form = r.form;
  const submits = Array.from(form.querySelectorAll("button,input[type=submit],input[type=image]")).filter(isSubmitControl);
  const submit = submits.find((b) => !isDisabled(b) && !hiddenDeep(b)) ?? null;
  const elements: El[] = [form];
  if (submit) elements.push(submit);
  // #2524: the form has its own submit control but the page keeps it disabled or hidden (an
  // incomplete multi-step form). requestSubmit would go around the page's own gate and the
  // page ignores it, so report why instead of "submitting".
  const gated = !submit && submits[0];
  const blocked = gated ? { control: nameOf(gated).slice(0, 120), why: [isDisabled(gated) && "disabled", hiddenDeep(gated) && `hidden (${hiddenReason(gated) ?? "not rendered"})`].filter(Boolean).join(" and ") } : undefined;
  return { value: { el: 0, submit: submit ? 1 : null, control: submit ? nameOf(submit) : formLabel(form), fields: fieldsWithValues(form), ...(blocked ? { blocked } : {}) }, elements };
}

// ---------------------------------------------------------------------------
// form.blockers (#64): why a form can't submit.
// ---------------------------------------------------------------------------
const SUBMIT_WORDS = /^(continue|next|submit|send|save|sign ?up|sign ?in|log ?in|register|apply|done|finish|create|confirm|request|get started|proceed|join|subscribe|place order|pay)\b/i;
const BLOCKER_CAP = 30;

/** A button that submits or advances a form: a form's submit control, or a Continue/Next-style button. */
export function submitLike(el: El): boolean {
  if (isSubmitControl(el) && (((el as HTMLButtonElement).form as El | null) ?? formOf(el))) return true;
  return roleOf(el) === "button" && SUBMIT_WORDS.test(nameOf(el));
}

/** Not rendered at all (hidden attribute, display:none, own visibility:hidden); aria-hidden alone does not count. */
function notRendered(el: El): boolean {
  for (let a: El | null = el; a; a = parentOf(a)) {
    if ((a as HTMLElement).hidden) return true;
    const st = getComputedStyle(a);
    if (st.display === "none" || (a === el && st.visibility === "hidden")) return true;
  }
  return false;
}

function visibleText(el: El | null | undefined): string {
  return el && !notRendered(el) ? clip(textExcept(el, [])) : "";
}

/** The page's own error text for a field: aria-errormessage / aria-describedby, else an alert-ish element beside it. */
function errorText(el: El): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const ids = [el.getAttribute("aria-errormessage"), el.getAttribute("aria-describedby")].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const t = visibleText(root.getElementById?.(id));
    if (t) return t;
  }
  for (let a = parentOf(el), depth = 0; a && depth < 3 && !a.matches(FORM_SEL); a = parentOf(a), depth++) {
    if (logicalControls(a).some((c) => c !== el)) break;
    for (const e of Array.from(a.querySelectorAll("[role=alert],[aria-live],[class*=error],[class*=Error],[id*=error],[id*=Error]"))) {
      const t = visibleText(e);
      if (t) return t;
    }
  }
  return "";
}

function validityKind(v: ValidityState): string | null {
  if (v.valid) return null;
  if (v.valueMissing) return "empty";
  if (v.typeMismatch) return "type";
  if (v.patternMismatch) return "pattern";
  if (v.tooShort || v.tooLong) return "length";
  if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) return "range";
  return "invalid";
}

const KIND_MESSAGE: Record<string, string> = {
  empty: "Required field is empty",
  unchecked: "Required checkbox is not checked",
  unselected: "Required choice has no option selected",
  type: "Value has the wrong format",
  pattern: "Value does not match the required pattern",
  length: "Value is too short or too long",
  range: "Value is out of range",
  invalid: "The page marks this field invalid",
};

/** Which container form.blockers looks at, and which button submits it. */
function blockerScope(self: El | null): { container: El; form: El | null; submit: El | null } | { several: El[] } {
  if (self && (roleOf(self) === "button" || isSubmitControl(self))) {
    const form = ((self as HTMLButtonElement).form as El | null) ?? formOf(self);
    return { container: form ?? closestDeep(self, "[role=dialog],dialog,main") ?? document.body, form, submit: self };
  }
  let start = self;
  if (!start) {
    const a = deepActive();
    if (a && a !== document.body && formOf(a)) start = a;
  }
  if (start) {
    const form = formOf(start);
    return { container: form ?? start, form, submit: null };
  }
  const r = resolveContainer(null);
  if ("several" in r) return r;
  return { container: r.container.nodeType === 9 ? document.body : (r.container as El), form: r.form, submit: null };
}

function findSubmit(container: El): El | null {
  const btns = Array.from(walk(container)).filter((b) => !notRendered(b) && (isSubmitControl(b) || roleOf(b) === "button"));
  return btns.find((b) => isSubmitControl(b) && (container.matches(FORM_SEL) || submitLike(b))) ?? btns.find((b) => SUBMIT_WORDS.test(nameOf(b))) ?? null;
}

interface Blocker {
  el: El;
  label: string | null;
  group?: string;
  kind: string;
  message: string;
}

function invalidBlocker(el: El, label: string | null): Blocker | null {
  if (el.getAttribute("aria-invalid") === "true") return { el, label, kind: "invalid", message: errorText(el) || KIND_MESSAGE.invalid };
  const inp = el as HTMLInputElement;
  const kind = inp.validity && inp.willValidate !== false ? validityKind(inp.validity) : null;
  return kind ? { el, label, kind, message: norm(inp.validationMessage) || KIND_MESSAGE[kind] } : null;
}

/** form.blockers: required fields left empty, invalid fields, and the submit control's state. */
export function formBlockers(self: El | null): Ret {
  const scope = blockerScope(self);
  // Several forms and no focus: the one with the most fields is the page's main form.
  if ("several" in scope) return formBlockers([...scope.several].sort((a, b) => logicalControls(b).length - logicalControls(a).length)[0]);
  const { container, form } = scope;
  const submit = scope.submit ?? findSubmit(container);
  const all = logicalControls(container);
  const found: Blocker[] = [];
  const radios = new Map<unknown, { members: El[]; required: boolean }>();
  for (const el of all) {
    if (isDisabled(el) || notRendered(el)) continue;
    const type = fieldType(el);
    const label = fieldLabel(el) || null;
    if (type === "radio") {
      const rg = closestDeep(el, "[role=radiogroup]");
      const key = el.getAttribute("name") || twinInput(el)?.name || rg || el;
      const g = radios.get(key) ?? { members: [], required: false };
      g.members.push(el);
      g.required ||= isRequired(el) || rg?.getAttribute("aria-required") === "true";
      radios.set(key, g);
      continue;
    }
    if (CHECKISH.includes(type)) {
      if (isRequired(el) && getChecked(el) !== true) found.push({ el, label, kind: "unchecked", message: KIND_MESSAGE.unchecked });
      else if (el.getAttribute("aria-invalid") === "true") found.push({ el, label, kind: "invalid", message: errorText(el) || KIND_MESSAGE.invalid });
      continue;
    }
    const value = norm(el.tagName === "SELECT" ? (el as HTMLSelectElement).value : rawValue(el));
    const b = isRequired(el) && !value ? { el, label, kind: "empty", message: KIND_MESSAGE.empty } : invalidBlocker(el, label);
    if (b) found.push(b);
  }
  for (const g of radios.values()) {
    if (!g.required || g.members.some((m) => getChecked(m) === true)) continue;
    const group = groupOf(g.members[0]);
    found.push({ el: g.members[0], label: fieldLabel(g.members[0]) || null, ...(group ? { group } : {}), kind: "unselected", message: KIND_MESSAGE.unselected });
  }
  // Document order, so the agent fixes them top to bottom.
  found.sort((a, b) => all.indexOf(a.el) - all.indexOf(b.el));
  const shown = found.slice(0, BLOCKER_CAP);
  const elements: El[] = shown.map((b) => b.el);
  const blockers = shown.map((b, i) => ({ el: i, label: b.label, ...(b.group ? { group: b.group } : {}), kind: b.kind, message: b.message }));
  let formOut: unknown = null;
  if (form) {
    elements.push(form);
    formOut = { el: elements.length - 1, label: formLabel(form) || null };
  }
  let submitOut: unknown = null;
  if (submit) {
    elements.push(submit);
    const hidden = notRendered(submit) ? hiddenReason(submit) : null;
    submitOut = { el: elements.length - 1, label: nameOf(submit).slice(0, 120), disabled: isDisabled(submit), ...(hidden ? { hidden } : {}) };
  }
  return { value: { form: formOut, submit: submitOut, blockers, ...(found.length > shown.length ? { more: found.length - shown.length } : {}) }, elements };
}

export function requestSubmit(form: El, submitter?: El) {
  const f = form as HTMLFormElement;
  if (typeof f.requestSubmit === "function" && f.tagName === "FORM") f.requestSubmit(submitter as HTMLElement | undefined);
  else f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;
}

/** Options of a combobox's popup, visible ones only. */
export function comboOptions(el: El): Ret<{ el: number; label: string }[]> {
  const ids = [el.getAttribute("aria-controls"), el.getAttribute("aria-owns"), el.getAttribute("list")].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
  const boxes = ids.map((id) => el.ownerDocument.getElementById(id)).filter(Boolean) as El[];
  let opts: El[] = [];
  for (const b of boxes) opts.push(...Array.from(b.querySelectorAll(b.tagName === "DATALIST" ? "option" : "[role=option]")));
  if (!boxes.length) opts = deepQueryAll(document, "[role=option]");
  opts = opts.filter((o) => o.tagName === "OPTION" || !hiddenDeep(o));
  return { value: opts.map((o, i) => ({ el: i, label: o.tagName === "OPTION" ? norm((o as HTMLOptionElement).value || o.textContent) : nameOf(o) })), elements: opts };
}

/** act.upload: the file input behind `el` (itself, its label's control, or a lone descendant). */
export function resolveFileInput(el: El): Ret<{ el: number } | null> {
  const isFile = (x: El | null | undefined): x is HTMLInputElement => !!x && x.tagName === "INPUT" && (x as HTMLInputElement).type === "file";
  if (isFile(el)) return { value: { el: 0 }, elements: [el] };
  if (el.tagName === "LABEL" && isFile((el as HTMLLabelElement).control as El | null)) return { value: { el: 0 }, elements: [(el as HTMLLabelElement).control as El] };
  const inner = el.querySelectorAll("input[type=file]");
  if (inner.length === 1) return { value: { el: 0 }, elements: [inner[0]] };
  return { value: null, elements: [] };
}

// Compatibility for callers of the old pagelib API.
export function clickSensitivity(el: El) {
  const info = clickGateInfo(el);
  return { label: info.name, reasons: submitSensitivity(info).map((d) => d.reason) };
}
export function keySensitivity(_self: unknown, key: string) {
  return { reasons: keyDetect(key, keyGateInfo()).map((d) => d.reason) };
}
