/** Business day in the organization's timezone, YYYY-MM-DD. */
export function businessDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Bill time as the frontend shows it, e.g. "08:45 AM". */
export function businessTime(timeZone: string, at: Date): string {
  return at.toLocaleTimeString('en-US', { timeZone, hour: '2-digit', minute: '2-digit' });
}

export function addCalendarDays(isoDate: string, days: number): string {
  const date = toDbDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return fromDbDate(date);
}

/** Postgres `date` columns travel as UTC-midnight Date objects. */
export const toDbDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);
export const fromDbDate = (date: Date): string => date.toISOString().slice(0, 10);

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((toDbDate(toIso).getTime() - toDbDate(fromIso).getTime()) / 86_400_000);
