// Pure settings model: defaults and validation (D32).

export const DEFAULT_PORT = 47615;

export interface StoredShape {
  port: number;
  secret: string | null;
  /** D17: let D18 gated effects run without asking. Off by default; the e2e harness turns it on. */
  devAllowSensitive: boolean;
}

export const DEFAULTS: StoredShape = {
  port: DEFAULT_PORT,
  secret: null,
  devAllowSensitive: false,
};

/** Normalise anything stored (or patched) into the current shape. */
export function migrateSettings(raw: Record<string, unknown> | undefined | null): StoredShape {
  const r = (raw ?? {}) as Record<string, any>;
  return {
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULTS.port,
    secret: typeof r.secret === "string" && r.secret ? r.secret : null,
    devAllowSensitive: r.devAllowSensitive === true,
  };
}
