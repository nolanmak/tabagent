// Error codes (D14) and the TabAgentError class shared by bridge and extension.

export const ERROR_CODES = [
  "REF_STALE",
  "TAB_BUSY",
  "PERMISSION_DENIED",
  "PROMPT_TIMEOUT",
  "TIMEOUT",
  "NOT_ACTIONABLE",
  "NOT_FOUND",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NO_EXTENSION",
  "VERSION_MISMATCH",
  "KILLED",
  "UNSUPPORTED",
  "DEBUGGER_DETACHED",
  "DIALOG_OPEN",
  "TOO_LARGE",
  "CAPTCHA_UNSOLVED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === "string" && (ERROR_CODES as readonly string[]).includes(x);
}

/** Error as it travels on the wire and leaves the bridge. */
export interface ToolError {
  code: ErrorCode;
  message: string;
  hint?: string;
  /** Set when `message` quotes page content; the bridge wraps it (D21). */
  untrusted?: true;
}

export interface TabAgentErrorOpts {
  /** The message quotes the page (e.g. "covered by <div …>"): wrap it at the output edge. */
  pageText?: boolean;
}

export class TabAgentError extends Error {
  readonly pageText: boolean;
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    opts: TabAgentErrorOpts = {},
  ) {
    super(message);
    this.name = "TabAgentError";
    this.pageText = !!opts.pageText;
  }
  toJSON(): ToolError {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.pageText ? { untrusted: true as const } : {}),
    };
  }
  static from(e: { code?: unknown; message?: unknown; hint?: unknown; untrusted?: unknown }): TabAgentError {
    return new TabAgentError(
      isErrorCode(e.code) ? e.code : "INTERNAL",
      typeof e.message === "string" ? e.message : "Unknown error",
      typeof e.hint === "string" ? e.hint : undefined,
      { pageText: e.untrusted === true },
    );
  }
}

/** Normalise anything thrown into a TabAgentError; never leaks a stack into `message`. */
export function toTabAgentError(e: unknown): TabAgentError {
  if (e instanceof TabAgentError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new TabAgentError("INTERNAL", msg.split("\n")[0] || "Internal error");
}
