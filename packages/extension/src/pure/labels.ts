// form.fill key resolution (D34). Pure: works on field descriptors, no DOM.
import type { ErrorCode } from "@tabagent/protocol";

export interface FieldOption {
  label: string;
  value: string;
  selected?: boolean;
}

/** One form control as reported by pagelib describeFields. */
export interface FieldDesc {
  ref: string;
  label: string | null;
  type: string;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  /** For radios: the group's accessible name (fieldset legend / radiogroup name / name attr). */
  group?: string | null;
  value?: string;
  checked?: boolean;
  required?: boolean;
  options?: FieldOption[];
  visible?: boolean;
  disabled?: boolean;
}

export interface KeyError {
  code: ErrorCode;
  message: string;
  candidates?: string[];
}

export interface KeyMatch {
  key: string;
  ref?: string;
  field?: FieldDesc;
  /** A radio group matched by its group label. */
  group?: FieldDesc[];
  error?: KeyError;
}

const REF_KEY = /^e\d+$/;

/** D34: a key matching ^e\d+$ is a ref; anything else is a label. */
export function isRefKey(k: string): boolean {
  return REF_KEY.test(k);
}

/**
 * Case-insensitive, whitespace-normalised. Trailing required-markers and colons
 * ("Email *", "Email:") are decoration, not part of the label.
 */
export function normLabel(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s*:]+$/g, "")
    .toLowerCase();
}

function isRadio(f: FieldDesc) {
  return f.type === "radio";
}

/** Resolve every key to a ref, a radio group, or a per-key error. Never throws. */
export function matchKeys(keys: string[], fields: FieldDesc[]): KeyMatch[] {
  return keys.map((key) => matchKey(key, fields));
}

export function matchKey(key: string, fields: FieldDesc[]): KeyMatch {
  if (isRefKey(key)) {
    const field = fields.find((f) => f.ref === key);
    return field ? { key, ref: key, field } : { key, ref: key };
  }
  const k = normLabel(key);
  // Candidates: non-radio fields by label, radio groups by group label, single radios by their own label.
  const byLabel = fields.filter((f) => !isRadio(f) && normLabel(f.label) === k);
  const groups = new Map<string, FieldDesc[]>();
  for (const f of fields) {
    if (isRadio(f) && f.group && normLabel(f.group) === k) {
      const g = groups.get(f.group) ?? [];
      g.push(f);
      groups.set(f.group, g);
    }
  }
  const radioByLabel = groups.size ? [] : fields.filter((f) => isRadio(f) && normLabel(f.label) === k);
  type Cand = { refs: string[]; visible: boolean; m: KeyMatch };
  const cands: Cand[] = [
    ...byLabel.map((f) => ({ refs: [f.ref], visible: f.visible !== false, m: { key, ref: f.ref, field: f } })),
    ...[...groups.values()].map((g) => ({ refs: g.map((f) => f.ref), visible: g.some((f) => f.visible !== false), m: { key, group: g } })),
    ...radioByLabel.map((f) => ({ refs: [f.ref], visible: f.visible !== false, m: { key, ref: f.ref, field: f } })),
  ];
  if (cands.length === 1) return cands[0].m;
  if (cands.length === 0) {
    const known = [...new Set(fields.map((f) => (isRadio(f) ? f.group : f.label)).filter(Boolean))].slice(0, 30);
    return {
      key,
      error: { code: "NOT_FOUND", message: `No field labelled "${key}". Labels: ${known.join(" | ") || "(none)"}` },
    };
  }
  const visible = cands.filter((c) => c.visible);
  if (visible.length === 1) return visible[0].m;
  const refs = cands.flatMap((c) => c.refs);
  return {
    key,
    error: { code: "BAD_REQUEST", message: `${cands.length} fields are labelled "${key}": ${refs.join(", ")}. Use a ref as the key.`, candidates: refs },
  };
}
