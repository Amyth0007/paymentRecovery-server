export function calendarDate(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    calendarDate(timeZone);
    return true;
  } catch {
    return false;
  }
}
