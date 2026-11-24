// @vitest-environment happy-dom
// #61 pagelib CAPTCHA helpers on the fixture pages, with the markup each vendor's script renders
// added by hand (scripts are stripped): detection, solved state, token injection, checkbox and
// challenge discovery inside the vendor frames, and the main-world callback expression.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { captchaChallenge, captchaCheckbox, captchaInject, humanCheck } from "../src/pagelib/captcha";
import { callbackExpression } from "../src/background/captcha/pure/callback";

const FIX = join(__dirname, "../../../e2e/fixtures");
function load(html: string) {
  document.open();
  document.write(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  document.close();
}
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const H_KEY = "10000000-ffff-ffff-ffff-000000000001";
const R_KEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
const T_KEY = "3x00000000000000000000FF";

/** What each vendor's api.js adds inside the container. */
function renderH(container: Element, opts: { size?: string } = {}) {
  container.innerHTML = `<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0x1&host=shop.test&sentry=true&sitekey=${H_KEY}${opts.size ? `&size=${opts.size}` : ""}" style="width:303px;height:78px" data-hcaptcha-widget-id="0x1" data-hcaptcha-response=""></iframe><textarea id="g-recaptcha-response-0x1" name="g-recaptcha-response" style="display:none"></textarea><textarea id="h-captcha-response-0x1" name="h-captcha-response" style="display:none"></textarea>`;
}
function renderR(container: Element) {
  container.innerHTML = `<div style="width:304px;height:78px"><div><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${R_KEY}&co=aHR0cHM6&hl=en&v=x&size=normal&cb=y" width="304" height="78"></iframe></div><textarea id="g-recaptcha-response" name="g-recaptcha-response" class="g-recaptcha-response" style="display:none"></textarea></div>`;
}
function renderT(container: Element) {
  // The iframe sits in a closed shadow root; only the hidden input is in the light DOM.
  container.attachShadow({ mode: "closed" }).innerHTML = `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/${T_KEY}/auto/fbE/new/normal/auto/"></iframe>`;
  container.insertAdjacentHTML("beforeend", `<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-x_response" value="">`);
}

/** happy-dom has no layout: give elements a box so isVisible() sees them. */
beforeEach(() => {
  (Element.prototype as any).getBoundingClientRect = function () {
    const st = (this as HTMLElement).style;
    if (st?.display === "none") return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    return { x: 10, y: 10, width: 300, height: 78, top: 10, left: 10, right: 310, bottom: 88 };
  };
});

describe("humanCheck", () => {
  it("finds an hCaptcha widget with site key, callback and unsolved state", () => {
    load(fixture("captcha-hcaptcha.html"));
    renderH(document.querySelector(".h-captcha")!);
    const r = humanCheck(null);
    expect(r.value.widgets).toHaveLength(1);
    const w = r.value.widgets[0];
    expect(w).toMatchObject({ vendor: "hcaptcha", sitekey: H_KEY, invisible: false, enterprise: false, callback: "onCaptchaDone", solved: false, visible: true });
    expect(r.elements[w.el]).toBe(document.querySelector(".h-captcha"));
  });
  it("solved once the response field has a value", () => {
    load(fixture("captcha-hcaptcha.html"));
    renderH(document.querySelector(".h-captcha")!);
    (document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement).value = "P1_eyJ0";
    expect(humanCheck(null).value.widgets[0].solved).toBe(true);
  });
  it("reCAPTCHA v2 from the container and its anchor frame", () => {
    load(fixture("captcha-recaptcha.html"));
    renderR(document.querySelector(".g-recaptcha")!);
    const w = humanCheck(null).value.widgets;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ vendor: "recaptcha", sitekey: R_KEY, version: "v2", invisible: false, enterprise: false, callback: "onRecaptcha", solved: false });
  });
  it("reCAPTCHA enterprise / invisible flags from the anchor URL; an iframe with no container still counts", () => {
    load(`<div><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?k=6LfENTERPRISEkey000000000000000000000&size=invisible"></iframe><textarea name="g-recaptcha-response"></textarea></div>`);
    const w = humanCheck(null).value.widgets[0];
    expect(w).toMatchObject({ vendor: "recaptcha", sitekey: "6LfENTERPRISEkey000000000000000000000", enterprise: true, invisible: true });
  });
  it("reCAPTCHA v3 (render=<key>) is reported as passive", () => {
    load(`<html><head></head><body><div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=6Lv3key&size=invisible"></iframe><textarea name="g-recaptcha-response"></textarea></div></body></html>`);
    const s = document.createElement("script");
    s.setAttribute("src", "https://www.google.com/recaptcha/api.js?render=6Lv3key");
    document.head.appendChild(s);
    expect(humanCheck(null).value.widgets[0]).toMatchObject({ vendor: "recaptcha", version: "v3", passive: true });
  });
  it("Turnstile: site key, action from data-*, response input in the light DOM", () => {
    load(fixture("captcha-turnstile.html"));
    renderT(document.querySelector(".cf-turnstile")!);
    const w = humanCheck(null).value.widgets;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ vendor: "turnstile", sitekey: T_KEY, action: "signup", callback: "onTurnstile", solved: false });
  });
  it("Arkose is detected (never solved); Persona / Trulioo identity frames are not CAPTCHAs", () => {
    load(`<iframe src="https://client-api.arkoselabs.com/fc/gc/?token=1&pk=476068BF-9607-4799-B53D-966BE98E2B81"></iframe><iframe src="https://withpersona.com/verify?inquiry-id=x"></iframe><iframe src="https://trulioo.com/docv"></iframe>`);
    const w = humanCheck(null).value.widgets;
    expect(w.map((x) => x.vendor)).toEqual(["arkose"]);
    expect(w[0].sitekey).toBe("476068BF-9607-4799-B53D-966BE98E2B81");
  });
  it("challengeVisible when the vendor's image challenge frame is showing", () => {
    load(fixture("captcha-hcaptcha.html"));
    renderH(document.querySelector(".h-captcha")!);
    document.body.insertAdjacentHTML("beforeend", `<div><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0x1&sitekey=${H_KEY}"></iframe></div>`);
    const r = humanCheck(null);
    expect(r.value.widgets).toHaveLength(1);
    expect(r.value.widgets[0].challengeVisible).toBe(true);
    expect(r.elements[r.value.widgets[0].challenge!.el].tagName).toBe("IFRAME");
  });
  it("self narrows to the widget that is or contains the ref", () => {
    load(`<div class="h-captcha" data-sitekey="${H_KEY}"></div><div class="g-recaptcha" data-sitekey="${R_KEY}"></div>`);
    renderH(document.querySelector(".h-captcha")!);
    renderR(document.querySelector(".g-recaptcha")!);
    expect(humanCheck(null).value.widgets).toHaveLength(2);
    expect(humanCheck(document.querySelector(".g-recaptcha iframe")).value.widgets.map((w) => w.vendor)).toEqual(["recaptcha"]);
  });
  it("no widgets on a plain page", () => {
    load(fixture("form.html"));
    expect(humanCheck(null).value.widgets).toEqual([]);
  });
});

