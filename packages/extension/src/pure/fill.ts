// form.fill result shape (D34): best-effort, never atomic.
import type { ErrorCode } from "@tabagent/protocol";

export interface Filled {
  key: string;
  ref: string;
  /** #59: clicked, but the control's checked state can't be read back. */
  unverified?: true;
}
export interface Failed {
  key: string;
  code: ErrorCode;
  message: string;
  ref?: string;
}

export function fillResult(filled: Filled[], failed: Failed[]): { filled: Filled[]; failed: Failed[] } {
  return { filled: [...filled], failed: [...failed] };
}
