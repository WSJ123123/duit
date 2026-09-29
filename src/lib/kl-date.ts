/**
 * "Today" (yyyy-mm-dd) in the platform's home timezone, Asia/Kuala_Lumpur.
 * en-CA formats as yyyy-mm-dd. Callers pass the clock in — only route
 * boundaries read `new Date()`.
 */
export function klToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
  }).format(now);
}
