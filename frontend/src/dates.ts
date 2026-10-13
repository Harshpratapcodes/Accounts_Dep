/** Today's date in India as YYYY-MM-DD: the business date the server
 *  validates against (src/shared/clock.ts). `toISOString()` is the UTC date,
 *  a day behind until 05:30 IST, which made form defaults yesterday. */
const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});

export const today = (): string => ymd.format(new Date());
