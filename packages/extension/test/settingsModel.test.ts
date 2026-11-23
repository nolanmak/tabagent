import { describe, expect, it } from "vitest";
import { DEFAULTS, migrateSettings, SEEDED_DENYLIST } from "../src/background/settingsModel";

describe("settings model (D32, contract §7)", () => {
  it("defaults", () => {
    const s = migrateSettings(undefined);
    expect(s).toEqual({ ...DEFAULTS, denylist: SEEDED_DENYLIST });
    expect(s.devAllowSensitive).toBe(false);
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.beforeUnload).toBe("accept");
    expect(s.showOverlay).toBe(true);
    expect(s.denylist).not.toContain("chromewebstore.google.com"); // hard-denied elsewhere, not editable
  });
  it("migrates the spike's policies / sensitiveAllowed / autoAcceptBeforeUnload", () => {
    const s = migrateSettings({ policies: { "https://a": "act", "https://b": "ask", "https://c": "bogus" }, sensitiveAllowed: { "https://a": true, "https://d": false }, autoAcceptBeforeUnload: false });
    expect(s.sites).toEqual({ "https://a": { policy: "act", preapproved: { a: true, b: true, c: true, d: true, e: true } } });
    expect(s.beforeUnload).toBe("dismiss");
  });
  it("cleans site entries", () => {
    const s = migrateSettings({ sites: { "https://a": { policy: "full", lite: true, preapproved: { a: true, f: true, b: false }, auth: true, authAlways: ["x", "x", 3, ""] }, "https://empty": {}, "https://junk": 5 } });
    expect(s.sites).toEqual({ "https://a": { policy: "full", lite: true, preapproved: { a: true }, auth: true, authAlways: ["x"] } });
  });
  it("validates scalars", () => {
    const s = migrateSettings({ port: 70000, secret: "", onSessionEnd: "explode", beforeUnload: "ask-agent", showOverlay: false, devAllowSensitive: "yes", denylist: [" a.com ", "", 3], liteSites: ["x", 1], forceLite: true });
    expect(s.port).toBe(DEFAULTS.port);
    expect(s.secret).toBeNull();
    expect(s.onSessionEnd).toBe("collapse");
    expect(s.beforeUnload).toBe("ask-agent");
    expect(s.showOverlay).toBe(false);
    expect(s.devAllowSensitive).toBe(false);
    expect(s.denylist).toEqual(["a.com"]);
    expect(s.liteSites).toEqual(["x"]);
    expect(s.forceLite).toBe(true);
    expect(migrateSettings({ port: 1234, secret: "abc" })).toMatchObject({ port: 1234, secret: "abc" });
  });
});
