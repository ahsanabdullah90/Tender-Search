import { describe, it, expect } from 'vitest';
import { parseDateString, formatClosingDate } from '../../src/server/scrapers/crawlerEngine.js';

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

  it('parses named month formats (15 Nov 2026, 15-November-2026)', () => {
    const resShort = parseDateString('15 Nov 2026');
    expect(resShort).toBeDefined();
    expect(resShort).toContain('2026-11-15');

    const resLong = parseDateString('15-November-2026 15:00');
    expect(resLong).toBeDefined();
    expect(resLong).toContain('2026-11-15T10:00:00.000Z');
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
