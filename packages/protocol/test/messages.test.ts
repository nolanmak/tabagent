import { describe, expect, it } from "vitest";
import {
  AuditRecordSchema,
  BridgeToExtSchema,
  CommandSchema,
  DEFAULT_PORT,
  ERROR_CODES,
  EventSchema,
  ExtToBridgeSchema,
  FilesResolveSchema,
  FilesResolvedSchema,
  HelloSchema,
  isErrorCode,
  normalizeHello,
  PROTOCOL_VERSION,
  ResultEnvelopeSchema,
  TabAgentError,
  toTabAgentError,
  versionMismatchHint,
  WelcomeSchema,
} from "@tabagent/protocol";

const audit = { tool: "act.click", origin: "https://a.example", params: { ref: "e1" }, outcome: "ok", resultSummary: { bytes: 2, sha256: "ab" } };
const valid = {
  hello: { type: "hello", protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0", pairCode: "ABC-DEF" },
  welcome: { type: "welcome", protocolVersion: PROTOCOL_VERSION, bridgeVersion: "0.1.0", secret: "s" },
  event: { type: "event", event: "killed", data: {} },
  command: { type: "command", id: "c1", session: { id: "s1", label: "local", cap: "full", sites: [] }, tool: "nav.goto", params: { url: "https://x" } },
  result: {
    type: "result",
    id: "c1",
    ok: true,
    result: {},
    snapshotDiff: "+ button",
    navigation: { url: "https://x", title: "X", kind: "link" },
    dialogs: [{ type: "alert", message: "hi" }],
    downloads: [{ id: 1, filename: "/tmp/a.csv", state: "complete" }],
    audit,
  },
  audit,
};

const schemas = {
  hello: HelloSchema,
  welcome: WelcomeSchema,
  event: EventSchema,
  command: CommandSchema,
  result: ResultEnvelopeSchema,
  audit: AuditRecordSchema,
} as const;

// One malformed example per required field: drop it.
const required: Record<keyof typeof schemas, string[]> = {
  hello: ["type", "protocolVersion", "extensionVersion"],
  welcome: ["type", "protocolVersion", "bridgeVersion"],
  event: ["type", "event"],
  command: ["type", "id", "session", "tool"],
  result: ["type", "id", "ok", "audit"],
  audit: ["tool", "origin", "outcome", "resultSummary"],
};

describe("envelope round-trips", () => {
  it.each(Object.keys(schemas) as (keyof typeof schemas)[])("%s parses and round-trips through JSON", (k) => {
    const parsed = schemas[k].parse(JSON.parse(JSON.stringify(valid[k])));
    expect(parsed).toEqual(valid[k]);
  });
  for (const k of Object.keys(required) as (keyof typeof schemas)[]) {
    it.each(required[k])(`${k} without %s is rejected`, (field) => {
      const bad: Record<string, unknown> = { ...valid[k] };
      delete bad[field];
      expect(schemas[k].safeParse(bad).success).toBe(false);
    });
  }
  it("session meta fields are required", () => {
    for (const f of ["id", "label", "cap", "sites"]) {
      const session: Record<string, unknown> = { ...valid.command.session };
      delete session[f];
      expect(CommandSchema.safeParse({ ...valid.command, session }).success, f).toBe(false);
    }
    expect(CommandSchema.safeParse({ ...valid.command, session: { ...valid.command.session, cap: "root" } }).success).toBe(false);
  });
  it("result rejects unknown error codes and bad outcomes", () => {
    expect(ResultEnvelopeSchema.safeParse({ ...valid.result, ok: false, error: { code: "NOPE", message: "x" } }).success).toBe(false);
    expect(AuditRecordSchema.safeParse({ ...audit, outcome: "maybe" }).success).toBe(false);
  });
  it("discriminated unions route by type", () => {
    expect(ExtToBridgeSchema.parse(valid.hello).type).toBe("hello");
    expect(ExtToBridgeSchema.parse({ type: "ping" }).type).toBe("ping");
    expect(ExtToBridgeSchema.parse(valid.result).type).toBe("result");
    expect(BridgeToExtSchema.parse(valid.welcome).type).toBe("welcome");
    expect(BridgeToExtSchema.parse({ type: "pong" }).type).toBe("pong");
    expect(BridgeToExtSchema.parse(valid.command).type).toBe("command");
    expect(BridgeToExtSchema.parse({ type: "session.closed", sessionId: "s" }).type).toBe("session.closed");
    expect(ExtToBridgeSchema.safeParse({ type: "welcome" }).success).toBe(false);
  });
  it("files.resolve / files.resolved", () => {
    expect(FilesResolveSchema.safeParse({ type: "files.resolve", id: "r", commandId: "c", paths: ["/a"] }).success).toBe(true);
    expect(FilesResolveSchema.safeParse({ type: "files.resolve", id: "r", commandId: "c", paths: [] }).success).toBe(false);
    expect(FilesResolvedSchema.safeParse({ type: "files.resolved", id: "r", ok: false, error: { code: "PERMISSION_DENIED", message: "x" } }).success).toBe(true);
  });
});

describe("legacy hello + version", () => {
  it("maps version -> extensionVersion and assumes protocol 1", () => {
    const h = normalizeHello({ type: "hello", secret: "s", version: "0.0.9", extensionId: "x" });
    expect(HelloSchema.parse(h)).toEqual({ type: "hello", secret: "s", protocolVersion: 1, extensionVersion: "0.0.9" });
  });
  it("leaves other messages alone", () => {
    expect(normalizeHello({ type: "ping" })).toEqual({ type: "ping" });
    expect(normalizeHello(null)).toBeNull();
    expect(normalizeHello(valid.hello)).toEqual(valid.hello);
  });
  it("mismatch hint names the side to update", () => {
    expect(versionMismatchHint(PROTOCOL_VERSION - 1)).toMatch(/Update the TabAgent extension/);
    expect(versionMismatchHint(PROTOCOL_VERSION + 1)).toMatch(/Update the @nolmak\/tabagent npm package/);
  });
  it("constants", () => {
    expect(DEFAULT_PORT).toBe(47615);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});

describe("error codes", () => {
  it("matches D14 exactly", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
  it.each([...ERROR_CODES])("%s is constructible and serialises as {code, message, hint?}", (code) => {
    const e = new TabAgentError(code, "msg");
    expect(JSON.parse(JSON.stringify(e))).toEqual({ code, message: "msg" });
    expect(new TabAgentError(code, "m", "h").toJSON()).toEqual({ code, message: "m", hint: "h" });
    expect(isErrorCode(code)).toBe(true);
  });
  it("pageText adds untrusted: true", () => {
    const e = new TabAgentError("NOT_ACTIONABLE", "covered by <div>", "close it", { pageText: true });
    expect(e.toJSON()).toEqual({ code: "NOT_ACTIONABLE", message: "covered by <div>", hint: "close it", untrusted: true });
    expect(TabAgentError.from(e.toJSON()).pageText).toBe(true);
  });
  it("from() and toTabAgentError() normalise junk", () => {
    expect(TabAgentError.from({ code: "WAT", message: 3 }).toJSON()).toEqual({ code: "INTERNAL", message: "Unknown error" });
    expect(toTabAgentError(new Error("boom\n  at stack")).toJSON()).toEqual({ code: "INTERNAL", message: "boom" });
    expect(toTabAgentError("x").code).toBe("INTERNAL");
    const t = new TabAgentError("KILLED", "k");
    expect(toTabAgentError(t)).toBe(t);
    expect(isErrorCode("nope")).toBe(false);
  });
});
