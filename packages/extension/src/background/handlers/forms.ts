// form.describe / form.fill / form.submit (#9, D34, D18a).
import { TabAgentError, TIMEOUTS, type ErrorCode } from "@tabagent/protocol";
import { planValue, type FillAction, type FillValue } from "../../pure/coerce";
import { fillResult, type Failed, type Filled } from "../../pure/fill";
import { isRefKey, matchKey, normLabel, type FieldDesc } from "../../pure/labels";
import { clickSensitivity, formSensitivity, type Detection } from "../../pure/sensitive";
import { sleep } from "../cdp";
import { act, onTab, type Ctx, type TabCtx } from "./ctx";
import { gateDetections } from "./gates";
import { setCheckState } from "./check";

type Handler = (c: Ctx) => Promise<unknown>;
const CALL_CAP_MS = 120_000;

interface Described {
  form: { ref: string; label: string | null; sensitive?: string[] } | null;
  fields: FieldDesc[];
}

function severalForms(v: any): never {
  const list = (v.forms as { ref: string; label: string | null; fields: number }[]).map((f) => `${f.ref}${f.label ? ` "${f.label}"` : ""} (${f.fields} fields)`).join(", ");
  throw new TabAgentError("BAD_REQUEST", `This page has ${v.forms.length} forms: ${list}`, "Pass ref = the form, or any field in it.", { pageText: true });
}

async function describe(t: TabCtx, ref?: string): Promise<Described> {
  const v = (await t.drv.call("describeFields", [], ref ? { ref } : {})) as any;
  if (v?.error) severalForms(v);
  return v as Described;
}

