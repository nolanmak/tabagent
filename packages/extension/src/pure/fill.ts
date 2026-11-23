// form.fill result shape (D34): best-effort, never atomic.
import type { ErrorCode } from "@tabagent/protocol";

export interface Filled {
  key: string;
  ref: string;
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
