import { describe, expect, it } from "vitest";
import { SETTINGS_SNAPSHOT } from "@tabagent/protocol";
import { applyPreferences, settingsSnapshot } from "../src/pure/settingsView";
import { isPanelSender } from "../src/pure/uiSender";
import { AUTH_DENY_HOSTS, VAULT_DENY_HOSTS } from "../src/background/policy";
import { DEFAULTS, migrateSettings } from "../src/background/settingsModel";

const SECRET = "pairing-secret-SHOULD-NEVER-LEAK-7f3a";
const TOKEN = "tab_token-SHOULD-NEVER-LEAK-91bc";
const ACCOUNT = "vault-item-SHOULD-NEVER-LEAK-acct-42";
const EMAIL = "victim-SHOULD-NEVER-LEAK@example.com";

/** Stored settings with every kind of secret an attacker would want, including keys a future version might add. */
function seeded() {
  return {
    ...migrateSettings({
      secret: SECRET,
      denylist: ["*.bank.example", "accounts.google.com"],
      sites: {
        "https://app.example.com": { policy: "full", lite: true, auth: true, authAlways: [ACCOUNT, EMAIL], preapproved: { c: true, a: true } },
        "https://read.example.com": { policy: "read" },
        "https://accounts.google.com": { auth: false },
      },
      yolo: false,
      devAllowSensitive: true,
      onSessionEnd: "keep",
      beforeUnload: "dismiss",
      showOverlay: false,
      forceLite: false,
      liteSites: ["*.lite.example"],
    }),
    // Not part of the stored shape today; must not ride along if it ever is.
    tokens: [{ name: "bot", token: TOKEN }],
    accounts: [{ id: ACCOUNT, username: EMAIL, password: SECRET }],
    pairing: { code: "123456", secret: SECRET },
  };
}

describe("settingsSnapshot (#105)", () => {
  it("returns the expected shape and validates against the registry result schema", () => {
    const snap = settingsSnapshot(seeded());
    expect(SETTINGS_SNAPSHOT.strict().safeParse(snap).success).toBe(true);
    expect(snap).toEqual({
      denylist: ["*.bank.example", "accounts.google.com"],
      sites: {
        "https://app.example.com": { policy: "full", auth: true, lite: true, preapproved: ["a", "c"], alwaysAccounts: 2 },
        "https://read.example.com": { policy: "read", auth: false, lite: false },
        "https://accounts.google.com": { policy: "ask", auth: false, lite: false },
      },
      yolo: false,
      devAllowSensitive: true,
      onSessionEnd: "keep",
      beforeUnload: "dismiss",
      showOverlay: false,
      forceLite: false,
      liteSites: ["*.lite.example"],
      authDenyHosts: AUTH_DENY_HOSTS,
      vaultDenyHosts: VAULT_DENY_HOSTS,
    });
  });

  it("reports sign-in without asking (#131) only where the gate would honour it", () => {
    const snap = settingsSnapshot({
      ...DEFAULTS,
      denylist: ["*.bank.example"],
      sites: {
        "https://shop.example": { auth: true, authAuto: true },
        "https://x.bank.example": { auth: true, authAuto: true },
        "https://flag-only.example": { authAuto: true },
      },
    });
    expect(SETTINGS_SNAPSHOT.strict().safeParse(snap).success).toBe(true);
    expect(snap.sites["https://shop.example"]).toEqual({ policy: "ask", auth: true, lite: false, authAuto: true });
    expect(snap.sites["https://x.bank.example"]).not.toHaveProperty("authAuto");
    expect(snap.sites["https://flag-only.example"]).not.toHaveProperty("authAuto");
  });

  it("never carries the pairing secret, tokens or account details anywhere in the serialized result", () => {
    const json = JSON.stringify(settingsSnapshot(seeded()));
    for (const leak of [SECRET, TOKEN, ACCOUNT, EMAIL, "SHOULD-NEVER-LEAK", "123456"]) expect(json).not.toContain(leak);
    for (const key of ["secret", "token", "tokens", "accounts", "authAlways", "password", "username", "pairing", "port"]) expect(json).not.toContain(`"${key}"`);
  });

  it("is built from an allowlist: unknown top-level and per-site keys are dropped", () => {
    const s = seeded() as any;
    s.sites["https://app.example.com"].futureField = SECRET;
    s.futureSetting = SECRET;
    const snap = settingsSnapshot(s) as any;
    expect(Object.keys(snap).sort()).toEqual(["authDenyHosts", "beforeUnload", "denylist", "devAllowSensitive", "forceLite", "liteSites", "onSessionEnd", "showOverlay", "sites", "vaultDenyHosts", "yolo"]);
    expect(JSON.stringify(snap)).not.toContain("SHOULD-NEVER-LEAK");
  });

  it("reports effective sign-in: YOLO turns it on for sites without an explicit off (#110)", () => {
    const s = migrateSettings({ yolo: true, sites: { "https://a.example": { policy: "act" }, "https://b.example": { auth: false } } });
    const snap = settingsSnapshot(s);
    expect(snap.sites["https://a.example"].auth).toBe(true);
    expect(snap.sites["https://b.example"].auth).toBe(false);
  });

  it("returns copies: mutating the snapshot does not touch the stored settings", () => {
    const s = migrateSettings({ denylist: ["a.example"] });
    const snap = settingsSnapshot(s);
    snap.denylist.push("b.example");
    snap.authDenyHosts.push("evil.example");
    expect(s.denylist).toEqual(["a.example"]);
    expect(AUTH_DENY_HOSTS).not.toContain("evil.example");
  });

  it("reports when YOLO switches itself off, and only then (#109)", () => {
    expect(settingsSnapshot(migrateSettings({ yolo: true, yoloExpiresAt: 1_700_000_000_000 }))).toMatchObject({ yolo: true, yoloExpiresAt: 1_700_000_000_000 });
    expect("yoloExpiresAt" in settingsSnapshot(migrateSettings({ yolo: true }))).toBe(false);
  });

  it("defaults round-trip", () => {
    const snap = settingsSnapshot(DEFAULTS);
    expect(snap).toMatchObject({ sites: {}, yolo: false, onSessionEnd: "collapse", beforeUnload: "accept", showOverlay: true, forceLite: false, liteSites: [] });
  });
});

