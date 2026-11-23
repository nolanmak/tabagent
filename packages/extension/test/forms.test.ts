import { describe, expect, it } from "vitest";
import { isRefKey, matchKeys, normLabel, type FieldDesc } from "../src/pure/labels";
import { planValue } from "../src/pure/coerce";
import { fillResult } from "../src/pure/fill";

const f = (ref: string, label: string, type = "text", extra: Partial<FieldDesc> = {}): FieldDesc => ({ ref, label, type, visible: true, ...extra });

describe("key classification", () => {
  it("e12 is a ref, Email is a label", () => {
    expect(isRefKey("e12")).toBe(true);
    expect(isRefKey("e0")).toBe(true);
    expect(isRefKey("Email")).toBe(false);
    expect(isRefKey("e12x")).toBe(false);
    expect(isRefKey("E12")).toBe(false);
    expect(isRefKey("l3")).toBe(false);
  });
  it("normalises case and whitespace", () => {
    expect(normLabel("  Email\n  Address ")).toBe("email address");
    expect(normLabel("Email *")).toBe("email");
    expect(normLabel("Email:")).toBe("email");
    expect(normLabel(null)).toBe("");
  });
});

describe("label matching (D34)", () => {
  const fields = [f("e1", "Email address"), f("e2", "Full  name"), f("e3", "Pro", "radio", { group: "Plan" }), f("e4", "Free", "radio", { group: "Plan" })];
  it("matches exact label case-insensitively after whitespace normalisation", () => {
    const m = matchKeys(["EMAIL   address", "full name"], fields);
    expect(m).toEqual([
      { key: "EMAIL   address", ref: "e1", field: fields[0] },
      { key: "full name", ref: "e2", field: fields[1] },
    ]);
  });
  it("is exact, not substring", () => {
    const [m] = matchKeys(["Email"], fields);
    expect(m.error?.code).toBe("NOT_FOUND");
  });
  it("zero matches fails the field with NOT_FOUND listing known labels", () => {
    const [m] = matchKeys(["Favourite colour"], fields);
    expect(m.error).toMatchObject({ code: "NOT_FOUND" });
    expect(m.error!.message).toContain("Email address");
  });
  it("two fields with one label -> BAD_REQUEST listing both refs; others still match", () => {
    const dup = [f("e1", "Email"), f("e2", "Email"), f("e3", "Name")];
    const res = matchKeys(["Email", "Name"], dup);
    expect(res[0].error?.code).toBe("BAD_REQUEST");
    expect(res[0].error?.message).toContain("e1");
    expect(res[0].error?.message).toContain("e2");
    expect(res[0].error?.candidates).toEqual(["e1", "e2"]);
    expect(res[1].ref).toBe("e3");
  });
  it("prefers the single visible candidate over hidden duplicates", () => {
    const dup = [f("e1", "Email", "email", { visible: false }), f("e2", "Email")];
    expect(matchKeys(["Email"], dup)[0].ref).toBe("e2");
  });
  it("a radio group is matched by its group label", () => {
    const [m] = matchKeys(["plan"], fields);
    expect(m.group?.map((x) => x.ref)).toEqual(["e3", "e4"]);
  });
  it("ref keys pass through", () => {
    const [m] = matchKeys(["e2"], fields);
    expect(m).toMatchObject({ key: "e2", ref: "e2" });
  });
  it("ref keys not in the form still pass through (resolved later)", () => {
    const [m] = matchKeys(["e99"], fields);
    expect(m).toMatchObject({ key: "e99", ref: "e99" });
  });
});

