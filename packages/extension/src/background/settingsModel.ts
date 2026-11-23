// Pure settings model: defaults, validation and migration from the spike's shape.

export type OnSessionEnd = "collapse" | "close" | "keep";

export const DEFAULT_PORT = 47615;

export interface StoredShape {
  port: number;
  secret: string | null;
  /** D17: allow the D18 gated effects without a prompt (off by default; the e2e harness turns it on). */
  devAllowSensitive: boolean;
  onSessionEnd: OnSessionEnd;
  showOverlay: boolean;
}

export const DEFAULTS: StoredShape = {
  port: DEFAULT_PORT,
  secret: null,
  devAllowSensitive: false,
  onSessionEnd: "collapse",
  showOverlay: true,
};

/** Normalise anything stored (or patched) into the current shape. Unknown keys are dropped. */
export function migrateSettings(raw: Record<string, unknown> | undefined | null): StoredShape {
  const r = (raw ?? {}) as Record<string, any>;
  return {
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULTS.port,
    secret: typeof r.secret === "string" && r.secret ? r.secret : null,
    devAllowSensitive: r.devAllowSensitive === true,
    onSessionEnd: ["collapse", "close", "keep"].includes(r.onSessionEnd) ? r.onSessionEnd : DEFAULTS.onSessionEnd,
    showOverlay: typeof r.showOverlay === "boolean" ? r.showOverlay : DEFAULTS.showOverlay,
  };
}
