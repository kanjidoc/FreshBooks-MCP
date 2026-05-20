/**
 * Parse a "YYYY-MM-DD" date argument into a Date at LOCAL midnight.
 *
 * `new Date("YYYY-MM-DD")` parses the string as UTC midnight, which is the
 * previous calendar day in any negative-UTC-offset timezone. The FreshBooks
 * SDK's `transformDateRequest` then serializes the Date back using its
 * local-time fields, so the wrong day reaches the API. Appending a time forces
 * local-time parsing — the same convention the SDK uses in
 * `transformDateResponse` for date-only accounting fields.
 *
 * Only for date-only ("YYYY-MM-DD") fields on accounting resources. Full
 * timestamps (e.g. time-entry `started_at`) must keep their explicit offset.
 */
export function parseLocalDate(dateString: string): Date {
  return new Date(`${dateString} 00:00:00`);
}
