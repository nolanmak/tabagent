/** Pure decisions for user-approved YOLO / developer-mode changes (#109). */
import { TabAgentError } from "@tabagent/protocol";

export const MAX_YOLO_MIN = 1440;
const MIN_MS = 60_000;

export type ModeChangeParams = { yolo?: boolean; devAllowSensitive?: boolean; durationMin?: number; reason?: unknown };
export interface ModeState {
  yolo: boolean;
  devAllowSensitive: boolean;
  /** Epoch ms when YOLO switches itself off; null = no expiry. */
  yoloExpiresAt: number | null;
}
export type ModeField = "yolo" | "devAllowSensitive" | "yoloExpiresAt";
export type ModeApplied = { field: ModeField; from: boolean | number | null; to: boolean | number | null };

const FIELDS: ModeField[] = ["yolo", "devAllowSensitive", "yoloExpiresAt"];
const DEV_NAME = "developer mode (skip sensitive-action confirmations)";

/**
 * Turning either mode on widens what agents may do, so it needs the user's approval. Decided from the
 * request alone: a racing write that already turned the mode on never turns an "on" into a free change.
 */
export function modeChangeNeedsApproval(p: ModeChangeParams): boolean {
  return p.yolo === true || p.devAllowSensitive === true;
}

export function yoloExpiry(now: number, durationMin: number): number {
  return now + durationMin * MIN_MS;
}

/**
 * Validate a request and compute the state it leads to. Runs before the prompt (so a bad or no-op
 * request never reaches the user) and again in the handler, where `now` starts the duration.
 */
export function checkModeChange(state: ModeState, p: ModeChangeParams, now: number): { next: ModeState; applied: ModeApplied[]; needsApproval: boolean } {
  if (p.yolo === undefined && p.devAllowSensitive === undefined) throw new TabAgentError("BAD_REQUEST", "policy.mode_change needs yolo or devAllowSensitive");
  if (p.durationMin !== undefined) {
    if (p.yolo !== true) throw new TabAgentError("BAD_REQUEST", "durationMin only applies when turning YOLO on (yolo: true)");
    if (typeof p.durationMin !== "number" || !Number.isInteger(p.durationMin) || p.durationMin < 1 || p.durationMin > MAX_YOLO_MIN) throw new TabAgentError("BAD_REQUEST", `durationMin must be a whole number of minutes from 1 to ${MAX_YOLO_MIN}`);
  }
  const next: ModeState = { yolo: !!state.yolo, devAllowSensitive: !!state.devAllowSensitive, yoloExpiresAt: state.yolo ? (state.yoloExpiresAt ?? null) : null };
  if (p.yolo === true) next.yoloExpiresAt = p.durationMin !== undefined ? yoloExpiry(now, p.durationMin) : null;
  if (p.yolo !== undefined) next.yolo = p.yolo;
  if (!next.yolo) next.yoloExpiresAt = null;
  if (p.devAllowSensitive !== undefined) next.devAllowSensitive = p.devAllowSensitive;
  const before: ModeState = { yolo: !!state.yolo, devAllowSensitive: !!state.devAllowSensitive, yoloExpiresAt: state.yolo ? (state.yoloExpiresAt ?? null) : null };
  const applied = FIELDS.filter((f) => before[f] !== next[f]).map((f) => ({ field: f, from: before[f], to: next[f] }));
  if (!applied.length) throw new TabAgentError("BAD_REQUEST", "Nothing to change: YOLO and developer mode already have these values", "Check settings.get for the current values.");
  return { next, applied, needsApproval: modeChangeNeedsApproval(p) };
}

/** What the approval was shown against. */
export function modeChangeSnapshot(state: ModeState): string {
  return JSON.stringify([!!state.yolo, !!state.devAllowSensitive, state.yolo ? (state.yoloExpiresAt ?? null) : null]);
}

export function yoloExpired(state: { yolo?: boolean; yoloExpiresAt?: number | null }, now: number): boolean {
  return !!state.yolo && typeof state.yoloExpiresAt === "number" && now >= state.yoloExpiresAt;
}

/** Time left, for the side panel: "45 s", "13 min", "3 h 5 min". */
export function formatRemaining(ms: number): string {
  if (ms < MIN_MS) return `${Math.max(0, Math.ceil(ms / 1000))} s`;
  const min = Math.ceil(ms / MIN_MS);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The prompt summary: each change, the YOLO duration and the reason. */
export function describeModeChange(p: ModeChangeParams): string {
  const parts: string[] = [];
  if (p.yolo !== undefined) parts.push(p.yolo ? `turn YOLO mode on ${p.durationMin !== undefined ? `for ${p.durationMin} minutes` : "with no time limit"}` : "turn YOLO mode off");
  if (p.devAllowSensitive !== undefined) parts.push(`turn ${DEV_NAME} ${p.devAllowSensitive ? "on" : "off"}`);
  return `${parts.join(", ")}; reason: ${String(p.reason ?? "").slice(0, 160)}`;
}

/** The prompt's warning lines: what each mode being turned on allows. */
export function modeChangeWarnings(p: ModeChangeParams): string[] {
  const out: string[] = [];
  if (p.yolo === true) {
    out.push("YOLO lets every agent use every site without asking, sign in on every site with your saved accounts, and skip sensitive-action confirmations. The denylist, kill switch, tab takeover and each account's first sign-in still ask.");
    out.push(p.durationMin !== undefined ? `YOLO switches itself off after ${p.durationMin} minutes.` : "YOLO stays on until you turn it off.");
  }
  if (p.devAllowSensitive === true) out.push("Developer mode skips sensitive-action confirmations on every allowed site: password and card form submits, risky clicks, running JavaScript, reading cookies and storage, and file transfers.");
  return out;
}
