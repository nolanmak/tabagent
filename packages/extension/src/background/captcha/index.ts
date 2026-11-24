// #61 CAPTCHA wiring: thin adapters from the pure orchestration (pure/solve.ts) to the CDP driver and
// the bridge socket. Holds no decisions. Hooked in with one import line in background/index.ts.
import { TabAgentError, type VisionAnswer } from "@tabagent/protocol";
import { runEval } from "../../pure/jseval";
import { CdpDriver, type Driver } from "../driver";
import { onKilled, registerHandlers } from "../handlerRegistry";
import { onTab, type Ctx, type TabCtx } from "../tabctx";
import { setAutoCaptchaHook } from "./hook";
import { callbackExpression } from "./pure/callback";
import { createCaptchaChannel, type Sender } from "./pure/channel";
import { autoCaptchaStep, solveCaptcha, type ChallengeInfo, type SolveDeps, type WidgetInfo } from "./pure/solve";

// ---------------------------------------------------------------------------
// Bridge wire (index.ts: setCaptchaSender + onCaptchaBridgeMessage)
// ---------------------------------------------------------------------------
let sender: Sender | null = null;
export function setCaptchaSender(fn: Sender) {
  sender = fn;
}
const channel = createCaptchaChannel({ send: (m) => (sender ? sender(m) : false) });
/** True when the message was captcha.token / captcha.vision.answer. */
export function onCaptchaBridgeMessage(msg: unknown): boolean {
  return channel.onMessage(msg);
}
export function rejectAllCaptcha(e: Error) {
  channel.rejectAll(e);
}
onKilled(() => channel.rejectAll(new TabAgentError("KILLED", "The user stopped all agents with the TabAgent kill switch")));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));

function needCdp(drv: Driver): CdpDriver {
  if (drv instanceof CdpDriver) return drv;
  throw new TabAgentError("UNSUPPORTED", "CAPTCHA solving needs full (debugger) mode; this site is in lite mode", "Remove this site from Lite sites in the TabAgent side panel.");
}

// ---------------------------------------------------------------------------
// Page adapter
// ---------------------------------------------------------------------------
type RawWidget = Omit<WidgetInfo, "ref" | "frameKey" | "challengeRef"> & { ref: string | null; challenge?: { ref: string | null } };
interface RawChallenge {
  vendor: ChallengeInfo["vendor"];
  prompt: string;
  kind: ChallengeInfo["kind"];
  rows?: number;
  cols?: number;
  tiles: { ref: string | null }[];
  area: { ref: string | null };
  submit: { ref: string | null } | null;
}

