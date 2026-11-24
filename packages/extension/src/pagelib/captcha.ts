// pagelib side of #61 CAPTCHA solving. Runs in the isolated world like the rest of pagelib.
//
//   humanCheck()      page frames: find hCaptcha / reCAPTCHA / Turnstile / Arkose widgets, their site
//                     key and flags, and whether each is solved (its response field has a value).
//   captchaCheckbox() vendor checkbox frames: the checkbox to give a trusted click.
//   captchaChallenge() vendor challenge frames: prompt text, tile grid or canvas, submit (vision path).
//   captchaInject()   page frames: write a solver token into the widget's response field(s).
//
// Identity checks (Persona, Trulioo, document / selfie liveness) are deliberately not recognised.
import { isVisible, norm, textOf, walk, type El, type Ret } from "./index";

export type Vendor = "hcaptcha" | "recaptcha" | "turnstile" | "arkose";

export interface Widget {
  vendor: Vendor;
  sitekey: string | null;
  invisible: boolean;
  enterprise: boolean;
  /** reCAPTCHA only. */
  version?: "v2" | "v3";
  /** reCAPTCHA v3: score-based, nothing to click; only solved on request. */
  passive?: boolean;
  action?: string;
  cdata?: string;
  /** data-callback: a global function name (dotted path) the page wants called with the token. */
  callback?: string;
  solved: boolean;
  visible: boolean;
  challengeVisible: boolean;
  /** The container (or the widget iframe when there is none). Mapped to `ref` by the background. */
  el: number;
  /** The vendor's challenge iframe, when one is in this document. */
  challenge?: { el: number };
}

const FIELD: Record<Vendor, string[]> = {
  hcaptcha: ["h-captcha-response", "g-recaptcha-response"],
  recaptcha: ["g-recaptcha-response"],
  turnstile: ["cf-turnstile-response"],
  arkose: ["fc-token", "verification-token"],
};
const CONTAINER_SEL = ".h-captcha, .g-recaptcha, .cf-turnstile, [data-hcaptcha-widget-id]:not(iframe)";
const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,4}$/;

interface FrameHit {
  vendor: Vendor;
  role: "widget" | "challenge";
  sitekey: string | null;
  invisible: boolean;
  enterprise: boolean;
}

