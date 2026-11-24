// CapSolver (https://docs.capsolver.com), the default provider. Proxyless task types only: the solve is
// for the user's own browser session, so no proxy credentials ever leave the bridge.
// Note: CapSolver has listed hCaptcha as unavailable at times; an ERROR_INVALID_TASK_DATA /
// unsupported answer maps to reason provider_unsupported, and the bridge moves on to the next
// configured provider (e.g. vision).
import type { CaptchaTask } from "./provider";
import { TaskApiProvider } from "./taskapi";

export class CapSolverProvider extends TaskApiProvider {
  readonly name = "capsolver" as const;
  protected readonly base = "https://api.capsolver.com";
  protected readonly defaultPollMs = 2_000;

  taskFor(t: CaptchaTask): Record<string, unknown> | null {
    const site = { websiteURL: t.url, websiteKey: t.sitekey };
    switch (t.vendor) {
      case "hcaptcha":
        return { type: "HCaptchaTaskProxyLess", ...site, ...(t.invisible ? { isInvisible: true } : {}) };
      case "recaptcha":
        if (t.version === "v3") return { type: t.enterprise ? "ReCaptchaV3EnterpriseTaskProxyLess" : "ReCaptchaV3TaskProxyLess", ...site, ...(t.action ? { pageAction: t.action } : {}) };
        return { type: t.enterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess", ...site, ...(t.invisible ? { isInvisible: true } : {}) };
      case "turnstile": {
        const metadata = { ...(t.action ? { action: t.action } : {}), ...(t.cdata ? { cdata: t.cdata } : {}) };
        return { type: "AntiTurnstileTaskProxyLess", ...site, ...(Object.keys(metadata).length ? { metadata } : {}) };
      }
      default:
        return null;
    }
  }
}
