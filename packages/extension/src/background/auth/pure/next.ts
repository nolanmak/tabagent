// #33 `next` classification after auth.login / auth.code. Pure.
import { detectCodeField, detectLogin, type FieldDesc } from "./fields";

export type Next = "done" | "code_required" | "handoff_required" | "unknown";

export interface PageSignals {
  url: string;
  fields: readonly FieldDesc[];
  /** A navigator.credentials.get/create (WebAuthn) request was seen, or a passkey prompt is up. */
  webauthn: boolean;
  /** A CAPTCHA frame (reCAPTCHA, hCaptcha, Turnstile, Arkose) is on the page. */
  captcha: boolean;
}

function stripHash(u: string) {
  return u.split("#")[0];
}

/**
 * code_required when a one-time-code field is there; handoff_required for WebAuthn, a CAPTCHA, or a
 * page that left the login form without arriving anywhere recognisable (same URL, no form, no code
 * field); done when the login form is gone and the URL changed; else unknown (e.g. the form is still
 * there: wrong password, or the next step of a two-step login, which auth.login fills when called again).
 */
export function classifyNext(beforeUrl: string, after: PageSignals): Next {
  if (after.webauthn || after.captcha) return "handoff_required";
  const code = detectCodeField(after.fields);
  const login = detectLogin(after.fields);
  if (code.ok && !(login.ok && login.kind !== "username-only")) return "code_required";
  if (login.ok) return "unknown";
  if (stripHash(after.url) !== stripHash(beforeUrl)) return "done";
  return "handoff_required";
}
