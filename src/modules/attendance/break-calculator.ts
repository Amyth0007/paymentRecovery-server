import { nextDay } from "./workday.js";

export type ShiftBreak = {
  name: string;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
  paid: boolean;
};

export type ShiftInfo = {
  startTime?: string;
  endTime?: string;
  crossesMidnight?: boolean;
  breaks?: ShiftBreak[];
};

export function zonedDateTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const targetWallTime = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetWallTime;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const actualWallTime = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += targetWallTime - actualWallTime;
  }
  return new Date(guess);
}

export function calculateScheduledShiftMinutes(startTime: string, endTime: string, crossesMidnight: boolean): number {
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  let endMinutes = endH * 60 + endM;
  if (crossesMidnight || endMinutes <= startMinutes) {
    endMinutes += 1440;
  }
  return Math.max(0, endMinutes - startMinutes);
}

export function calculateWorkingMinutes(
  checkIn: Date,
  checkOut: Date,
  shift: ShiftInfo | null,
  workdayDate: string,
  timezone: string,
): { totalGrossMinutes: number; unpaidBreakMinutes: number; totalWorkingMinutes: number } {
  const totalGrossMinutes = Math.max(0, Math.floor((checkOut.getTime() - checkIn.getTime()) / 60_000));
  if (!shift || !shift.breaks || shift.breaks.length === 0) {
    return { totalGrossMinutes, unpaidBreakMinutes: 0, totalWorkingMinutes: totalGrossMinutes };
  }

  const [shiftStartH, shiftStartM] = (shift.startTime || "09:00").split(":").map(Number);
  const shiftStartMin = shiftStartH * 60 + shiftStartM;
  let unpaidBreakMinutes = 0;

  for (const brk of shift.breaks) {
    if (brk.paid) continue;
    const [bStartH, bStartM] = brk.startTime.split(":").map(Number);
    const [bEndH, bEndM] = brk.endTime.split(":").map(Number);
    const bStartMin = bStartH * 60 + bStartM;
    const bEndMin = bEndH * 60 + bEndM;

    let bStartDate = workdayDate;
    if (shift.crossesMidnight && bStartMin < shiftStartMin) {
      bStartDate = nextDay(workdayDate);
    }

    let bEndDate = bStartDate;
    if (bEndMin <= bStartMin) {
      bEndDate = nextDay(bStartDate);
    }

    const bStartUtc = zonedDateTimeToUtc(bStartDate, brk.startTime, timezone);
    const bEndUtc = zonedDateTimeToUtc(bEndDate, brk.endTime, timezone);

    const overlapStart = Math.max(checkIn.getTime(), bStartUtc.getTime());
    const overlapEnd = Math.min(checkOut.getTime(), bEndUtc.getTime());
    if (overlapEnd > overlapStart) {
      unpaidBreakMinutes += Math.floor((overlapEnd - overlapStart) / 60_000);
    }
  }

  const totalWorkingMinutes = Math.max(0, totalGrossMinutes - unpaidBreakMinutes);
  return { totalGrossMinutes, unpaidBreakMinutes, totalWorkingMinutes };
}
