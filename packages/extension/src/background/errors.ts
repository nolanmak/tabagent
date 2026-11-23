// Error construction that works with both the current and the contract
// TabAgentError (codes like UNSUPPORTED / DEBUGGER_DETACHED / DIALOG_OPEN and
// the `pageText` option land with the protocol agent's registry update).
import { TabAgentError } from "@tabagent/protocol";

export type Code =
  | "REF_STALE"
  | "TAB_BUSY"
  | "PERMISSION_DENIED"
  | "PROMPT_TIMEOUT"
  | "TIMEOUT"
  | "NOT_ACTIONABLE"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NO_EXTENSION"
  | "VERSION_MISMATCH"
  | "KILLED"
  | "UNSUPPORTED"
  | "DEBUGGER_DETACHED"
  | "DIALOG_OPEN"
  | "TOO_LARGE"
  | "INTERNAL";

export function taErr(code: Code, message: string, hint?: string, opts?: { pageText?: boolean }): TabAgentError {
  const E = TabAgentError as unknown as new (c: string, m: string, h?: string, o?: { pageText?: boolean }) => TabAgentError;
  const e = new E(code, message, hint, opts);
  if (opts?.pageText) (e as unknown as { pageText: boolean }).pageText = true;
  return e;
}

export function isCode(e: unknown, code: Code): boolean {
  return e instanceof TabAgentError && (e.code as string) === code;
}

export function codeOf(e: unknown): string | undefined {
  return e instanceof TabAgentError ? (e.code as string) : undefined;
}

export const STALE_HINT = "Take a new page.snapshot (or page.find) and use the fresh refs.";
export function staleRef(ref: string, why: string): TabAgentError {
  return taErr("REF_STALE", `Ref ${ref} is stale: ${why}`, STALE_HINT);
}
