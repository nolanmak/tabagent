// #25: one real test per package. The protocol package exports PROTOCOL_VERSION.
import { describe, expect, it } from "vitest";
import * as protocol from "@tabagent/protocol";

describe("protocol package", () => {
  it("exports PROTOCOL_VERSION as a positive integer", () => {
    expect(Number.isInteger(protocol.PROTOCOL_VERSION)).toBe(true);
    expect(protocol.PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("exports DEFAULT_PORT 47615 (D4)", () => {
    expect(protocol.DEFAULT_PORT).toBe(47615);
  });
});
