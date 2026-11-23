// form.fill value coercion (D34). Pure: decides what to do with a value for a field.
import type { ErrorCode } from "@tabagent/protocol";
import { normLabel, type FieldDesc } from "./labels";

export type FillValue = string | boolean | string[];

export type FillAction =
  | { kind: "text"; ref: string; text: string }
  | { kind: "check"; ref: string; checked: boolean }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "combobox"; ref: string; text: string }
  | { kind: "error"; ref?: string; code: ErrorCode; message: string };

const err = (code: ErrorCode, message: string, ref?: string): FillAction => ({ kind: "error", code, message, ...(ref ? { ref } : {}) });

const CHECKABLE = new Set(["checkbox", "switch", "menuitemcheckbox"]);
const TEXTLIKE_NO_BOOL = new Set(["number", "range", "date", "datetime-local", "month", "time", "week", "email", "tel", "url", "password"]);

function asBool(v: FillValue): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Option by label (exact, normalised), then by value. */
export function pickOption(options: { label: string; value: string }[], want: string): { label: string; value: string } | undefined {
  const w = normLabel(want);
  return options.find((o) => normLabel(o.label) === w) ?? options.find((o) => o.value === want) ?? options.find((o) => normLabel(o.value) === w);
}

const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Normalise an ISO 8601 date/time for an input type, or null when it isn't one. */
export function isoFor(type: string, v: string): string | null {
  if (type === "time") {
    const m = v.match(/^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return m[3] && m[3] !== "00" ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
  }
  if (type === "week") return /^\d{4}-W\d{2}$/.test(v) ? v : null;
  const m = v.match(ISO);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  if (+mo < 1 || +mo > 12) return null;
  if (d && (+d < 1 || +d > 31)) return null;
  if (hh && (+hh > 23 || +mm > 59)) return null;
  switch (type) {
    case "month":
      return `${y}-${mo}`;
    case "date":
      return d ? `${y}-${mo}-${d}` : null;
    case "datetime-local":
      return d ? `${y}-${mo}-${d}T${hh ?? "00"}:${mm ?? "00"}` : null;
  }
  return null;
}

/** Decide the action for one matched key. `target` is a field or a radio group. */
export function planValue(target: FieldDesc | { key: string; group: FieldDesc[] }, value: FillValue): FillAction {
  if ("group" in target && Array.isArray(target.group)) {
    if (typeof value !== "string") return err("BAD_REQUEST", "A radio group takes the option's label or value as a string");
    const opts = target.group.map((r) => ({ label: r.label ?? "", value: r.value ?? "", ref: r.ref }));
    const hit = pickOption(opts, value) as (typeof opts)[number] | undefined;
    if (!hit) return err("NOT_FOUND", `No option "${value}". Options: ${opts.map((o) => o.label || o.value).join(" | ")}`);
    return { kind: "check", ref: hit.ref, checked: true };
  }
  const f = target as FieldDesc;
  const t = f.type;
  if (t === "file") return err("BAD_REQUEST", "File inputs need act.upload", f.ref);
  if (CHECKABLE.has(t) || t === "radio") {
    const b = asBool(value);
    if (b === null) return err("BAD_REQUEST", `A ${t} takes true or false`, f.ref);
    return { kind: "check", ref: f.ref, checked: b };
  }
  if (t === "select" || t === "select-multiple" || t === "listbox") {
    const wants = Array.isArray(value) ? value : [String(value)];
    if (wants.length > 1 && t === "select") return err("BAD_REQUEST", "This select takes one value", f.ref);
    const opts = f.options ?? [];
    const values: string[] = [];
    for (const w of wants) {
      const o = pickOption(opts, w);
      if (!o) return err("NOT_FOUND", `No option "${w}". Options: ${opts.map((o) => o.label).slice(0, 30).join(" | ")}`, f.ref);
      values.push(o.value);
    }
    return { kind: "select", ref: f.ref, values };
  }
  if (t === "combobox") {
    if (typeof value !== "string") return err("BAD_REQUEST", "A combobox takes the option text as a string", f.ref);
    return { kind: "combobox", ref: f.ref, text: value };
  }
  if (["date", "datetime-local", "month", "time", "week"].includes(t)) {
    if (typeof value !== "string") return err("BAD_REQUEST", `A ${t} input takes an ISO 8601 string`, f.ref);
    const iso = isoFor(t, value);
    if (!iso) return err("BAD_REQUEST", `"${value}" is not an ISO 8601 value for a ${t} input (e.g. ${t === "time" ? "09:30" : t === "month" ? "2026-01" : "2026-01-15"})`, f.ref);
    return { kind: "text", ref: f.ref, text: iso };
  }
  if (typeof value === "boolean") {
    if (TEXTLIKE_NO_BOOL.has(t)) return err("BAD_REQUEST", `A ${t} field takes a string, not a boolean`, f.ref);
    return { kind: "text", ref: f.ref, text: String(value) };
  }
  return { kind: "text", ref: f.ref, text: Array.isArray(value) ? value.join(", ") : value };
}
