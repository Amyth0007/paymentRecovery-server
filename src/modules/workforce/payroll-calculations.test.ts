import { describe, expect, it } from "vitest";
import { calculateAttendanceBaseMinor, calculateDailyAmountMinor, calculateOvertimeAmountMinor, calculatePercentageMinor, calculateProRataMinor } from "./payroll-calculations.js";

describe("integer payroll calculations", () => {
  it("rounds daily quantity and rate to the nearest minor unit", () => {
    expect(calculateDailyAmountMinor(1500, 101)).toBe(152);
  });
  it("calculates percentage components in basis points", () => {
    expect(calculatePercentageMinor(1800000, 1000)).toBe(180000);
  });
  it("calculates multiplied overtime pay without floating point drift", () => {
    expect(calculateOvertimeAmountMinor(180, 10000, 15000)).toBe(45000);
  });
  it("prorates unpaid leave against a period using integer units", () => {
    expect(calculateProRataMinor(1800000, 1500, 30000)).toBe(90000);
  });
  it("calculates daily and shift pay from completed attendance days", () => {
    expect(calculateAttendanceBaseMinor("daily", 70000, 8, 3840)).toBe(560000);
    expect(calculateAttendanceBaseMinor("shift", 85000, 4, 1920)).toBe(340000);
  });
  it("calculates hourly pay from finalized attendance minutes", () => {
    expect(calculateAttendanceBaseMinor("hourly", 10000, 2, 510)).toBe(85000);
  });
  it("rejects unsafe numeric inputs", () => {
    expect(() => calculateDailyAmountMinor(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
  });
});
