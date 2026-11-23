// Dynamic D18 (a)/(b) gates and the integration points with the router (agent B).
// Every sensitive path in the extension goes through sensitiveGate().
import type { SessionMeta } from "@tabagent/protocol";
import { keySensitivity, submitConfirmation, submitSensitivity, type Detection, type FieldLike } from "../../pure/sensitive";
import { requireSensitive } from "../permissions";
import type { Ctx, TabCtx } from "./ctx";

export type Category = "a" | "b" | "c" | "d" | "e" | "f";

/**
 * Ask the user (unless pre-approved for this origin + category). Integration point:
 * once agent B's permissions.ts lands this becomes
 * `requireSensitive(meta, url, category, tool, summary, reasons)`.
 */
export async function sensitiveGate(meta: SessionMeta, url: string, category: Category, tool: string, summary: string, reasons: string[]) {
  void category;
  await requireSensitive(meta, url, tool, summary, reasons);
}

/**
 * Static categories (c, d, e) are gated by the router from the registry (D17/D18).
 * Until that router lands on this branch, handlers gate them here. Set to false when
 * the router's static gate is in place, or users get asked twice.
 */
export const HANDLERS_GATE_STATIC = true;

export async function staticGate(c: Ctx, url: string, category: Category, summary: string, reasons: string[]) {
  if (HANDLERS_GATE_STATIC) await sensitiveGate(c.meta, url, category, c.tool.name, summary, reasons);
}

/** Upload paths -> canonical paths from the bridge (#11). Integration point: agent B's resolveFiles(cmdId, paths). */
export async function canonicalUploadPaths(_c: Ctx, paths: string[]): Promise<string[]> {
  // On this branch the bridge validates act.upload paths before sending the command.
  return paths;
}

interface GateInput {
  role?: string;
  name?: string;
  isSubmit?: boolean;
  formFields?: (FieldLike & { value?: string })[];
}

async function gateDetections(c: Ctx, t: TabCtx, dets: Detection[], label: string, fields: GateInput["formFields"], action: string) {
  for (const cat of ["a", "b"] as const) {
    const hits = dets.filter((d) => d.category === cat);
    if (!hits.length) continue;
    const conf = cat === "a" && fields ? submitConfirmation({ control: label, fields }) : { summary: `${action} "${label.slice(0, 60)}"`, reasons: [] as string[] };
    await sensitiveGate(c.meta, t.url, cat, c.tool.name, conf.summary, [...hits.map((h) => h.reason), ...conf.reasons]);
  }
}

/** act.click / act.dblclick / extract.paginate hops: D18(a) submit control of a sensitive form, D18(b) keywords. */
export async function checkClickGate(c: Ctx, t: TabCtx, ref: string) {
  const info = (await t.drv.call("clickGateInfo", [], { ref })) as GateInput;
  const dets = submitSensitivity(info);
  if (dets.length) await gateDetections(c, t, dets, info.name || ref, info.formFields, "click");
}

/** act.press / act.type submit=true: D18(a) Enter inside a sensitive form. */
export async function checkKeyGate(c: Ctx, t: TabCtx, key: string) {
  if (!/enter$/i.test(key)) return;
  const info = (await t.drv.call("keyGateInfo", [])) as { inForm: boolean; textarea?: boolean; formFields?: GateInput["formFields"]; formName?: string };
  const dets = keySensitivity(key, info);
  if (dets.length) await gateDetections(c, t, dets, info.formName || "form", info.formFields, "press Enter in");
}
