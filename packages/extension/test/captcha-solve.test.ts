// #61 solve orchestration with a stub page and a stub provider (bridge): already solved, free
// trusted-click path, solver token path (inject + callback), vision rounds, fallback order, auto
// hooks, failures as CAPTCHA_UNSOLVED with a reason, and the audit event (never the token).
import { describe, expect, it } from "vitest";
import { captchaReasonOf, type CaptchaToken, type CaptchaVisionAnswer } from "@tabagent/protocol";
import { autoCaptchaStep, solveCaptcha, type SolveDeps, type WidgetInfo, type ChallengeInfo } from "../src/background/captcha/pure/solve";
import { createCaptchaChannel } from "../src/background/captcha/pure/channel";

const TOKEN = "P1_secret_token_value";

function widget(over: Partial<WidgetInfo> = {}): WidgetInfo {
  return { vendor: "hcaptcha", sitekey: "10000000-ffff-ffff-ffff-000000000001", invisible: false, enterprise: false, solved: false, visible: true, challengeVisible: false, ref: "e5", frameKey: "main", ...over };
}

interface Page {
  widgets: WidgetInfo[];
  url: string;
  /** What a checkbox click does. */
  onClick?: (w: WidgetInfo) => void;
  /** What injecting a token does (default: the widget becomes solved). */
  onInject?: (w: WidgetInfo, token: string) => number;
  challenge?: ChallengeInfo | null;
  onTap?: () => void;
}

function stub(page: Page, replies: (Partial<CaptchaToken> | ((req: any) => Partial<CaptchaToken>))[] = [], visionReplies: Partial<CaptchaVisionAnswer>[] = []) {
  let t = 0;
  const log: string[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const requests: any[] = [];
  const rounds: any[] = [];
  const deps: SolveDeps = {
    now: () => t,
    sleep: async (ms) => void (t += ms),
    detect: async () => ({ url: page.url, widgets: page.widgets.map((w) => ({ ...w })) }),
    clickCheckbox: async (w) => {
      log.push(`click ${w.ref}`);
      page.onClick?.(page.widgets.find((x) => x.ref === w.ref)!);
      return true;
    },
    requestToken: async (req) => {
      requests.push(req);
      const r = replies.shift() ?? { ok: false, reason: "no_provider" };
      return { type: "captcha.token", id: "x", ...(typeof r === "function" ? r(req) : r) } as CaptchaToken;
    },
    inject: async (w, token) => {
      log.push(`inject ${w.ref} ${token === TOKEN ? "TOKEN" : token}`);
      const pw = page.widgets.find((x) => x.ref === w.ref)!;
      const n = page.onInject ? page.onInject(pw, token) : ((pw.solved = true), 1);
      return { written: n, callback: !!w.callback };
    },
    challenge: async () => page.challenge ?? null,
    screenshot: async () => ({ imageBase64: "AAAA", mime: "image/png" as const }),
    askVision: async (round) => {
      rounds.push(round);
      return { type: "captcha.vision.answer", id: "v", ok: false, reason: "provider_error", ...(visionReplies.shift() ?? {}) } as CaptchaVisionAnswer;
    },
    tap: async (_ch, ans) => {
      log.push(`tap ${JSON.stringify(ans)}`);
      page.onTap?.();
    },
    submitChallenge: async () => void log.push("submit"),
    event: (name, data) => events.push({ name, data }),
  };
  return { deps, log, events, requests, rounds };
}

const err = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe("solveCaptcha", () => {
  it("already solved: nothing clicked, nothing requested", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ solved: true })] });
    expect(await solveCaptcha(s.deps, {})).toMatchObject({ vendor: "hcaptcha", solved: true, method: "already" });
    expect(s.log).toEqual([]);
    expect(s.requests).toEqual([]);
  });

  it("no widget -> NOT_FOUND", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [] });
    expect((await err(solveCaptcha(s.deps, {}))).code).toBe("NOT_FOUND");
  });

  it("free path: the trusted click solves it; no provider call", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget()], onClick: (w) => (w.solved = true) });
    const r = await solveCaptcha(s.deps, {});
    expect(r).toMatchObject({ method: "click", solved: true });
    expect(s.requests).toEqual([]);
    expect(s.events[0]).toMatchObject({ name: "captcha.solve", data: { vendor: "hcaptcha", origin: "https://shop.test", outcome: "ok", method: "click" } });
  });

  it("solver path: click shows an image challenge, the bridge returns a token, it is injected", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ callback: "onDone" })], onClick: (w) => (w.challengeVisible = true) }, [{ ok: true, token: TOKEN, provider: "capsolver" }]);
    const r = await solveCaptcha(s.deps, {});
    expect(r).toMatchObject({ method: "solver", provider: "capsolver", solved: true });
    expect(s.log).toEqual(["click e5", "inject e5 TOKEN"]);
    expect(s.requests[0]).toMatchObject({ vendor: "hcaptcha", sitekey: "10000000-ffff-ffff-ffff-000000000001", url: "https://shop.test/a", invisible: false, enterprise: false });
    // A challenge appearing ends the 6s poll early.
    expect(JSON.stringify(s.events)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("the click poll lasts about 6s when nothing happens", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget()] }, [{ ok: true, token: TOKEN, provider: "capsolver" }]);
    const t0 = s.deps.now();
    await solveCaptcha(s.deps, {});
    expect(s.deps.now() - t0).toBeGreaterThanOrEqual(6000);
    expect(s.deps.now() - t0).toBeLessThan(7000);
  });

  it("invisible widgets skip the click", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ invisible: true })] }, [{ ok: true, token: TOKEN, provider: "2captcha" }]);
    expect(await solveCaptcha(s.deps, {})).toMatchObject({ method: "solver", provider: "2captcha" });
    expect(s.log).toEqual(["inject e5 TOKEN"]);
    expect(s.requests[0].invisible).toBe(true);
  });

  it("token written but the page does not take it -> not_accepted", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ invisible: true })], onInject: () => 0 }, [{ ok: true, token: TOKEN, provider: "capsolver" }]);
    const e = await err(solveCaptcha(s.deps, {}));
    expect(e.code).toBe("CAPTCHA_UNSOLVED");
    expect(captchaReasonOf(e.message)).toBe("not_accepted");
    expect(s.events[0].data).toMatchObject({ outcome: "error", reason: "not_accepted" });
  });

  it("bridge failure reason becomes the CAPTCHA_UNSOLVED reason", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ invisible: true })] }, [{ ok: false, reason: "provider_balance" }]);
    expect(captchaReasonOf((await err(solveCaptcha(s.deps, {}))).message)).toBe("provider_balance");
  });

  it("arkose is never sent anywhere", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ vendor: "arkose" })] });
    expect(captchaReasonOf((await err(solveCaptcha(s.deps, {}))).message)).toBe("unsupported_vendor");
    expect(s.requests).toEqual([]);
    expect(s.log).toEqual([]);
  });

  it("ref picks that widget; an unknown ref is NOT_FOUND", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ ref: "e1", solved: true }), widget({ ref: "e2", vendor: "turnstile", invisible: true })] }, [{ ok: true, token: TOKEN, provider: "capsolver" }]);
    expect(await solveCaptcha(s.deps, { ref: "e2" })).toMatchObject({ vendor: "turnstile", method: "solver" });
    expect((await err(solveCaptcha(stub({ url: "https://x.test", widgets: [widget()] }).deps, { ref: "e9" }))).code).toBe("NOT_FOUND");
  });

  it("passive reCAPTCHA v3 is not picked automatically", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget({ vendor: "recaptcha", version: "v3", passive: true, invisible: true })] });
    expect((await err(solveCaptcha(s.deps, {}))).code).toBe("NOT_FOUND");
  });
});

