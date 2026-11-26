import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "../src/pure/cron";

describe("workflow cron schedules", () => {
  it("validates five-field cron and matches in the requested IANA zone", () => {
    expect(parseCron("*/15 9-17 * * 1-5")[0].has(45)).toBe(true);
    expect(cronMatches("0 9 * * 1-5", new Date("2026-01-05T17:00:00Z"), "America/Los_Angeles")).toBe(true);
    expect(cronMatches("0 9 * * 1-5", new Date("2026-01-05T17:01:00Z"), "America/Los_Angeles")).toBe(false);
  });
  it("rejects invalid forms", () => expect(() => parseCron("every hour")).toThrow(/five fields/i));
});
