// act.* (except act.upload) — #7. Every action goes through act(): auto-wait in
// the driver, then the D14 side-effect report (diff / navigation / dialogs).
import { taErr } from "../errors";
import { act, onTab, type Ctx, type TabCtx } from "../tabctx";
import { checkClickGate, checkKeyGate } from "./gates";
import { pollUntil } from "../wait";
import { textSubmits } from "../../pure/sensitive";
import { setCheckState } from "./check";
import { autoCaptcha } from "../captcha/hook";
import { blockersAfterSubmit, disabledSubmitError } from "./blockers";

type Handler = (c: Ctx) => Promise<unknown>;

const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

// D18(a)(b) gates live in ./gates (agent C2): a click on a sensitive form's
// submit control or a purchase/delete/send/transfer control, and Enter inside a
// sensitive form, go to the same gate as form.submit.

// ---------------------------------------------------------------------------
// select / check (shared with form.fill)
// ---------------------------------------------------------------------------
export async function doSelect(t: TabCtx, ref: string, values: string[], timeout?: number) {
  const inf = (await t.drv.call("info", [], { ref })) as { isSelect: boolean; role: string };
  if (inf.isSelect) {
    const r = (await t.drv.call("selectOptions", [values], { ref })) as { selected?: string[]; error?: string };
    if (r.error) throw taErr("NOT_FOUND", r.error, undefined, { pageText: true });
    return r.selected;
  }
  // ARIA combobox/listbox: open it, then click the options
  const picked: string[] = [];
  await t.drv.click(ref, { timeout });
  for (const v of values) {
    let found: { ref: string; name: string } | null = null;
    const ok = await pollUntil(
      async () => {
        const res = await t.drv.find({ by: "role", value: "option", name: v });
        for (const m of res.matches) {
          const vis = (await t.drv.call("info", [], { ref: m.ref })) as { visible: boolean };
          if (vis.visible) {
            found = m;
            return true;
          }
        }
        return false;
      },
      timeout ?? 3000,
      clock,
      100,
    );
    if (!ok || !found) throw taErr("NOT_FOUND", `No visible option "${v}" after opening ${ref}`, "Take a page.snapshot to see the options, then act.click the option.");
    const f = found as { ref: string; name: string };
    await t.drv.click(f.ref, { timeout });
    picked.push(f.name);
  }
  return picked;
}

export async function doCheck(t: TabCtx, ref: string, checked: boolean, timeout?: number) {
  return setCheckState(t.drv, ref, checked, timeout);
}

export const actHandlers: Record<string, Handler> = {
  async "act.click"(c) {
    let submit = false;
    const res = await act(c, "act", async (t) => {
      await checkClickGate(c, t, c.p.ref);
      // A hidden native checkbox/radio (custom control): click what a user would, its label (Jarvis#2522).
      const alt = (await t.drv.call("toggleTarget", [], { ref: c.p.ref })) as { ref: string | null } | null;
      // #61: with autoCaptcha on, a blocking CAPTCHA is solved before the click and after it.
      await autoCaptcha(c, t, "before");
      // #64: a submit/Continue button; if it is disabled or ignored, say which fields block it.
      submit = !alt?.ref && (await t.drv.call("submitLike", [], { ref: c.p.ref }).catch(() => false)) === true;
      let r: Awaited<ReturnType<typeof t.drv.click>>;
      try {
        r = await t.drv.click(alt?.ref ?? c.p.ref, { button: c.p.button, clickCount: c.p.clickCount, modifiers: c.p.modifiers, timeout: c.p.timeout });
      } catch (e) {
        throw submit ? await disabledSubmitError(t, c.p.ref, e) : e;
      }
      if (!r.dialog) await autoCaptcha(c, t, "after");
      return r;
    });
    return submit ? blockersAfterSubmit(c, res, c.p.ref) : res;
  },
  async "act.dblclick"(c) {
    return act(c, "act", async (t) => {
      await checkClickGate(c, t, c.p.ref);
      return t.drv.click(c.p.ref, { clickCount: 2, timeout: c.p.timeout });
    });
  },
  async "act.hover"(c) {
    return act(c, "act", async (t) => {
      await t.drv.hover(c.p.ref, c.p.timeout);
    });
  },
  async "act.type"(c) {
    return act(c, "act", async (t) => {
      if (c.p.ref) {
        await t.drv.prepareInput(c.p.ref, c.p.timeout);
        if (c.p.clear) await t.drv.fill(c.p.ref, "", c.p.timeout);
        await t.drv.focus(c.p.ref, true);
      }
      // D18(a) by effect (review H3): every newline in text is a real Enter, so gate before typing.
      if (c.p.submit || textSubmits(String(c.p.text ?? ""))) await checkKeyGate(c, t, "Enter", c.p.ref);
      const r = await t.drv.typeText(c.p.text);
      if (r.dialog) return r;
      if (c.p.submit) return t.drv.press("Enter");
      return r;
    });
  },
  async "act.fill"(c) {
    return act(c, "act", async (t) => {
      const inf = (await t.drv.call("info", [], { ref: c.p.ref })) as { isSelect: boolean };
      if (inf.isSelect) {
        await doSelect(t, c.p.ref, [c.p.value], c.p.timeout);
        return;
      }
      await t.drv.fill(c.p.ref, c.p.value, c.p.timeout);
    });
  },
  async "act.press"(c) {
    return act(c, "act", async (t) => {
      if (c.p.ref) await t.drv.focus(c.p.ref, true);
      await checkKeyGate(c, t, c.p.key, c.p.ref);
      return t.drv.press(c.p.key);
    });
  },
  async "act.select"(c) {
    let selected: unknown;
    return act(
      c,
      "act",
      async (t) => {
        selected = await doSelect(t, c.p.ref, c.p.values, c.p.timeout);
      },
      () => ({ selected }),
    );
  },
  async "act.check"(c) {
    let res: unknown;
    return act(
      c,
      "act",
      async (t) => {
        res = await doCheck(t, c.p.ref, c.p.checked ?? true, c.p.timeout);
      },
      () => ({ result: res }),
    );
  },
  async "act.scroll"(c) {
    return onTab(c, "read", async (t) => ({ ok: true, position: await t.drv.scroll(c.p.ref, c.p.dx ?? 0, c.p.dy ?? 0) }));
  },
  async "act.drag"(c) {
    return act(c, "act", async (t) => {
      await t.drv.drag(c.p.from, c.p.to, c.p.timeout);
    });
  },
};