describe("vision rounds", () => {
  const grid: ChallengeInfo = { vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3, tiles: ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"], areaRef: "a1", submitRef: "s1" };

  it("bridge hands over to vision; one round taps cells, submits, and solves", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget()], onClick: (w) => (w.challengeVisible = true), challenge: grid };
    page.onTap = () => (page.widgets[0].solved = true);
    const s = stub(page, [{ ok: false, vision: true, rounds: 3, tried: ["capsolver"], reason: "provider_unsupported" }], [{ ok: true, cells: [1, 4] }]);
    const r = await solveCaptcha(s.deps, {});
    expect(r).toMatchObject({ method: "solver", provider: "vision", solved: true });
    expect(s.log).toEqual(["click e5", 'tap {"cells":[1,4]}', "submit"]);
    expect(s.rounds[0]).toMatchObject({ vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3, imageBase64: "AAAA", mime: "image/png" });
  });

  it("gives up after N rounds with reason unsolvable, then resumes the order after vision", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget({ challengeVisible: true })], challenge: grid };
    const s = stub(page, [{ ok: false, vision: true, rounds: 2, tried: [] }, (req) => (expect(req.exclude).toEqual(["vision"]), { ok: false, reason: "no_provider", tried: ["vision"] })], [{ ok: true, cells: [0] }, { ok: true, cells: [2] }]);
    const e = await err(solveCaptcha(s.deps, {}));
    expect(s.rounds).toHaveLength(2);
    expect(captchaReasonOf(e.message)).toBe("unsolvable");
  });

  it("a refusal fails fast (no further rounds) with its reason", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget({ challengeVisible: true })], challenge: grid };
    const s = stub(page, [{ ok: false, vision: true, rounds: 3, tried: [] }, { ok: false, reason: "no_provider" }], [{ ok: false, reason: "vision_refused" }]);
    const e = await err(solveCaptcha(s.deps, {}));
    expect(s.rounds).toHaveLength(1);
    expect(captchaReasonOf(e.message)).toBe("vision_refused");
    expect(s.log).not.toContain("submit");
  });

  it("vision then capsolver: the token provider still gets its turn after vision fails", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget({ challengeVisible: true })], challenge: grid };
    const s = stub(page, [{ ok: false, vision: true, rounds: 1, tried: [] }, { ok: true, token: TOKEN, provider: "capsolver" }], [{ ok: false, reason: "vision_unparseable" }]);
    expect(await solveCaptcha(s.deps, {})).toMatchObject({ provider: "capsolver" });
  });

  it("no challenge to look at -> vision_unsupported", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget({ vendor: "turnstile" })], challenge: null };
    const s = stub(page, [{ ok: false, vision: true, rounds: 3, tried: [] }, { ok: false, reason: "no_provider" }]);
    expect(captchaReasonOf((await err(solveCaptcha(s.deps, {}))).message)).toBe("vision_unsupported");
  });
});

