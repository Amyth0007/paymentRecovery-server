import { describe, expect, it } from "vitest";
import { previousDay, shouldUsePreviousOvernightWorkday } from "./workday.js";

describe("overnight attendance workday", () => {
  it("moves early morning punches to the previous scheduled shift day", () => {
    expect(shouldUsePreviousOvernightWorkday(360, { crossesMidnight: true, endTime: "06:00" })).toBe(true);
    expect(previousDay("2026-11-23")).toBe("2026-11-22");
  });
  it("keeps daytime punches on the local date", () => {
    expect(shouldUsePreviousOvernightWorkday(420, { crossesMidnight: true, endTime: "06:00" })).toBe(false);
    expect(shouldUsePreviousOvernightWorkday(360, { crossesMidnight: false, endTime: "17:00" })).toBe(false);
  });
});