/** Classify a vendor iframe URL. null for anything else (including identity-check vendors). */
export function classifyFrameUrl(src: string): FrameHit | null {
  let u: URL;
  try {
    u = new URL(src, "https://x.invalid/");
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
  const q = u.searchParams;
  if (/(^|\.)hcaptcha\.com$/.test(host)) {
    const frame = hash.get("frame") ?? q.get("frame");
    if (frame !== "checkbox" && frame !== "challenge") return null;
    return { vendor: "hcaptcha", role: frame === "checkbox" ? "widget" : "challenge", sitekey: hash.get("sitekey") ?? q.get("sitekey"), invisible: (hash.get("size") ?? q.get("size")) === "invisible", enterprise: false };
  }
  if (/(^|\.)(google\.com|recaptcha\.net)$/.test(host) && /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/.test(u.pathname)) {
    return { vendor: "recaptcha", role: /\/anchor/.test(u.pathname) ? "widget" : "challenge", sitekey: q.get("k"), invisible: q.get("size") === "invisible", enterprise: /\/enterprise\//.test(u.pathname) };
  }
  if (host === "challenges.cloudflare.com") {
    const m = /\/(0x[A-Za-z0-9_-]{10,}|[123]x0{20}[A-Z]{2}|[123]x0{20}FF)\//.exec(u.pathname);
    return { vendor: "turnstile", role: "widget", sitekey: m ? m[1] : null, invisible: /\/invisible\//.test(u.pathname), enterprise: false };
  }
  if (/(^|\.)(arkoselabs\.com|funcaptcha\.com)$/.test(host)) {
    const pk = q.get("pk") ?? hash.get("pk") ?? /\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i.exec(u.pathname)?.[1] ?? null;
    return { vendor: "arkose", role: "widget", sitekey: pk, invisible: false, enterprise: false };
  }
  return null;
}

function vendorOfContainer(el: El): Vendor | null {
  const c = el.classList;
  if (c.contains("h-captcha") || el.hasAttribute("data-hcaptcha-widget-id")) return "hcaptcha";
  if (c.contains("g-recaptcha")) return "recaptcha";
  if (c.contains("cf-turnstile")) return "turnstile";
  return null;
}

/** Response fields of a widget: inside the container, or near the iframe (up to 3 ancestors). */
function fieldsOf(root: El, vendor: Vendor): (HTMLInputElement | HTMLTextAreaElement)[] {
  const names = FIELD[vendor];
  const sel = names.map((n) => `[name="${n}"]`).join(",");
  const custom = root.getAttribute("data-response-field-name");
  const all = (r: El) => Array.from(r.querySelectorAll<HTMLInputElement>(custom ? `${sel},[name="${custom.replace(/"/g, "")}"]` : sel));
  let cur: El | null = root;
  for (let i = 0; i < 4 && cur; i++) {
    const hit = all(cur);
    if (hit.length) return hit;
    if (cur.matches(CONTAINER_SEL)) break;
    cur = cur.parentElement;
  }
  return [];
}

function isSolved(root: El, vendor: Vendor, frame?: El | null): boolean {
  if (fieldsOf(root, vendor).some((f) => norm(f.value).length > 0)) return true;
  const attr = frame?.getAttribute("data-hcaptcha-response");
  return !!attr && attr.length > 0;
}

function v3Keys(): Set<string> {
  const out = new Set<string>();
  for (const s of Array.from(document.querySelectorAll("script[src]"))) {
    const m = /\/recaptcha\/(?:api|enterprise)\.js\?(?:[^#]*&)?render=([^&#]+)/.exec(s.getAttribute("src") ?? "");
    if (m && m[1] !== "explicit") out.add(decodeURIComponent(m[1]));
  }
  return out;
}

const str = (v: string | null) => (v && v.length <= 500 ? v : undefined);

export function humanCheck(self: El | null): Ret<{ url: string; widgets: Widget[] }> {
  const elements: El[] = [];
  const idx = (e: El) => {
    const i = elements.indexOf(e);
    return i >= 0 ? i : elements.push(e) - 1;
  };
  const frames: { el: El; hit: FrameHit }[] = [];
  const containers: El[] = [];
  for (const el of walk(document)) {
    if (el.tagName === "IFRAME") {
      const hit = classifyFrameUrl(el.getAttribute("src") ?? "");
      if (hit) frames.push({ el, hit });
    } else if (el.matches(CONTAINER_SEL)) containers.push(el);
  }
  const v3 = v3Keys();
  const widgets: (Widget & { _root: El })[] = [];
  const challengeFor = (vendor: Vendor) => frames.find((f) => f.hit.vendor === vendor && f.hit.role === "challenge");
  const build = (root: El, vendor: Vendor, frame: FrameHit | null, frameEl: El | null): Widget & { _root: El } => {
    const sitekey = root.getAttribute("data-sitekey") ?? frame?.sitekey ?? null;
    const ch = challengeFor(vendor);
    const isV3 = vendor === "recaptcha" && !!sitekey && v3.has(sitekey);
    const callback = root.getAttribute("data-callback");
    return {
      _root: root,
      vendor,
      sitekey,
      invisible: root.getAttribute("data-size") === "invisible" || !!frame?.invisible || isV3,
      enterprise: !!frame?.enterprise || (vendor === "recaptcha" && !!document.querySelector('script[src*="/recaptcha/enterprise.js"]')),
      ...(vendor === "recaptcha" ? { version: isV3 ? ("v3" as const) : ("v2" as const) } : {}),
      ...(isV3 ? { passive: true } : {}),
      ...(str(root.getAttribute("data-action")) ? { action: str(root.getAttribute("data-action")) } : {}),
      ...(str(root.getAttribute("data-cdata")) ? { cdata: str(root.getAttribute("data-cdata")) } : {}),
      ...(callback && IDENT.test(callback) ? { callback } : {}),
      solved: isSolved(root, vendor, frameEl),
      visible: isVisible(frameEl ?? root) || isVisible(root),
      challengeVisible: !!ch && isVisible(ch.el),
      el: idx(root),
      ...(ch ? { challenge: { el: idx(ch.el) } } : {}),
    };
  };
  for (const c of containers) {
    const vendor = vendorOfContainer(c);
    if (!vendor) continue;
    const inner = frames.find((f) => f.hit.vendor === vendor && f.hit.role === "widget" && c.contains(f.el));
    widgets.push(build(c, vendor, inner?.hit ?? null, inner?.el ?? null));
  }
  for (const f of frames) {
    if (f.hit.role !== "widget" || containers.some((c) => c.contains(f.el))) continue;
    widgets.push(build(f.el, f.hit.vendor, f.hit, f.el));
  }
  const keep = self ? widgets.filter((w) => w._root === self || w._root.contains(self) || self.contains(w._root)) : widgets;
  return { value: { url: location.href, widgets: keep.map(({ _root, ...w }) => (void _root, w)) }, elements };
}

/** Write a solver token into the widget's response field(s). `self` = the widget (container or iframe). */
export function captchaInject(self: El | null, o: { vendor: Vendor; token: string }): Ret<{ written: number }> {
  if (!self || typeof o?.token !== "string" || !o.token) return { value: { written: 0 }, elements: [] };
  let fields = fieldsOf(self, o.vendor);
  if (!fields.length && o.vendor === "turnstile") {
    const inp = document.createElement("input");
    inp.type = "hidden";
    inp.name = self.getAttribute("data-response-field-name") || "cf-turnstile-response";
    self.appendChild(inp);
    fields = [inp];
  }
  for (const f of fields) {
    const proto = f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(f, o.token);
    else f.value = o.token;
    if (f.tagName === "TEXTAREA") f.textContent = o.token;
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (o.vendor === "hcaptcha") {
    const fr = self.tagName === "IFRAME" ? self : self.querySelector("iframe[data-hcaptcha-widget-id], iframe");
    fr?.setAttribute("data-hcaptcha-response", o.token);
  }
  return { value: { written: fields.length }, elements: [] };
}

/** In a vendor checkbox frame: the checkbox, its state, and the frame's site key. */
export function captchaCheckbox(_self: El | null, href: string = location.href): Ret<{ vendor: Vendor; sitekey: string | null; checked: boolean; el: number } | null> {
  const hit = classifyFrameUrl(href);
  if (!hit || hit.role !== "widget" || hit.vendor === "arkose") return { value: null, elements: [] };
  let box: El | null = null;
  if (hit.vendor === "hcaptcha") box = document.querySelector("#checkbox");
  else if (hit.vendor === "recaptcha") box = document.querySelector("#recaptcha-anchor");
  else for (const el of walk(document)) if (el.matches('input[type="checkbox"], [role="checkbox"]')) box = el;
  if (!box) return { value: null, elements: [] };
  const checked = box.getAttribute("aria-checked") === "true" || (box as HTMLInputElement).checked === true;
  return { value: { vendor: hit.vendor, sitekey: hit.sitekey, checked, el: 0 }, elements: [box] };
}

export interface Challenge {
  vendor: Vendor;
  prompt: string;
  kind: "grid" | "canvas";
  rows?: number;
  cols?: number;
  tiles: { el: number }[];
  /** What to screenshot: the challenge view (grid) or the canvas. */
  area: { el: number };
  submit: { el: number } | null;
}

function gridShape(tiles: El[]): { rows: number; cols: number } {
  const tops = new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)));
  const lefts = new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().left)));
  if (tops.size * lefts.size === tiles.length) return { rows: tops.size, cols: lefts.size };
  const side = Math.round(Math.sqrt(tiles.length));
  return side * side === tiles.length ? { rows: side, cols: side } : { rows: 1, cols: tiles.length };
}

