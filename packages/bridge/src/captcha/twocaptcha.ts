// 2Captcha API v2 (https://2captcha.com/api-docs), the JSON createTask / getTaskResult flow.
// 2Captcha dropped hCaptcha from its public docs in 2025; HCaptchaTaskProxyless is still sent and an
// unsupported answer maps to reason provider_unsupported.
import type { CaptchaTask } from "./provider";
import { TaskApiProvider } from "./taskapi";

export class TwoCaptchaProvider extends TaskApiProvider {
  readonly name = "2captcha" as const;
  protected readonly base = "https://api.2captcha.com";
  protected readonly defaultPollMs = 5_000;

  taskFor(t: CaptchaTask): Record<string, unknown> | null {
    const site = { websiteURL: t.url, websiteKey: t.sitekey };
    switch (t.vendor) {
      case "hcaptcha":
        return { type: "HCaptchaTaskProxyless", ...site, ...(t.invisible ? { isInvisible: true } : {}) };
      case "recaptcha":
        if (t.version === "v3") return { type: "RecaptchaV3TaskProxyless", ...site, minScore: 0.7, ...(t.action ? { pageAction: t.action } : {}), ...(t.enterprise ? { isEnterprise: true } : {}) };
        return { type: t.enterprise ? "RecaptchaV2EnterpriseTaskProxyless" : "RecaptchaV2TaskProxyless", ...site, ...(t.invisible ? { isInvisible: true } : {}) };
      case "turnstile":
        return { type: "TurnstileTaskProxyless", ...site, ...(t.action ? { action: t.action } : {}), ...(t.cdata ? { data: t.cdata } : {}) };
      default:
        return null;
    }
  }
}
