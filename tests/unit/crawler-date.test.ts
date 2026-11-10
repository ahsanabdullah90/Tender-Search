import { describe, it, expect } from 'vitest';
import { parseDateString, formatClosingDate, extractDatesFromText } from '../../src/server/scrapers/crawlerEngine.js';

describe('parseDateString - Pakistani Procurement Date Formats', () => {
  it('parses standard DD/MM/YYYY and DD-MM-YYYY formats', () => {
    const res1 = parseDateString('15/11/2026');
    expect(res1).toBeDefined();
    expect(res1).toContain('2026-11-15');

    const res2 = parseDateString('15-11-2026');
    expect(res2).toBeDefined();
    expect(res2).toContain('2026-11-15');
  });

  it('handles two-digit years (e.g. 05/04/26 -> 2026)', () => {
    const res = parseDateString('05/04/26');
    expect(res).toBeDefined();
    expect(res).toContain('2026-04-05');
  });

  it('treats 1/2/2026 as 1 February, NOT 2 January', () => {
    const res = parseDateString('1/2/2026');
    expect(res).toBeDefined();
    expect(res).toContain('2026-02-01');
  });

  it('handles times in 12-hour and 24-hour formats', () => {
    const resWithTime = parseDateString('15/11/2026 16:30');
    expect(resWithTime).toBeDefined();
    // 16:30 PKT (+05:00) is 11:30 UTC
    expect(resWithTime).toContain('2026-11-15T11:30:00.000Z');

    const resMorning = parseDateString('15/11/2026 09:15:30');
    expect(resMorning).toBeDefined();
    // 09:15:30 PKT is 04:15:30 UTC
    expect(resMorning).toContain('2026-11-15T04:15:30.000Z');
  });

  it('defaults closing time to 14:00 PKT (09:00 UTC) when time is omitted', () => {
    const res = parseDateString('15/11/2026');
    expect(res).toContain('2026-11-15T09:00:00.000Z');
  });

  it('parses named month formats (15 Nov 2026, 15-November-2026, 30 Oct, 2026, Month DD, YYYY, ordinals)', () => {
    const resShort = parseDateString('15 Nov 2026');
    expect(resShort).toBeDefined();
    expect(resShort).toContain('2026-11-15');

    const resLong = parseDateString('15-November-2026 15:00');
    expect(resLong).toBeDefined();
    expect(resLong).toContain('2026-11-15T10:00:00.000Z');

    const resComma = parseDateString('30 Oct, 2026');
    expect(resComma).toContain('2026-10-30');

    const resMonthFirst = parseDateString('September 25, 2026');
    expect(resMonthFirst).toContain('2026-09-25');

    const resMonthFirstShort = parseDateString('Aug 17, 2026');
    expect(resMonthFirstShort).toContain('2026-08-17');

    const resOrdinal = parseDateString('Jun 30th 2026');
    expect(resOrdinal).toContain('2026-06-30');

    const resMonthFirstTwoDigitYear = parseDateString('Oct 10, 26 15:30:00');
    expect(resMonthFirstTwoDigitYear).toContain('2026-10-10');

    expect(parseDateString('Feb 31, 2026')).toBeNull();
  });

  it('parses ISO format YYYY-MM-DD and with T', () => {
    const res = parseDateString('2026-11-15');
    expect(res).toBeDefined();
    expect(res).toContain('2026-11-15');

    const resT = parseDateString('2026-11-15T14:00:00');
    expect(resT).toBeDefined();
    expect(resT).toContain('2026-11-15');
  });

  it('rejects impossible dates (31/02/2026, 32/01/2026, month 13)', () => {
    expect(parseDateString('31/02/2026')).toBeNull();
    expect(parseDateString('32/01/2026')).toBeNull();
    expect(parseDateString('15/13/2026')).toBeNull();
    expect(parseDateString('31/04/2026')).toBeNull(); // April has 30 days
  });

  it('rejects invalid or empty date text, text noise, and Not Available', () => {
    expect(parseDateString('')).toBeNull();
    expect(parseDateString('   ')).toBeNull();
    expect(parseDateString('Not Available')).toBeNull();
    expect(parseDateString('N/A')).toBeNull();
    expect(parseDateString('none')).toBeNull();
    expect(parseDateString('random text noise')).toBeNull();
    expect(parseDateString('null')).toBeNull();
  });

  it('handles fallback standard dates if valid and containing digits', () => {
    const fallback = parseDateString('Sun Nov 15 2026 14:00:00 GMT+0500');
    expect(fallback).toBeDefined();
    expect(fallback).toContain('2026-11-15');
  });
});