describe("autoCaptchaStep (act.click / form.submit with autoCaptcha)", () => {
  it("before: solves a visible unsolved checkbox widget first", async () => {
    const s = stub({ url: "https://shop.test/a", widgets: [widget()], onClick: (w) => (w.solved = true) });
    expect(await autoCaptchaStep(s.deps, "before")).toMatchObject({ method: "click" });
  });
  it("before: nothing to do on a page without a blocking widget", async () => {
    expect(await autoCaptchaStep(stub({ url: "https://shop.test/a", widgets: [] }).deps, "before")).toBeNull();
    expect(await autoCaptchaStep(stub({ url: "https://shop.test/a", widgets: [widget({ invisible: true })] }).deps, "before")).toBeNull();
    expect(await autoCaptchaStep(stub({ url: "https://shop.test/a", widgets: [widget({ solved: true })] }).deps, "before")).toBeNull();
  });
  it("after: an invisible widget's challenge that the click opened gets solved", async () => {
    const page: Page = { url: "https://shop.test/a", widgets: [widget({ invisible: true, visible: false })] };
    const s = stub(page, [{ ok: true, token: TOKEN, provider: "capsolver" }]);
    // The challenge shows up a moment after the click.
    let n = 0;
    const detect = s.deps.detect;
    s.deps.detect = async () => {
      if (++n === 2) page.widgets[0].challengeVisible = true;
      return detect();
    };
    expect(await autoCaptchaStep(s.deps, "after")).toMatchObject({ method: "solver" });
  });
  it("after: nothing when no challenge appears", async () => {
    expect(await autoCaptchaStep(stub({ url: "https://shop.test/a", widgets: [widget({ invisible: true, visible: false })] }).deps, "after")).toBeNull();
  });
});

describe("createCaptchaChannel", () => {
  it("routes captcha.token / captcha.vision.answer back to the waiting request", async () => {
    const sent: any[] = [];
    const ch = createCaptchaChannel({ send: (m) => (sent.push(m), true), newId: () => `id${sent.length}` });
    const p = ch.solve("cmd1", { vendor: "hcaptcha", sitekey: "k", url: "https://a.test" });
    expect(sent[0]).toMatchObject({ type: "captcha.solve.request", id: "id0", commandId: "cmd1", vendor: "hcaptcha" });
    expect(ch.onMessage({ type: "captcha.token", id: "other", ok: true })).toBe(true);
    expect(ch.onMessage({ type: "captcha.token", id: "id0", ok: true, token: TOKEN, provider: "capsolver" })).toBe(true);
    expect(await p).toMatchObject({ ok: true, token: TOKEN });
    const v = ch.vision("cmd1", { vendor: "hcaptcha", prompt: "p", kind: "grid", rows: 3, cols: 3, imageBase64: "AA", mime: "image/png" });
    ch.onMessage({ type: "captcha.vision.answer", id: "id1", ok: true, cells: [2] });
    expect(await v).toMatchObject({ ok: true, cells: [2] });
    expect(ch.onMessage({ type: "secret" })).toBe(false);
  });
  it("not connected -> bridge_unavailable reply; rejectAll fails pending", async () => {
    const ch = createCaptchaChannel({ send: () => false });
    expect(await ch.solve("c", { vendor: "hcaptcha", sitekey: "k", url: "https://a.test" })).toMatchObject({ ok: false, reason: "bridge_unavailable" });
    const ch2 = createCaptchaChannel({ send: () => true });
    const p = ch2.solve("c", { vendor: "hcaptcha", sitekey: "k", url: "https://a.test" });
    ch2.rejectAll(new Error("KILLED"));
    await expect(p).rejects.toThrow("KILLED");
  });
});