/** In a vendor challenge frame: what the vision provider needs for one round. */
export function captchaChallenge(_self: El | null, href: string = location.href): Ret<Challenge | null> {
  const hit = classifyFrameUrl(href);
  if (!hit || hit.role !== "challenge") return { value: null, elements: [] };
  const elements: El[] = [];
  const idx = (e: El) => elements.push(e) - 1;
  if (hit.vendor === "hcaptcha") {
    const promptEl = document.querySelector(".prompt-text, h2.prompt-text, .prompt-padding");
    const prompt = norm(promptEl ? textOf(promptEl) || promptEl.textContent : "").slice(0, 500);
    const tiles = Array.from(document.querySelectorAll(".task-image, .task-grid .task")).filter((t) => !t.parentElement?.closest(".task-image"));
    const submit = document.querySelector(".button-submit");
    const view = document.querySelector(".challenge-view, .challenge-container") ?? document.body;
    if (tiles.length >= 2) {
      const shape = gridShape(tiles);
      const area = idx(view);
      return { value: { vendor: "hcaptcha", prompt, kind: "grid", ...shape, tiles: tiles.map((t) => ({ el: idx(t) })), area: { el: area }, submit: submit ? { el: idx(submit) } : null }, elements };
    }
    const canvas = document.querySelector("canvas");
    if (!canvas) return { value: null, elements: [] };
    const area = idx(canvas);
    return { value: { vendor: "hcaptcha", prompt, kind: "canvas", tiles: [], area: { el: area }, submit: submit ? { el: idx(submit) } : null }, elements };
  }
  if (hit.vendor === "recaptcha") {
    const desc = document.querySelector(".rc-imageselect-desc, .rc-imageselect-desc-no-canonical, .rc-imageselect-instructions");
    const prompt = norm(desc ? desc.textContent : "").slice(0, 500);
    const tiles = Array.from(document.querySelectorAll("td.rc-imageselect-tile"));
    if (tiles.length < 2) return { value: null, elements: [] };
    const rows = document.querySelectorAll("table[class*='rc-imageselect-table'] tr").length || Math.round(Math.sqrt(tiles.length));
    const cols = Math.round(tiles.length / rows);
    const view = document.querySelector(".rc-imageselect-challenge, .rc-imageselect-payload") ?? document.body;
    const submit = document.querySelector("#recaptcha-verify-button");
    const area = idx(view);
    return { value: { vendor: "recaptcha", prompt, kind: "grid", rows, cols, tiles: tiles.map((t) => ({ el: idx(t) })), area: { el: area }, submit: submit ? { el: idx(submit) } : null }, elements };
  }
  return { value: null, elements: [] };
}

export const captchaApi = { humanCheck, captchaInject, captchaCheckbox, captchaChallenge };
