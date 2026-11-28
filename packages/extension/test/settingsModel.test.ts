import { describe, expect, it } from "vitest";
import { DEFAULTS, migrateSettings, SEEDED_DENYLIST, settingsAuditEvents } from "../src/background/settingsModel";

describe("seeded denylist (#81 D2, D5)", () => {
  it("keeps an explicit sign-in off (auth: false) so a default-on origin can be turned off", () => {
    const s = migrateSettings({ sites: { "https://accounts.google.com": { policy: "act", auth: false } } } as any);
    expect(s.sites["https://accounts.google.com"].auth).toBe(false);
  });
  it("still seeds accounts.google.com so new installs start with Google blocked", () => {
    expect(SEEDED_DENYLIST).toContain("accounts.google.com");
  });
  it("protocol no longer exports a second, drifting default list", async () => {
    const protocol = (await import("@tabagent/protocol")) as Record<string, unknown>;
    expect(protocol.DEFAULT_DENYLIST).toBeUndefined();
  });
});

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

describe("yolo setting", () => {
  it("defaults off and only true turns it on", () => {
    expect(migrateSettings(undefined).yolo).toBe(false);
    expect(migrateSettings({ yolo: "yes" }).yolo).toBe(false);
    expect(migrateSettings({ yolo: true }).yolo).toBe(true);
  });
});

describe("risky settings are audited when toggled (review M1)", () => {
  const d = migrateSettings(undefined);
  it("turning YOLO on or off, and devAllowSensitive, sends settings.changed with the new values", () => {
    expect(settingsAuditEvents(d, { ...d, yolo: true })).toEqual([{ event: "settings.changed", data: { yolo: true } }]);
    expect(settingsAuditEvents({ ...d, yolo: true }, d)).toEqual([{ event: "settings.changed", data: { yolo: false } }]);
    expect(settingsAuditEvents(d, { ...d, devAllowSensitive: true, yolo: true })).toEqual([{ event: "settings.changed", data: { devAllowSensitive: true, yolo: true } }]);
  });
  it("other changes, and no change, send nothing", () => {
    expect(settingsAuditEvents(d, { ...d, showOverlay: false })).toEqual([]);
    expect(settingsAuditEvents({ ...d, yolo: true }, { ...d, yolo: true })).toEqual([]);
  });
});

describe("sign in without asking is stored only where it can apply (#131)", () => {
  it("keeps authAuto with an explicit auth: true", () => {
    expect(migrateSettings({ sites: { "https://shop.example": { auth: true, authAuto: true } } } as any).sites["https://shop.example"]).toEqual({ auth: true, authAuto: true });
  });
  it("drops authAuto without auth: true, or with a non-boolean value", () => {
    expect(migrateSettings({ sites: { "https://shop.example": { policy: "act", authAuto: true } } } as any).sites["https://shop.example"]).toEqual({ policy: "act" });
    expect(migrateSettings({ sites: { "https://shop.example": { auth: false, authAuto: true } } } as any).sites["https://shop.example"]).toEqual({ auth: false });
    expect(migrateSettings({ sites: { "https://shop.example": { auth: true, authAuto: "yes" } } } as any).sites["https://shop.example"]).toEqual({ auth: true });
  });
  it("drops authAuto on hosts where sign-in is never automated", () => {
    for (const o of ["https://www.chase.com", "https://app.mercury.com", "https://vault.bitwarden.com", "https://mail.google.com"]) {
      expect(migrateSettings({ sites: { [o]: { policy: "full", auth: true, authAuto: true } } } as any).sites[o].authAuto).toBeUndefined();
    }
  });
  it("audits turning it on or off per origin", () => {
    const d = migrateSettings(undefined);
    const on = { ...d, sites: { "https://shop.example": { auth: true, authAuto: true as const } } };
    expect(settingsAuditEvents(d, on)).toEqual([{ event: "settings.changed", data: { authAuto: true, origin: "https://shop.example" } }]);
    expect(settingsAuditEvents(on, d)).toEqual([{ event: "settings.changed", data: { authAuto: false, origin: "https://shop.example" } }]);
    expect(settingsAuditEvents(on, on)).toEqual([]);
  });
});
