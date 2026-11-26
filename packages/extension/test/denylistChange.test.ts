import { describe, expect, it } from "vitest";
import { applyDenylistChanges, validateDenylistChanges } from "../src/pure/denylistChange";

describe("denylist changes (#67)", () => {
  it("validates and applies an exact add/remove diff without duplicates", () => {
    const changes = validateDenylistChanges([
      { op: "remove", glob: " *.bank.example " },
      { op: "add", glob: "payments.example" },
      { op: "add", glob: "payments.example" },
    ]);
    expect(changes).toEqual([
      { op: "remove", glob: "*.bank.example" },
      { op: "add", glob: "payments.example" },
      { op: "add", glob: "payments.example" },
    ]);
    expect(applyDenylistChanges(["*.bank.example", "other.example"], changes)).toEqual({
      denylist: ["other.example", "payments.example"],
      applied: [changes[0], changes[1]],
    });
  });

  it.each(["", "https://bank.example", "*.bad.*.example", "bad/path", "*.com", "*", "localhost", "a..example"]) ("rejects unsafe or ambiguous glob %j", (glob) => {
    expect(() => validateDenylistChanges([{ op: "add", glob }])).toThrow(/glob/i);
  });

  it("does not let a no-op removal manufacture an approval", () => {
    const changes = validateDenylistChanges([{ op: "remove", glob: "missing.example" }]);
    expect(applyDenylistChanges(["kept.example"], changes)).toEqual({
      denylist: ["kept.example"],
      applied: [],
    });
  });
});