describe("captchaInject", () => {
  it("hCaptcha: writes both response fields and the iframe attribute", () => {
    load(fixture("captcha-hcaptcha.html"));
    const c = document.querySelector(".h-captcha")!;
    renderH(c);
    const events: string[] = [];
    c.querySelector('[name="h-captcha-response"]')!.addEventListener("change", () => events.push("change"));
    expect(captchaInject(c, { vendor: "hcaptcha", token: "P1_tok" }).value).toEqual({ written: 2 });
    expect((c.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement).value).toBe("P1_tok");
    expect((c.querySelector('[name="g-recaptcha-response"]') as HTMLTextAreaElement).value).toBe("P1_tok");
    expect(c.querySelector("iframe")!.getAttribute("data-hcaptcha-response")).toBe("P1_tok");
    expect(events).toEqual(["change"]);
    expect(humanCheck(null).value.widgets[0].solved).toBe(true);
  });
  it("Turnstile: fills the hidden input; creates it when the widget has none", () => {
    load(fixture("captcha-turnstile.html"));
    const c = document.querySelector(".cf-turnstile")!;
    expect(captchaInject(c, { vendor: "turnstile", token: "0.tt" }).value.written).toBe(1);
    expect((c.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement).value).toBe("0.tt");
  });
  it("reCAPTCHA: fills g-recaptcha-response", () => {
    load(fixture("captcha-recaptcha.html"));
    const c = document.querySelector(".g-recaptcha")!;
    renderR(c);
    expect(captchaInject(c, { vendor: "recaptcha", token: "03AF" }).value.written).toBe(1);
    expect((document.getElementById("g-recaptcha-response") as HTMLTextAreaElement).value).toBe("03AF");
  });
});