function depsFor(cmdId: string, t: TabCtx): SolveDeps {
  const drv = needCdp(t.drv);
  return {
    now: () => Date.now(),
    sleep,
    async detect() {
      const frames = await drv.callAllFrames("humanCheck", []);
      const widgets: WidgetInfo[] = [];
      let url = t.url;
      for (const f of frames) {
        const v = f.value as { url: string; widgets: RawWidget[] } | null;
        if (f.isMain && v?.url) url = v.url;
        for (const w of v?.widgets ?? []) {
          if (!w.ref) continue;
          const { challenge, ...rest } = w;
          widgets.push({ ...rest, ref: w.ref, frameKey: f.frameKey, ...(challenge?.ref ? { challengeRef: challenge.ref } : {}) });
        }
      }
      return { url, widgets };
    },
    async clickCheckbox(w) {
      const hits = (await drv.callAllFrames("captchaCheckbox", [])).map((f) => f.value as { vendor: string; sitekey: string | null; checked: boolean; ref: string | null } | null).filter((v): v is NonNullable<typeof v> => !!v && v.vendor === w.vendor && !!v.ref);
      const box = hits.find((h) => h.sitekey && h.sitekey === w.sitekey) ?? (hits.length === 1 ? hits[0] : undefined);
      if (box?.checked) return true;
      if (box?.ref) {
        await drv.click(box.ref, { timeout: 3000 });
        return true;
      }
      if (w.vendor === "turnstile" && w.visible) {
        // The checkbox sits in a closed shadow root: click where it is drawn, ~30px from the left edge.
        const r = (await drv.call("rectOf", [], { ref: w.ref })) as { w: number; h: number };
        if (!r?.w) return false;
        await drv.clickAt(w.ref, Math.min(0.5, 30 / r.w), 0.5);
        return true;
      }
      return false;
    },
    requestToken: (req) => channel.solve(cmdId, req),
    async inject(w, token) {
      const r = (await drv.call("captchaInject", [{ vendor: w.vendor, token }], { ref: w.ref })) as { written: number };
      let callback = false;
      // The page's callback lives in its main world. Only for widgets in the top document.
      if (w.frameKey === drv.tab.mainKey()) {
        try {
          const out = await runEval((m, p) => drv.tab.send(m, p), { expression: callbackExpression({ vendor: w.vendor, token, sitekey: w.sitekey, callback: w.callback }), world: "main", frameId: drv.tab.mainFrameId!, timeout: 5000 });
          callback = out.value === true;
        } catch {
          /* the page's callback threw: the field is still written */
        }
      }
      return { written: r?.written ?? 0, callback };
    },
    async challenge(w) {
      for (const f of await drv.callAllFrames("captchaChallenge", [])) {
        const v = f.value as RawChallenge | null;
        if (!v || v.vendor !== w.vendor || !v.area.ref) continue;
        const tiles = v.tiles.map((x) => x.ref);
        if (tiles.some((x) => !x)) continue;
        return { vendor: v.vendor, prompt: v.prompt, kind: v.kind, rows: v.rows, cols: v.cols, tiles: tiles as string[], areaRef: v.area.ref, submitRef: v.submit?.ref ?? null };
      }
      return null;
    },
    async screenshot(ch) {
      const s = await drv.screenshot({ target: "ref", ref: ch.areaRef, format: "jpeg", quality: 85 });
      return { imageBase64: s.dataBase64, mime: "image/jpeg" as const };
    },
    askVision: (round) => channel.vision(cmdId, round),
    async tap(ch: ChallengeInfo, a: VisionAnswer) {
      if ("cells" in a) {
        for (const i of a.cells) {
          const ref = ch.tiles[i];
          if (!ref) continue;
          await drv.click(ref, { timeout: 3000 });
          await sleep(jitter(120, 320));
        }
      } else {
        for (const p of a.points) {
          await drv.clickAt(ch.areaRef, p.x, p.y);
          await sleep(jitter(120, 320));
        }
      }
    },
    async submitChallenge(ch) {
      if (ch.submitRef) await drv.click(ch.submitRef, { timeout: 3000 });
    },
    event: (name, data) => void sender?.({ type: "event", event: name, data }),
  };
}

// ---------------------------------------------------------------------------
// Handlers + autoCaptcha hook
// ---------------------------------------------------------------------------
registerHandlers({
  "captcha.solve": async (c) => onTab(c as Ctx, "act", (t) => solveCaptcha(depsFor(c.cmdId, t), { ref: c.p?.ref })),
});

setAutoCaptchaHook(async (c, t, phase) => {
  try {
    await autoCaptchaStep(depsFor(c.cmdId ?? "", t), phase);
  } catch (e) {
    if (e instanceof TabAgentError && e.code === "CAPTCHA_UNSOLVED") {
      const what = phase === "before" ? `${c.tool.name} was not run: a CAPTCHA blocks it. ` : `${c.tool.name} ran, but a CAPTCHA appeared. `;
      throw new TabAgentError("CAPTCHA_UNSOLVED", what + e.message, e.hint);
    }
    if (e instanceof TabAgentError && (e.code === "KILLED" || e.code === "DIALOG_OPEN")) throw e;
    // Anything else (detection failed, a frame went away) must not break the click itself.
  }
});
