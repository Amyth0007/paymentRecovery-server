import { describe, expect, it } from "vitest";
import {
  calculateScheduledShiftMinutes,
  calculateWorkingMinutes,
  zonedDateTimeToUtc,
} from "./break-calculator.js";

describe("break-calculator", () => {
  it("converts zoned datetime to utc date accurately", () => {
    const utcDate = zonedDateTimeToUtc("2026-11-22", "13:30", "Asia/Kolkata");
    expect(utcDate.toISOString()).toBe("2026-11-22T08:00:00.000Z");
  });

  it("calculates scheduled shift minutes for daytime and overnight shifts", () => {
    expect(calculateScheduledShiftMinutes("09:00", "17:00", false)).toBe(480);
    expect(calculateScheduledShiftMinutes("22:00", "06:00", true)).toBe(480);
    expect(calculateScheduledShiftMinutes("08:00", "12:00", false)).toBe(240);
  });

  it("deducts unpaid breaks from working minutes", () => {
    const shift = {
      startTime: "09:00",
      endTime: "17:00",
      crossesMidnight: false,
      breaks: [
        { name: "Lunch", startTime: "13:00", endTime: "14:00", paid: false },
        { name: "Coffee", startTime: "11:00", endTime: "11:15", paid: true },
      ],
    };

    const inTime = zonedDateTimeToUtc("2026-11-22", "09:00", "Asia/Kolkata");
    const outTime = zonedDateTimeToUtc("2026-11-22", "17:00", "Asia/Kolkata");

    const result = calculateWorkingMinutes(inTime, outTime, shift, "2026-11-22", "Asia/Kolkata");
    expect(result.totalGrossMinutes).toBe(480);
    expect(result.unpaidBreakMinutes).toBe(60);
    expect(result.totalWorkingMinutes).toBe(420);
  });

  it("handles overnight shifts with breaks across midnight correctly", () => {
    const shift = {
      startTime: "22:00",
      endTime: "06:00",
      crossesMidnight: true,
      breaks: [
        { name: "Tea", startTime: "23:45", endTime: "00:15", paid: false },
        { name: "Rest", startTime: "02:00", endTime: "02:45", paid: false },
      ],
    };

    const inTime = zonedDateTimeToUtc("2026-11-22", "22:00", "Asia/Kolkata");
    const outTime = zonedDateTimeToUtc("2026-11-23", "06:00", "Asia/Kolkata");

    const result = calculateWorkingMinutes(inTime, outTime, shift, "2026-11-22", "Asia/Kolkata");
    expect(result.totalGrossMinutes).toBe(480);
    expect(result.unpaidBreakMinutes).toBe(75);
    expect(result.totalWorkingMinutes).toBe(405);
  });

  it("returns gross minutes when no breaks exist", () => {
    const inTime = zonedDateTimeToUtc("2026-11-22", "09:00", "Asia/Kolkata");
    const outTime = zonedDateTimeToUtc("2026-11-22", "17:00", "Asia/Kolkata");

    const result = calculateWorkingMinutes(inTime, outTime, null, "2026-11-22", "Asia/Kolkata");
    expect(result.totalGrossMinutes).toBe(480);
    expect(result.unpaidBreakMinutes).toBe(0);
    expect(result.totalWorkingMinutes).toBe(480);
  });
});