describe('formatClosingDate', () => {
  it('returns "Not Available" for null, undefined, or invalid ISO strings', () => {
    expect(formatClosingDate(null)).toBe('Not Available');
    expect(formatClosingDate('')).toBe('Not Available');
    expect(formatClosingDate('invalid-iso-date')).toBe('Not Available');
  });

  it('formats valid ISO dates with 12-hour clock and PKT suffix', () => {
    const formatted = formatClosingDate('2026-11-15T09:00:00.000Z');
    expect(formatted).toContain('PKT');
    expect(formatted).toMatch(/15\s+Nov\s+2026/);
    expect(formatted).toMatch(/(AM|PM)/);
  });
});

describe('extractDatesFromText', () => {
  it('extracts publishDate from Create Date / Creation labels', () => {
    const res1 = extractDatesFromText('Create Date October 22, 2025 Last Updated October 22, 2025');
    expect(res1.publishDate).toContain('2025-10-22');

    const res2 = extractDatesFromText('Create Date: 15/11/2026 Submission Deadline: 30/11/2026');
    expect(res2.publishDate).toContain('2026-11-15');
    expect(res2.closingDate).toContain('2026-11-30');

    const res3 = extractDatesFromText('Creation Date: 05-Oct-2025 Due Date: 20-Oct-2025');
    expect(res3.publishDate).toContain('2025-10-05');
    expect(res3.closingDate).toContain('2025-10-20');
  });
});

import { normalizeExtractedDate, reconcileDeadline } from '../../src/server/scrapers/dateParser.js';

describe('Extracted date normalization & deadline reconciliation (audit findings 1 & 4)', () => {
  const NOW = Date.parse('2026-11-10T09:00:00.000Z');

  it('does not shift explicit-offset ISO timestamps by the PKT offset', () => {
    expect(parseDateString('2026-12-20T10:00:00Z')).toBe('2026-12-20T10:00:00.000Z');
    expect(parseDateString('2026-12-20T10:00:00.000Z')).toBe('2026-12-20T10:00:00.000Z');
    expect(parseDateString('2026-12-20T15:00:00+05:00')).toBe('2026-12-20T10:00:00.000Z');
    // Round-tripping a stored value is now idempotent
    const once = parseDateString('20/12/2026 15:00')!;
    expect(parseDateString(once)).toBe(once);
  });

  it('normalizes OCR dates and rejects unparseable model output', () => {
    expect(normalizeExtractedDate('2026-12-20T15:00:00+05:00')).toBe('2026-12-20T10:00:00.000Z');
    expect(normalizeExtractedDate('20/12/2026')).toBe('2026-12-20T09:00:00.000Z');
    expect(normalizeExtractedDate('next Friday')).toBeNull();
    expect(normalizeExtractedDate('Not Available')).toBeNull();
    expect(normalizeExtractedDate('')).toBeNull();
    expect(normalizeExtractedDate(null)).toBeNull();
  });

  it('keeps a later known deadline when an attachment shows an earlier, past one', () => {
    const r = reconcileDeadline('2026-12-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z', NOW);
    expect(r.closingDate).toBe('2026-12-01T09:00:00.000Z');
    expect(r.isExpired).toBe(false);
    expect(r.isExtension).toBe(false);
  });

  it('adopts a later extracted deadline as an extension', () => {
    const r = reconcileDeadline('2026-12-01T09:00:00.000Z', '2026-12-15T09:00:00.000Z', NOW);
    expect(r.closingDate).toBe('2026-12-15T09:00:00.000Z');
    expect(r.isExtension).toBe(true);
    expect(r.isExpired).toBe(false);
  });

  it('expires only when no later valid deadline is known', () => {
    expect(reconcileDeadline(null, '2026-10-01T09:00:00Z', NOW).isExpired).toBe(true);
    expect(reconcileDeadline('garbage', '2026-10-01T09:00:00Z', NOW).isExpired).toBe(true);
    expect(reconcileDeadline(null, 'garbage', NOW)).toEqual({ closingDate: null, isExtension: false, isExpired: false });
  });
});
