// Pure settings model: defaults, validation and migration from the spike's shape.

export type OnSessionEnd = "collapse" | "close" | "keep";
export type BeforeUnload = "accept" | "dismiss" | "ask-agent";

export const DEFAULT_PORT = 47615;

export interface StoredShape {
  port: number;
  secret: string | null;
  devAllowSensitive: boolean;
  onSessionEnd: OnSessionEnd;
  beforeUnload: BeforeUnload;
  showOverlay: boolean;
}

export const DEFAULTS: StoredShape = {
  port: DEFAULT_PORT,
  secret: null,
  devAllowSensitive: false,
  onSessionEnd: "collapse",
  beforeUnload: "accept",
  showOverlay: true,
};

/**
 * Normalise anything stored (or patched) into the current shape.
 * Old key: autoAcceptBeforeUnload.
 */
export function migrateSettings(raw: Record<string, unknown> | undefined | null): StoredShape {
  const r = (raw ?? {}) as Record<string, any>;
  const beforeUnload: BeforeUnload = ["accept", "dismiss", "ask-agent"].includes(r.beforeUnload) ? r.beforeUnload : typeof r.autoAcceptBeforeUnload === "boolean" ? (r.autoAcceptBeforeUnload ? "accept" : "dismiss") : DEFAULTS.beforeUnload;
  return {
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULTS.port,
    secret: typeof r.secret === "string" && r.secret ? r.secret : null,
    devAllowSensitive: r.devAllowSensitive === true,
    onSessionEnd: ["collapse", "close", "keep"].includes(r.onSessionEnd) ? r.onSessionEnd : DEFAULTS.onSessionEnd,
    beforeUnload,
    showOverlay: typeof r.showOverlay === "boolean" ? r.showOverlay : DEFAULTS.showOverlay,
  };
}
