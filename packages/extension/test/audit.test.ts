import { describe, expect, it } from "vitest";
import { buildAudit, liftSide, MASK, outcomeFor, redactParams, sha256Hex, summarizeResult } from "../src/background/audit";

describe("redactParams", () => {
  it("masks sensitive keys, card-like and SSN-like values", () => {
    const r = redactParams({ password: "hunter2", fields: { "Card number": "4242 4242 4242 4242", Name: "Neo", ssn: "123-45-6789", note: "123-45-6789" }, otp: 123456, maxTokens: 500, url: "https://a.example" }) as any;
    expect(r.password).toBe(MASK);
    expect(r.fields["Card number"]).toBe(MASK);
    expect(r.fields.Name).toBe("Neo");
    expect(r.fields.ssn).toBe(MASK);
    expect(r.fields.note).toBe(MASK);
    expect(r.otp).toBe(MASK);
    expect(r.maxTokens).toBe(500);
    expect(r.url).toBe("https://a.example");
  });
  it("masks caller-marked paths (password field typed by ref)", () => {
    const r = redactParams({ ref: "e4", text: "hunter2" }, { sensitivePaths: ["text"] }) as any;
    expect(r).toEqual({ ref: "e4", text: MASK });
    const f = redactParams({ fields: { e9: "pw", e10: "ok" } }, { sensitivePaths: ["fields.e9"] }) as any;
    expect(f.fields).toEqual({ e9: MASK, e10: "ok" });
    const nested = redactParams({ fields: { e9: { a: "x" } } }, { sensitivePaths: ["fields.e9"] }) as any;
    expect(nested.fields.e9).toEqual({ a: MASK });
  });
  it("truncates long strings and walks arrays", () => {
    const r = redactParams({ values: ["a", "4111111111111111"], text: "x".repeat(400) }, { maxString: 10 }) as any;
    expect(r.values).toEqual(["a", MASK]);
    expect(r.text).toBe("x".repeat(10) + "…");
  });
  it("property: a value under a sensitive key never survives, whatever its shape", () => {
    const secret = "S3cr3t-value-xyz";
    for (const key of ["password", "passcode", "pwd", "secret", "apiToken", "cardNumber", "cvv", "cvc", "ssn", "iban", "pin", "otp"]) {
      for (const v of [secret, [secret], { inner: secret }, [{ x: secret }]]) {
        expect(JSON.stringify(redactParams({ [key]: v }))).not.toContain(secret);
      }
    }
  });
  it("non-JSON values are masked", () => {
    expect(redactParams({ f: () => 1 } as any)).toEqual({ f: MASK });
    expect(redactParams(null)).toBeNull();
  });
});

describe("audit record", () => {
  it("summarizes the result as bytes + sha256 only", async () => {
    const s = await summarizeResult({ a: 1 });
    expect(s.bytes).toBe(7);
    expect(s.sha256).toBe(await sha256Hex('{"a":1}'));
    expect((await summarizeResult(undefined)).bytes).toBe(0);
  });
  it("buildAudit has the D20 shape and no raw result", async () => {
    const a = await buildAudit({ tool: "tabs", action: "new", origin: "https://a.example", params: { password: "x" }, outcome: "ok", result: { secret: "body" } });
    expect(a).toMatchObject({ tool: "tabs", action: "new", origin: "https://a.example", params: { password: MASK }, outcome: "ok" });
    expect(JSON.stringify(a)).not.toContain("body");
    const e = await buildAudit({ tool: "x", origin: null, params: undefined, outcome: "error", errorCode: "TIMEOUT" });
    expect(e.errorCode).toBe("TIMEOUT");
    expect(e.params).toEqual({});
    expect("action" in e).toBe(false);
  });
  it("outcomeFor", () => {
    expect(outcomeFor(undefined)).toBe("ok");
    expect(outcomeFor("PERMISSION_DENIED")).toBe("denied");
    expect(outcomeFor("KILLED")).toBe("denied");
    expect(outcomeFor("PROMPT_TIMEOUT")).toBe("denied");
    expect(outcomeFor("TIMEOUT")).toBe("error");
  });
});

describe("liftSide (contract §3)", () => {
  it("strips __side and lifts known fields", () => {
    const r = liftSide({ ok: true, __side: { snapshotDiff: "+ x", navigation: { url: "u", title: "t", kind: "link" }, dialogs: [{ type: "alert", message: "m" }], downloads: [{ id: 1, filename: "f", state: "complete" }], junk: 1, snapshotDiffNull: null } });
    expect(r.result).toEqual({ ok: true });
    expect(r.side).toEqual({ snapshotDiff: "+ x", navigation: { url: "u", title: "t", kind: "link" }, dialogs: [{ type: "alert", message: "m" }], downloads: [{ id: 1, filename: "f", state: "complete" }] });
  });
  it("absent __side means nothing happened", () => {
    expect(liftSide({ a: 1 })).toEqual({ result: { a: 1 }, side: {} });
    expect(liftSide([1])).toEqual({ result: [1], side: {} });
    expect(liftSide(null)).toEqual({ result: null, side: {} });
    expect(liftSide({ __side: null, a: 1 })).toEqual({ result: { a: 1 }, side: {} });
  });
});
