// Dynamic D18 (a)/(b) gates and the integration points with the router (agent B).
// Every sensitive path in the extension goes through sensitiveGate().
import type { SessionMeta } from "@tabagent/protocol";
import { keySensitivity, submitsOnKey, submitConfirmation, submitSensitivity, type Detection, type FieldLike } from "../../pure/sensitive";
import { resolveFiles } from "../bridgeFiles";
import { requireSensitive } from "../permissions";
import type { Ctx, TabCtx } from "./ctx";

export type Category = "a" | "b" | "c" | "d" | "e" | "f";

/** Ask the user (unless pre-approved for this origin + category, or devAllowSensitive is on). */
export async function sensitiveGate(meta: SessionMeta, url: string, category: Exclude<Category, "f">, tool: string, summary: string, reasons: string[]) {
  await requireSensitive(meta, url, category, tool, summary, reasons);
}

/**
 * Static categories (c, d, e) are gated by the router from the registry `sensitive`
 * field (D17/D18) before the handler runs, so handlers must not ask again.
 */
export const HANDLERS_GATE_STATIC = false;

export async function staticGate(c: Ctx, url: string, category: Exclude<Category, "f">, summary: string, reasons: string[]) {
  if (HANDLERS_GATE_STATIC) await sensitiveGate(c.meta, url, category, c.tool.name, summary, reasons);
}

/** Upload paths -> canonical paths, validated by the bridge against uploadDirs (#11, D31). */
export async function canonicalUploadPaths(c: Ctx, paths: string[]): Promise<string[]> {
  if (!c.cmdId) return paths; // a bridge without files.resolve validated them before sending
  return resolveFiles(c.cmdId, paths);
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

/** act.click / act.dblclick / extract.paginate hops: D18(a) submit control of a sensitive form, D18(b) keywords. */
export async function checkClickGate(c: Ctx, t: TabCtx, ref: string) {
  const info = (await t.drv.call("clickGateInfo", [], { ref })) as GateInput;
  const dets = submitSensitivity(info);
  await gateDetections(c, t.url, dets, info.name || ref, info.formFields, "click");
}

type KeyInfo = { inForm: boolean; textarea?: boolean; formFields?: GateInput["formFields"]; formName?: string; focusInFrame?: boolean; hasFocus?: boolean };

/**
 * act.press / act.type (submit, or text with a newline): D18(a) Enter inside a sensitive form,
 * keyed on the effect (review H3). Any chord that resolves to Enter counts, and the form is looked
 * up in the frame that has the focus: the ref's frame when one is given, else the main frame, else
 * (focus inside an iframe) the subframe whose document holds the focus. A frame TabAgent cannot
 * inspect fails closed.
 */
export async function checkKeyGate(c: Ctx, t: TabCtx, key: string, ref?: string) {
  if (!submitsOnKey(key)) return;
  const main = (await t.drv.call("keyGateInfo", [], ref ? { ref } : undefined)) as KeyInfo;
  if (!main.focusInFrame || t.drv.kind !== "cdp") {
    const dets = keySensitivity(key, main);
    return gateDetections(c, t.url, dets, main.formName || "form", main.formFields, "press Enter in");
  }
  const subs = (await t.drv.callAllFrames("keyGateInfo", [])).filter((f) => !f.isMain).map((f) => f.value as KeyInfo);
  const holders = subs.filter((i) => i.hasFocus && !i.focusInFrame);
  const candidates = holders.length ? holders : subs.filter((i) => i.inForm);
  if (!candidates.length) {
    return gateDetections(c, t.url, [{ category: "a", reason: "Enter inside an embedded frame TabAgent cannot inspect; it may submit a password or card form" }], "embedded frame", undefined, "press Enter in");
  }
  for (const info of candidates) {
    const dets = keySensitivity(key, info);
    if (dets.length) return gateDetections(c, t.url, dets, info.formName || "form", info.formFields, "press Enter in");
  }
}
