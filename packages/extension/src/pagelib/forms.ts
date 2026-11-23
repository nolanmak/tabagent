// pagelib forms (#7): the D18 a/b gate inputs (a form's fields for a submit click or Enter).
// Decisions (sensitivity) live in ../pure; this file only reads the DOM.
import type { FieldLike } from "../pure/sensitive";
import { closestDeep, deepActive, getChecked, nameOf, norm, roleOf, valueOf, walk, type El } from "./index";

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

function formOf(el: El): El | null {
  if (el.matches(FORM_SEL)) return el;
  return closestDeep(el, FORM_SEL) ?? ((el as HTMLInputElement).form as El | null) ?? null;
}

function formLabel(f: El): string {
  return nameOf(f) || f.getAttribute("name") || f.id || "";
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

