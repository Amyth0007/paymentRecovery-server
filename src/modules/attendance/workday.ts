export function previousDay(date: string): string {
  const day = new Date(`${date}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function nextDay(date: string): string {
  const day = new Date(`${date}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export function shouldUsePreviousOvernightWorkday(minuteOfDay: number, shift: { crossesMidnight: boolean; endTime: string } | null): boolean {
  if (!shift?.crossesMidnight) return false;
  const [hour, minute] = shift.endTime.split(":").map(Number);
  return minuteOfDay <= hour * 60 + minute;
}
