// Wire protocol between bridge and extension. See docs/DESIGN.md.
export type ErrorCode =
  | "REF_STALE" | "TAB_BUSY" | "PERMISSION_DENIED" | "TIMEOUT"
  | "NOT_ACTIONABLE" | "NO_EXTENSION" | "BAD_REQUEST";

export interface Command<P = unknown> {
  id: string;          // request id
  session: string;     // agent session id
  tool: string;        // e.g. "nav.goto"
  params: P;
}

export interface Result<R = unknown> {
  id: string;
  ok: boolean;
  result?: R;
  error?: { code: ErrorCode; message: string; hint?: string };
}
