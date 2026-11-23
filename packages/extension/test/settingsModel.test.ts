import { describe, expect, it } from "vitest";
import { DEFAULTS, migrateSettings } from "../src/background/settingsModel";

describe("settings model (D32)", () => {
  it("defaults: devAllowSensitive is off (D17)", () => {
    const s = migrateSettings(undefined);
    expect(s).toEqual(DEFAULTS);
    expect(s).toEqual({ port: 47615, secret: null, devAllowSensitive: false });
  });
  it("validates scalars and drops unknown keys", () => {
    const s = migrateSettings({ port: 70000, secret: "", devAllowSensitive: "yes", sites: { x: 1 } });
    expect(s).toEqual(DEFAULTS);
    expect(migrateSettings({ port: 1234, secret: "abc", devAllowSensitive: true })).toEqual({ port: 1234, secret: "abc", devAllowSensitive: true });
    expect(migrateSettings({ port: 1.5 }).port).toBe(DEFAULTS.port);
  });
});
