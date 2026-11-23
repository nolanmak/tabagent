import { describe, expect, it } from "vitest";
import { DEFAULTS, migrateSettings } from "../src/background/settingsModel";

describe("settings model (D32, contract §7)", () => {
  it("defaults", () => {
    const s = migrateSettings(undefined);
    expect(s).toEqual(DEFAULTS);
    expect(s.devAllowSensitive).toBe(false);
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.showOverlay).toBe(true);
  });
  it("validates scalars and drops unknown keys", () => {
    const s = migrateSettings({ port: 70000, secret: "", onSessionEnd: "explode", showOverlay: false, devAllowSensitive: "yes", sites: { "https://a": { policy: "full" } } });
    expect(s.port).toBe(DEFAULTS.port);
    expect(s.secret).toBeNull();
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.showOverlay).toBe(false);
    expect(s.devAllowSensitive).toBe(false);
    expect(s).not.toHaveProperty("sites");
    expect(migrateSettings({ port: 1234, secret: "abc", devAllowSensitive: true, onSessionEnd: "close" })).toMatchObject({ port: 1234, secret: "abc", devAllowSensitive: true, onSessionEnd: "close" });
  });
});
