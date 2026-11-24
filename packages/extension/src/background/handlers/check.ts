// Setting a checkbox/radio/switch, shared by act.check and form.fill.
//
// Custom controls hide the native input (opacity:0, display:none, sr-only clip)
// behind a styled label, and are often framework-controlled (nolanmak/Jarvis#2522).
// Order: a trusted click on the input when it is visible, else on what a user
// would click (label[for] / wrapping label / aria-labelledby caption / ARIA
// wrapper); then, if the state still has not changed, the input's own click(),
// which runs the native activation React's onChange listens to.
import { TabAgentError } from "@tabagent/protocol";
import { sleep } from "../cdp";
import type { Driver } from "../driver";

const POLL_MS = 50;
const POLL_TRIES = 8;

async function checkedNow(drv: Driver, ref: string) {
  return (await drv.call("getChecked", [], { ref })) as boolean | null;
}

/** Wait briefly for a framework re-render to land the new state. */
async function settled(drv: Driver, ref: string, want: boolean) {
  let v = await checkedNow(drv, ref);
  for (let i = 0; i < POLL_TRIES && v !== null && v !== want; i++) {
    await sleep(POLL_MS);
    v = await checkedNow(drv, ref);
  }
  return v;
}

const notActionable = (e: unknown) => e instanceof TabAgentError && e.code === "NOT_ACTIONABLE";

export type CheckResult =
  | { checked: boolean; changed: boolean; verified: true }
  | { checked: null; changed: "unknown"; verified: false; warning: string };

export async function setCheckState(drv: Driver, ref: string, checked: boolean, timeout?: number): Promise<CheckResult> {
  const cur = await checkedNow(drv, ref);
  if (cur === checked) return { checked, changed: false, verified: true };
  const inf = (await drv.call("info", [], { ref })) as { visible: boolean; tag?: string };
  let lastErr: unknown = new TabAgentError("NOT_ACTIONABLE", `${ref} is not actionable (reason: hidden)`);
  let clicked = false;
  if (inf.visible) {
    try {
      await drv.click(ref, { timeout: timeout ?? 2000 });
      clicked = true;
    } catch (e) {
      if (!notActionable(e)) throw e;
      lastErr = e;
    }
  }
  if (!clicked) {
    const lab = (await drv.call("labelFor", [], { ref })) as { ref: string | null } | null;
    if (lab?.ref) {
      try {
        await drv.click(lab.ref, { timeout });
        clicked = true;
      } catch (e) {
        if (!notActionable(e)) throw e;
        lastErr = e;
      }
    }
  }
  let after = clicked ? await settled(drv, ref, checked) : cur;
  if (after !== checked && (await drv.call("clickEl", [], { ref }))) {
    clicked = true;
    after = await settled(drv, ref, checked);
  }
  if (!clicked) throw lastErr;
  if (after !== null && after !== checked) throw new TabAgentError("NOT_ACTIONABLE", `${ref} did not change to checked=${checked}`, "The page controls this input; take a page.snapshot and act.click the control the page shows for it.");
  // #59: a custom control with no native input or aria-checked can't be read
  // back. Never report it as checked; say the click is unverified.
  if (after === null)
    return {
      checked: null,
      changed: "unknown",
      verified: false,
      warning: `Clicked ${ref}, but can't read its checked state (no native input or aria-checked). Confirm with page.screenshot ref=${ref} before submitting; a disabled Submit usually means it is still unchecked.`,
    };
  return { checked: after, changed: true, verified: true };
}
