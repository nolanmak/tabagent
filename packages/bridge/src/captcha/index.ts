// Wiring for the daemon (#61), like ../auth/index.ts:
//   daemon field:    this.captcha = createCaptcha({ inFlight: (id) => this.pending.get(id), audit: this.audit, log: this.log })
//   onExtMessage:    if (this.captcha.onExtMessage(msg, ws, (m) => this.sendTo(ws, m))) return;
//   send() timeout:  + captchaExtraTimeout(tool, meta)
//   stop:            this.captcha.abortAll()
import { CaptchaBridge, type CaptchaAuditSink, type CaptchaBridgeOpts, type CaptchaInFlight } from "./bridge";
import { CapSolverProvider } from "./capsolver";
import { readCaptchaSettings } from "./config";
import { TwoCaptchaProvider } from "./twocaptcha";
import { VisionProvider } from "./vision";

export interface CaptchaOpts extends Partial<Omit<CaptchaBridgeOpts, "inFlight" | "audit">> {
  inFlight: (commandId: string) => CaptchaInFlight | undefined;
  audit: CaptchaAuditSink;
}

export function createCaptcha(o: CaptchaOpts): CaptchaBridge {
  return new CaptchaBridge({
    settings: () => readCaptchaSettings(),
    tokenProvider: (name, key) => (name === "2captcha" ? new TwoCaptchaProvider({ key }) : new CapSolverProvider({ key })),
    visionProvider: (v) => new VisionProvider(v),
    ...o,
  });
}

export { CaptchaBridge, MAX_SOLVES_PER_COMMAND, MAX_VISION_ROUNDS_PER_COMMAND } from "./bridge";
export { CapSolverProvider } from "./capsolver";
export { TwoCaptchaProvider } from "./twocaptcha";
export { VisionProvider, parseVisionAnswer } from "./vision";
export { readCaptchaSettings, writeCaptchaFile, removeCaptchaFile, captchaPath, type CaptchaSettings, type CaptchaFile } from "./config";
export { captchaCommand, type CaptchaCliDeps } from "./cli";
export type { CaptchaTask, CaptchaProvider, VisionRound, VisionSolver } from "./provider";
