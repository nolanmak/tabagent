// #61: the main-world expression that hands a solver token to the page's widget callback. Pages read
// the token either from the response field (pagelib captchaInject writes it) or from the callback they
// registered with data-callback / render({callback}); this covers the second.
//
// Only a dotted identifier path is ever turned into code; the token and site key go in as JSON string
// literals. reCAPTCHA explicit renders keep their callback in ___grecaptcha_cfg.clients, which is
// searched by site key. hCaptcha and Turnstile explicit renders keep it private, so only data-callback
// works for them (a known limit, listed in the PR).

const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,4}$/;

export interface CallbackSpec {
  vendor: "hcaptcha" | "recaptcha" | "turnstile" | "arkose";
  token: string;
  sitekey: string | null;
  callback?: string;
}

/** A single expression returning true when a callback was called. */
export function callbackExpression(s: CallbackSpec): string {
  const path = s.callback && IDENT.test(s.callback) ? s.callback : "";
  return `(() => {
  const tok = ${JSON.stringify(s.token)};
  const path = ${JSON.stringify(path)};
  const key = ${JSON.stringify(s.sitekey ?? "")};
  const call = (f) => { try { f(tok); } catch (e) { /* the page's own error */ } return true; };
  if (path) {
    let f = globalThis;
    for (const k of path.split(".")) f = f == null ? undefined : f[k];
    if (typeof f === "function") return call(f);
  }
  if (${JSON.stringify(s.vendor)} === "recaptcha" && globalThis.___grecaptcha_cfg && globalThis.___grecaptcha_cfg.clients) {
    const seen = new Set();
    const find = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 5 || seen.has(o)) return null;
      seen.add(o);
      if ((!key || o.sitekey === key) && "callback" in o && o.callback) return o.callback;
      for (const v of Object.values(o)) { const hit = find(v, depth + 1); if (hit) return hit; }
      return null;
    };
    for (const c of Object.values(globalThis.___grecaptcha_cfg.clients)) {
      const cb = find(c, 0);
      if (typeof cb === "function") return call(cb);
      if (typeof cb === "string" && /^[A-Za-z_$][\\w$]*$/.test(cb) && typeof globalThis[cb] === "function") return call(globalThis[cb]);
    }
  }
  return false;
})()`;
}
