// pagelib forms (#9, #13): field descriptors, form identification, gate inputs.
// Decisions (matching, coercion, sensitivity) live in ../pure; this file only reads the DOM.
import { formSensitivity, maskValue, submitSensitivity, keySensitivity as keyDetect, type FieldLike } from "../pure/sensitive";
import { closestDeep, deepActive, deepQueryAll, getChecked, isDisabled, isVisible, nameOf, norm, roleOf, valueOf, walk, type El, type Ret } from "./index";
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
  if (fieldType(el) !== "radio") return null;
  const rg = closestDeep(el, "[role=radiogroup]");
  if (rg) return nameOf(rg) || null;
  const fs = el.closest("fieldset");
  const legend = fs?.querySelector("legend");
  if (legend) return norm(legend.textContent) || null;
  return el.getAttribute("name");
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
  return { type: fieldType(el), autocomplete: el.getAttribute("autocomplete"), name: el.getAttribute("name"), id: el.id || null, label: nameOf(el) || null };
}

/** Everything the background needs about one field. Sensitive values are masked here, in the page. */
export function describeField(el: El, i: number) {
  const fl = fieldLike(el);
  const d: Record<string, unknown> = { el: i, label: fl.label, type: fl.type, name: fl.name, id: fl.id };
  if (fl.autocomplete && fl.autocomplete !== "on" && fl.autocomplete !== "off") d.autocomplete = fl.autocomplete;
  if ((el as HTMLInputElement).required || el.getAttribute("aria-required") === "true") d.required = true;
  if (isDisabled(el)) d.disabled = true;
  d.visible = !hiddenDeep(el) && isVisible(el);
  const g = groupOf(el);
  if (g) d.group = g;
  const ch = getChecked(el);
  if (ch !== null) d.checked = ch;
  if (fl.type === "radio" || fl.type === "checkbox") d.value = (el as HTMLInputElement).value ?? "";
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
  const els = controls(r.container as ParentNode);
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
  return controls(form).map((el) => ({ ...fieldLike(el), value: fieldType(el) === "checkbox" || fieldType(el) === "radio" ? String(getChecked(el) ?? "") : rawValue(el) }));
}

/** Gate inputs for a click (D18 a/b). Values leave the page only for masked confirmation text. */
export function clickGateInfo(el: El) {
  const form = isSubmitControl(el) ? ((el as HTMLButtonElement).form as El | null) ?? formOf(el) : null;
  return { role: roleOf(el), name: nameOf(el).slice(0, 200), isSubmit: !!form, formFields: form ? fieldsWithValues(form) : undefined };
}

/** Gate inputs for a key press on the focused element (D18a via Enter). */
export function keyGateInfo() {
  const el = deepActive();
  if (!el || el === document.body) return { inForm: false };
  const form = formOf(el);
  return { inForm: !!form, textarea: el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable, formFields: form ? fieldsWithValues(form) : undefined, formName: form ? formLabel(form) : undefined };
}

/** form.submit: the form, its submit control and fields (for the gate and confirmation). */
export function submitInfo(self: El | null): Ret {
  const r = resolveContainer(self);
  if ("several" in r) return severalError(r.several);
  if (!r.form) return { value: null, elements: [] };
  const form = r.form;
  const submit = Array.from(form.querySelectorAll("button,input[type=submit],input[type=image]")).find((b) => isSubmitControl(b) && !isDisabled(b) && !hiddenDeep(b)) ?? null;
  const elements: El[] = [form];
  if (submit) elements.push(submit);
  return { value: { el: 0, submit: submit ? 1 : null, control: submit ? nameOf(submit) : formLabel(form), fields: fieldsWithValues(form) }, elements };
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