describe("value coercion (D34)", () => {
  it("checkbox true/false", () => {
    expect(planValue(f("e1", "Agree", "checkbox"), true)).toEqual({ kind: "check", ref: "e1", checked: true });
    expect(planValue(f("e1", "Agree", "checkbox"), false)).toEqual({ kind: "check", ref: "e1", checked: false });
    expect(planValue(f("e1", "Agree", "checkbox"), "true")).toEqual({ kind: "check", ref: "e1", checked: true });
    expect(planValue(f("e1", "Agree", "switch"), "false")).toEqual({ kind: "check", ref: "e1", checked: false });
    expect(planValue(f("e1", "Agree", "checkbox"), "maybe")).toMatchObject({ kind: "error", code: "BAD_REQUEST" });
  });
  it("select by option label, then value", () => {
    const sel = f("e1", "Country", "select", { options: [{ label: "Canada", value: "ca" }, { label: "ca", value: "x-ca" }, { label: "Mexico", value: "mx" }] });
    expect(planValue(sel, "canada")).toEqual({ kind: "select", ref: "e1", values: ["ca"] });
    // label wins over value
    expect(planValue(sel, "ca")).toEqual({ kind: "select", ref: "e1", values: ["x-ca"] });
    expect(planValue(sel, "mx")).toEqual({ kind: "select", ref: "e1", values: ["mx"] });
    expect(planValue(sel, "Peru")).toMatchObject({ kind: "error", code: "NOT_FOUND" });
    expect(planValue({ ...sel, type: "select-multiple" }, ["Canada", "mx"])).toEqual({ kind: "select", ref: "e1", values: ["ca", "mx"] });
  });
  it("radio group by label, then value", () => {
    const g = { key: "Plan", group: [f("e3", "Pro", "radio", { value: "pro" }), f("e4", "Free", "radio", { value: "free" })] };
    expect(planValue(g, "pro")).toEqual({ kind: "check", ref: "e3", checked: true });
    expect(planValue(g, "free")).toEqual({ kind: "check", ref: "e4", checked: true });
    expect(planValue(g, "Gold")).toMatchObject({ kind: "error", code: "NOT_FOUND" });
    expect(planValue(f("e3", "Pro", "radio"), true)).toEqual({ kind: "check", ref: "e3", checked: true });
  });
  it("ISO 8601 dates into date-like inputs", () => {
    expect(planValue(f("e1", "Start", "date"), "2026-01-15")).toEqual({ kind: "text", ref: "e1", text: "2026-01-15" });
    expect(planValue(f("e1", "Start", "date"), "2026-01-15T10:20:00Z")).toEqual({ kind: "text", ref: "e1", text: "2026-01-15" });
    expect(planValue(f("e1", "Start", "datetime-local"), "2026-01-15T10:20:00")).toEqual({ kind: "text", ref: "e1", text: "2026-01-15T10:20" });
    expect(planValue(f("e1", "Start", "month"), "2026-01-15")).toEqual({ kind: "text", ref: "e1", text: "2026-01" });
    expect(planValue(f("e1", "Start", "time"), "09:30")).toEqual({ kind: "text", ref: "e1", text: "09:30" });
    expect(planValue(f("e1", "Start", "date"), "15/01/2026")).toMatchObject({ kind: "error", code: "BAD_REQUEST" });
    expect(planValue(f("e1", "Start", "date"), "2026-13-01")).toMatchObject({ kind: "error", code: "BAD_REQUEST" });
  });
  it("combobox types then picks the exact option", () => {
    expect(planValue(f("e1", "City", "combobox"), "Paris")).toEqual({ kind: "combobox", ref: "e1", text: "Paris" });
  });
  it("text, textarea and contenteditable", () => {
    expect(planValue(f("e1", "Bio", "textarea"), "hi")).toEqual({ kind: "text", ref: "e1", text: "hi" });
    expect(planValue(f("e1", "Bio", "contenteditable"), "hi")).toEqual({ kind: "text", ref: "e1", text: "hi" });
    expect(planValue(f("e1", "Tags", "text"), ["a", "b"])).toEqual({ kind: "text", ref: "e1", text: "a, b" });
    expect(planValue(f("e1", "Age", "number"), true)).toMatchObject({ kind: "error", code: "BAD_REQUEST" });
  });
  it("file inputs are refused (use act.upload)", () => {
    expect(planValue(f("e1", "CV", "file"), "x")).toMatchObject({ kind: "error", code: "BAD_REQUEST" });
  });
});

describe("fill result", () => {
  it("always has filled and failed", () => {
    expect(fillResult([], [])).toEqual({ filled: [], failed: [] });
    const r = fillResult([{ key: "A", ref: "e1" }], [{ key: "B", code: "NOT_FOUND", message: "x" }]);
    expect(r.filled).toEqual([{ key: "A", ref: "e1" }]);
    expect(r.failed).toEqual([{ key: "B", code: "NOT_FOUND", message: "x" }]);
  });
});
