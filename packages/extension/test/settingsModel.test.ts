import { describe, expect, it } from "vitest";
import { DEFAULTS, migrateSettings } from "../src/background/settingsModel";

describe("settings model (D32, contract §7)", () => {
  it("defaults", () => {
    const s = migrateSettings(undefined);
    expect(s).toEqual(DEFAULTS);
    expect(s.devAllowSensitive).toBe(false);
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.beforeUnload).toBe("accept");
    expect(s.showOverlay).toBe(true);
  });
  it("migrates the spike's autoAcceptBeforeUnload", () => {
    expect(migrateSettings({ autoAcceptBeforeUnload: false }).beforeUnload).toBe("dismiss");
    expect(migrateSettings({ autoAcceptBeforeUnload: true }).beforeUnload).toBe("accept");
  });
  it("validates scalars", () => {
    const s = migrateSettings({ port: 70000, secret: "", onSessionEnd: "explode", beforeUnload: "ask-agent", showOverlay: false, devAllowSensitive: "yes" });
    expect(s.port).toBe(DEFAULTS.port);
    expect(s.secret).toBeNull();
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.beforeUnload).toBe("ask-agent");
    expect(s.showOverlay).toBe(false);
    expect(s.devAllowSensitive).toBe(false);
    expect(migrateSettings({ port: 1234, secret: "abc" })).toMatchObject({ port: 1234, secret: "abc" });
  });
});