/** What form.describe shows the agent (D34): a ref for every field; sensitive values already masked in the page. */
function publicField(f: FieldDesc & Record<string, unknown>) {
  return {
    ref: f.ref,
    label: f.label,
    type: f.type,
    required: !!f.required,
    value: f.value ?? "",
    ...(f.options ? { options: f.options.map((o) => o.label) } : {}),
    ...(f.group ? { group: f.group } : {}),
    ...(f.checked !== undefined ? { checked: f.checked } : {}),
    ...(f.name ? { name: f.name } : {}),
    ...(f.visible === false ? { hidden: true } : {}),
    ...(f.disabled ? { disabled: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// executing one planned action through the driver
// ---------------------------------------------------------------------------
async function setChecked(t: TabCtx, ref: string, checked: boolean, timeout: number) {
  return setCheckState(t.drv, ref, checked, timeout);
}

async function pickComboOption(t: TabCtx, ref: string, text: string, timeout: number) {
  await t.drv.fill(ref, text, timeout);
  const want = normLabel(text);
  const end = Date.now() + timeout;
  let seen: string[] = [];
  for (;;) {
    const opts = (await t.drv.call("comboOptions", [], { ref })) as { ref: string; label: string }[];
    seen = opts.map((o) => o.label);
    const hit = opts.find((o) => normLabel(o.label) === want);
    if (hit) {
      await t.drv.click(hit.ref, { timeout });
      return;
    }
    if (Date.now() > end) break;
    await sleep(100);
  }
  throw new TabAgentError("NOT_FOUND", `No option exactly "${text}" appeared${seen.length ? `. Options: ${seen.slice(0, 20).join(" | ")}` : ""}`, "Type a value that matches one option, or act.click the option from a snapshot.", { pageText: seen.length > 0 });
}

async function run(t: TabCtx, a: Exclude<FillAction, { kind: "error" }>, timeout: number) {
  switch (a.kind) {
    case "text":
      return t.drv.fill(a.ref, a.text, timeout);
    case "check":
      return setChecked(t, a.ref, a.checked, timeout);
    case "select": {
      const r = (await t.drv.call("selectOptions", [a.values], { ref: a.ref })) as { selected?: string[]; error?: string; notSelect?: boolean };
      if (r.notSelect) throw new TabAgentError("NOT_ACTIONABLE", `${a.ref} is a custom listbox`, "act.click the option from a page.snapshot.");
      if (r.error) throw new TabAgentError("NOT_FOUND", r.error, undefined, { pageText: true });
      return;
    }
    case "combobox":
      return pickComboOption(t, a.ref, a.text, timeout);
  }
}

function failure(key: string, e: unknown, ref?: string): Failed {
  const code: ErrorCode = e instanceof TabAgentError ? e.code : "INTERNAL";
  return { key, code, message: String((e as Error)?.message ?? e), ...(ref ? { ref } : {}) };
}

async function fillFields(c: Ctx, t: TabCtx, values: Record<string, FillValue>) {
  const keys = Object.keys(values);
  const perField = c.p.timeout ?? TIMEOUTS.action;
  const deadline = Date.now() + CALL_CAP_MS;
  const filled: Filled[] = [];
  const failed: Failed[] = [];
  let container: string | undefined = c.p.ref ?? (keys.some((k) => !isRefKey(k)) ? undefined : keys[0]);
  let desc: Described | null = null;
  const fieldsNow = async () => {
    if (desc) return desc.fields;
    try {
      desc = await describe(t, container);
    } catch (e) {
      // Several forms: a ref key identifies the form (#9).
      const firstRef = keys.find(isRefKey);
      if (!container && firstRef && e instanceof TabAgentError && e.code === "BAD_REQUEST") {
        container = firstRef;
        desc = await describe(t, container);
      } else throw e;
    }
    return desc!.fields;
  };

  let pending = keys;
  for (let pass = 0; pass < 2 && pending.length; pass++) {
    const retry: string[] = [];
    const filledBefore = filled.length;
    for (const key of pending) {
      if (Date.now() > deadline) {
        failed.push({ key, code: "TIMEOUT", message: "form.fill hit its 120s cap before this field" });
        continue;
      }
      if (t.drv.dialog()) {
        failed.push({ key, code: "DIALOG_OPEN", message: "A dialog opened while filling; handle it, then fill the rest" });
        continue;
      }
      let target: FieldDesc | { key: string; group: FieldDesc[] };
      if (isRefKey(key)) {
        try {
          const f = (await t.drv.call("fieldInfo", [], { ref: key })) as FieldDesc & { ref: string };
          target = { ...f, ref: key };
        } catch (e) {
          failed.push(failure(key, e, key));
          continue;
        }
      } else {
        const m = matchKey(key, await fieldsNow());
        if (m.error) {
          // A field revealed by an earlier choice is matched on the second pass.
          if (pass === 0 && m.error.code === "NOT_FOUND") retry.push(key);
          else failed.push({ key, code: m.error.code, message: m.error.message });
          continue;
        }
        target = m.group ? { key, group: m.group } : m.field!;
      }
      const action = planValue(target, values[key]);
      if (action.kind === "error") {
        failed.push({ key, code: action.code, message: action.message, ...(action.ref ? { ref: action.ref } : {}) });
        continue;
      }
      try {
        const r = await run(t, action, Math.min(perField, Math.max(1, deadline - Date.now())));
        const unverified = action.kind === "check" && (r as { verified?: boolean } | undefined)?.verified === false;
        filled.push({ key, ref: action.ref, ...(unverified ? { unverified: true as const } : {}) });
      } catch (e) {
        failed.push(failure(key, e, action.ref));
      }
    }
    if (!retry.length) break;
    if (filled.length === filledBefore) {
      // Nothing changed this pass, so nothing new can have been revealed.
      for (const key of retry) failed.push({ key, code: "NOT_FOUND", message: matchKey(key, (desc as Described | null)?.fields ?? []).error!.message });
      break;
    }
    await sleep(150);
    desc = null;
    pending = retry;
  }
  return fillResult(filled, failed);
}

export const formHandlers: Record<string, Handler> = {
  async "form.describe"(c) {
    return onTab(c, "read", async (t) => {
      const d = await describe(t, c.p.ref);
      return { forms: d.form ? [{ ref: d.form.ref, label: d.form.label, ...(d.form.sensitive?.length ? { sensitive: d.form.sensitive } : {}) }] : [], fields: d.fields.map((f) => publicField(f as FieldDesc & Record<string, unknown>)) };
    });
  },

  async "form.fill"(c) {
    const values = c.p.fields as Record<string, FillValue>;
    let result: ReturnType<typeof fillResult> = fillResult([], []);
    return act(
      c,
      "act",
      async (t) => {
        result = await fillFields(c, t, values);
        const d = t.drv.dialog();
        return d ? { dialog: d } : undefined;
      },
      () => result,
    );
  },

  async "form.submit"(c) {
    return act(c, "act", async (t) => {
      const v = (await t.drv.call("submitInfo", [], c.p.ref ? { ref: c.p.ref } : {})) as any;
      if (v?.error) severalForms(v);
      if (!v) throw new TabAgentError("NOT_FOUND", "No form found", "Pass ref of the form or a field inside it.");
      if (v.blocked) {
        throw new TabAgentError("NOT_ACTIONABLE", `The form's submit button "${v.blocked.control}" is ${v.blocked.why}, so the page would ignore a submit`, "The form is not complete yet: fill the fields it shows (form.describe), answer any question that reveals the next step, then submit again.", {
          pageText: true,
        });
      }
      const fields = v.fields as Parameters<typeof formSensitivity>[0];
      const dets: Detection[] = [...formSensitivity(fields).map((r) => ({ category: "a" as const, reason: `submits a form with a ${r}` })), ...(v.submitRef ? clickSensitivity({ role: "button", name: v.control }) : [])];
      await gateDetections(c, t.url, dets, v.control || "form", fields, "submit");
      if (v.submitRef) return t.drv.click(v.submitRef, { timeout: c.p.timeout });
      await t.drv.call("requestSubmit", [], { ref: v.ref });
    });
  },
};
