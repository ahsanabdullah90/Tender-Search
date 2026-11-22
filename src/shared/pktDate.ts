export const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Returns the canonical `YYYY-MM-DD` calendar date in Pakistan Standard Time (`UTC+05:00`),
 * or `''` when the input does not represent a valid date/timestamp.
 */
export function getPktDateKey(input: Date | number | string = Date.now()): string {
  let ms: number;
  if (input instanceof Date) {
    ms = input.getTime();
  } else if (typeof input === 'number') {
    ms = input;
  } else {
    const trimmed = String(input || '').trim();
    if (!trimmed) return '';
    ms = Date.parse(trimmed);
  }
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * End of the PKT calendar day (`23:59:59.999+05:00`) for the given instant, as epoch milliseconds,
 * or `NaN` when the input does not represent a valid date/timestamp.
 */
export function endOfPktDayMs(input: Date | number | string): number {
  const day = getPktDateKey(input);
  return day ? Date.parse(`${day}T23:59:59.999+05:00`) : NaN;
}