describe("applyPreferences (#106)", () => {
  it("patches only the requested preference keys and reports each change", () => {
    const r = applyPreferences(DEFAULTS, { showOverlay: false, onSessionEnd: "close", forceLite: false });
    expect(r.patch).toEqual({ showOverlay: false, onSessionEnd: "close", forceLite: false });
    expect(r.applied).toEqual([
      { key: "showOverlay", from: true, to: false },
      { key: "onSessionEnd", from: "collapse", to: "close" },
    ]);
  });

  it("normalises liteSites (lowercase, trimmed, deduplicated) and diffs lists by value", () => {
    const r = applyPreferences({ ...DEFAULTS, liteSites: ["a.example"] }, { liteSites: ["A.example", " b.example ", "b.example"] });
    expect(r.patch.liteSites).toEqual(["a.example", "b.example"]);
    expect(r.applied).toEqual([{ key: "liteSites", from: ["a.example"], to: ["a.example", "b.example"] }]);
    expect(applyPreferences({ ...DEFAULTS, liteSites: ["a.example"] }, { liteSites: ["a.example"] }).applied).toEqual([]);
  });

  it("never patches a key outside the preference allowlist, even if the caller smuggles one in", () => {
    const r = applyPreferences(DEFAULTS, { showOverlay: false, yolo: true, secret: "x", paused: false } as any);
    expect(Object.keys(r.patch)).toEqual(["showOverlay"]);
  });
});

describe("isPanelSender: only TabAgent's own pages reach the UI API (resume stays panel-only)", () => {
  const ID = "pjpcgiijlaafoafgibplighdenoandid";
  const BASE = `chrome-extension://${ID}/`;
  it("accepts the side panel and the prompt window", () => {
    expect(isPanelSender({ id: ID, url: `${BASE}sidepanel.html` }, ID, BASE)).toBe(true);
    expect(isPanelSender({ id: ID, url: `${BASE}prompt.html?id=1` }, ID, BASE)).toBe(true);
  });
  it.each([
    ["a content script on a web page", { id: ID, url: "https://evil.example/", tab: { id: 3 } }],
    ["another extension", { id: "otherextensionidotherextensionid", url: "chrome-extension://otherextensionidotherextensionid/x.html" }],
    ["a page spoofing the path", { id: ID, url: `https://evil.example/${BASE}` }],
    ["no url", { id: ID }],
    ["nothing", undefined],
  ])("rejects %s", (_label, sender) => {
    expect(isPanelSender(sender as any, ID, BASE)).toBe(false);
  });
});