describe("in the vendor frames", () => {
  it("captchaCheckbox finds the hCaptcha checkbox and reports the frame's site key", () => {
    load(`<div id="checkbox" role="checkbox" aria-checked="false" tabindex="0"></div>`);
    const r = captchaCheckbox(null, `https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox&sitekey=${H_KEY}`);
    expect(r.value).toMatchObject({ vendor: "hcaptcha", sitekey: H_KEY, checked: false });
    expect(r.elements[r.value!.el]).toBe(document.getElementById("checkbox"));
  });
  it("captchaCheckbox finds the reCAPTCHA anchor and reads aria-checked", () => {
    load(`<span id="recaptcha-anchor" role="checkbox" aria-checked="true"></span>`);
    expect(captchaCheckbox(null, `https://www.google.com/recaptcha/api2/anchor?k=${R_KEY}`).value).toMatchObject({ vendor: "recaptcha", sitekey: R_KEY, checked: true });
  });
  it("captchaCheckbox is null outside a vendor checkbox frame", () => {
    load(`<div id="checkbox" role="checkbox"></div>`);
    expect(captchaCheckbox(null, "https://shop.test/").value).toBeNull();
    expect(captchaCheckbox(null, `https://newassets.hcaptcha.com/x.html#frame=challenge&sitekey=${H_KEY}`).value).toBeNull();
  });
  it("captchaChallenge reads an hCaptcha grid: prompt, 3x3 tiles, submit", () => {
    const tiles = Array.from({ length: 9 }, (_, i) => `<div class="task-image" data-i="${i}"></div>`).join("");
    load(`<div class="challenge-view"><div class="prompt-text"><span>Please click each image containing a bus</span></div><div class="task-grid">${tiles}</div></div><div class="button-submit" role="button">Next</div>`);
    // A 3x3 layout: tile i at column i%3, row i/3.
    document.querySelectorAll(".task-image").forEach((el, i) => ((el as any).getBoundingClientRect = () => ({ x: (i % 3) * 100, y: Math.floor(i / 3) * 100, left: (i % 3) * 100, top: Math.floor(i / 3) * 100, width: 95, height: 95, right: 0, bottom: 0 })));
    const r = captchaChallenge(null, `https://newassets.hcaptcha.com/x.html#frame=challenge&sitekey=${H_KEY}`);
    expect(r.value).toMatchObject({ vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3 });
    expect(r.value!.tiles).toHaveLength(9);
    expect(r.elements[r.value!.tiles[4].el].getAttribute("data-i")).toBe("4");
    expect(r.elements[r.value!.submit!.el].className).toBe("button-submit");
    expect(r.elements[r.value!.area.el].className).toBe("challenge-view");
  });
  it("captchaChallenge reads an hCaptcha canvas round", () => {
    load(`<div class="challenge-view"><h2 class="prompt-text">Tap on the thing you see in a coffee shop</h2><canvas width="500" height="500"></canvas></div><div class="button-submit">Verify</div>`);
    const r = captchaChallenge(null, `https://newassets.hcaptcha.com/x.html#frame=challenge`);
    expect(r.value).toMatchObject({ kind: "canvas", prompt: "Tap on the thing you see in a coffee shop" });
    expect(r.elements[r.value!.area.el].tagName).toBe("CANVAS");
  });
  it("captchaChallenge reads a reCAPTCHA image grid", () => {
    const row = (n: number) => `<tr>${Array.from({ length: 4 }, (_, i) => `<td class="rc-imageselect-tile" data-i="${n * 4 + i}"></td>`).join("")}</tr>`;
    load(`<div class="rc-imageselect-challenge"><div class="rc-imageselect-desc-wrapper"><div class="rc-imageselect-desc">Select all squares with <strong>traffic lights</strong></div></div><table class="rc-imageselect-table-44"><tbody>${[0, 1, 2, 3].map(row).join("")}</tbody></table></div><button id="recaptcha-verify-button">Verify</button>`);
    const r = captchaChallenge(null, `https://www.google.com/recaptcha/api2/bframe?k=${R_KEY}`);
    expect(r.value).toMatchObject({ vendor: "recaptcha", kind: "grid", rows: 4, cols: 4, prompt: "Select all squares with traffic lights" });
    expect(r.value!.tiles).toHaveLength(16);
  });
});

describe("callbackExpression", () => {
  it("calls a data-callback by dotted name with the token, and is a single expression", () => {
    const calls: string[] = [];
    (globalThis as any).app = { cb: (t: string) => calls.push(t) };
    const fired = (0, eval)(callbackExpression({ vendor: "hcaptcha", token: "P1_x", callback: "app.cb", sitekey: H_KEY }));
    expect(fired).toBe(true);
    expect(calls).toEqual(["P1_x"]);
    delete (globalThis as any).app;
  });
  it("finds a reCAPTCHA explicit-render callback in ___grecaptcha_cfg by site key", () => {
    const calls: string[] = [];
    (globalThis as any).___grecaptcha_cfg = { clients: { 0: { aa: { bb: { sitekey: R_KEY, callback: (t: string) => calls.push(t) } } } } };
    expect((0, eval)(callbackExpression({ vendor: "recaptcha", token: "03AF", sitekey: R_KEY }))).toBe(true);
    expect(calls).toEqual(["03AF"]);
    delete (globalThis as any).___grecaptcha_cfg;
  });
  it("ignores callback names that are not identifiers (no code injection)", () => {
    const expr = callbackExpression({ vendor: "turnstile", token: "t", callback: "alert(1)", sitekey: T_KEY });
    expect(expr).not.toContain("alert(1)");
    expect((0, eval)(expr)).toBe(false);
  });
  it("the token is embedded as a JSON string literal", () => {
    const expr = callbackExpression({ vendor: "hcaptcha", token: 'a"b\\c', sitekey: H_KEY });
    expect(expr).toContain(JSON.stringify('a"b\\c'));
  });
});
