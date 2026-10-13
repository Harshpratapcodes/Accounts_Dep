/**
 * The business date. GST and the Indian financial year run on Indian time;
 * the server runs in UTC. Anything that asks "what is today?" for a document
 * date, a future-date guard or a financial year asks here, never
 * `new Date().toISOString()` (which is a day behind until 05:30 IST).
 * The database agrees: migration 0002 and withTransaction set its TimeZone to
 * the same zone, so CURRENT_DATE is this date too.
 */
export const BUSINESS_TZ = "Asia/Kolkata";

const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

let fixedToday: string | null = null;

/** Today's date in India as YYYY-MM-DD. */
export function businessToday(): string {
  return fixedToday ?? ymd.format(new Date());
}

/** Test seam: pin "today" (or pass null to release it). Refuses in production. */
export function setFixedToday(date: string | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setFixedToday is test-only");
  fixedToday = date;
}

/** True for a YYYY-MM-DD string naming a real calendar date (rejects 2026-02-30). */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** First year of the Indian financial year (1 April to 31 March) containing `date`. */
export function fyStartYear(date: string): number {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return m < 4 ? y - 1 : y;
}
