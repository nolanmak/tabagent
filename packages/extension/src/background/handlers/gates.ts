// Dynamic D18 (a)/(b) gates and the integration points with the router (agent B).
// Every sensitive path in the extension goes through sensitiveGate().
import type { SessionMeta } from "@tabagent/protocol";
import { keySensitivity, submitConfirmation, submitSensitivity, type Detection, type FieldLike } from "../../pure/sensitive";
import { requireSensitive } from "../permissions";
import type { Ctx, TabCtx } from "./ctx";

export type Category = "a" | "b" | "c" | "d" | "e" | "f";

/** Interim (D17): refused with PERMISSION_DENIED unless devAllowSensitive is on. */
export async function sensitiveGate(meta: SessionMeta, url: string, category: Exclude<Category, "f">, tool: string, summary: string, reasons: string[]) {
  await requireSensitive(meta, url, category, tool, summary, reasons);
}

interface GateInput {
  role?: string;
  name?: string;
  isSubmit?: boolean;
  formFields?: (FieldLike & { value?: string })[];
}

/**
 * One prompt per action. A click that is both (a) and (b), e.g. "Pay" on a card form,
 * is asked once under (a), the stronger category, listing every reason.
 */
export async function gateDetections(c: Ctx, url: string, dets: Detection[], label: string, fields: GateInput["formFields"], action: string) {
  if (!dets.length) return;
  const cat = dets.some((d) => d.category === "a") ? "a" : "b";
  const masked = cat === "a" && fields ? submitConfirmation({ control: label, fields }).reasons : [];
  await sensitiveGate(c.meta, url, cat, c.tool.name, `${action} "${label.slice(0, 60)}"`, [...dets.map((h) => h.reason), ...masked]);
}

/** act.click / act.dblclick: D18(a) submit control of a sensitive form, D18(b) keywords. */
export async function checkClickGate(c: Ctx, t: TabCtx, ref: string) {
  const info = (await t.drv.call("clickGateInfo", [], { ref })) as GateInput;
  const dets = submitSensitivity(info);
  await gateDetections(c, t.url, dets, info.name || ref, info.formFields, "click");
}

/** act.press / act.type submit=true: D18(a) Enter inside a sensitive form. */
export async function checkKeyGate(c: Ctx, t: TabCtx, key: string) {
  if (!/enter$/i.test(key)) return;
  const info = (await t.drv.call("keyGateInfo", [])) as { inForm: boolean; textarea?: boolean; formFields?: GateInput["formFields"]; formName?: string };
  const dets = keySensitivity(key, info);
  await gateDetections(c, t.url, dets, info.formName || "form", info.formFields, "press Enter in");
}
