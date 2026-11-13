import { describe, it, expect } from 'vitest';
import { isValidReferenceNo, normalizeReferenceNo } from '../../src/server/services/referenceNo.js';

describe('referenceNo (Procurement Reference Normalization & Validation)', () => {
  describe('isValidReferenceNo', () => {
    it('returns false for null, undefined, empty, or whitespace-only inputs', () => {
      expect(isValidReferenceNo(null)).toBe(false);
      expect(isValidReferenceNo(undefined)).toBe(false);
      expect(isValidReferenceNo('')).toBe(false);
      expect(isValidReferenceNo('   ')).toBe(false);
    });

    it('returns false for strings shorter than 4 chars or longer than 40 chars', () => {
      expect(isValidReferenceNo('123')).toBe(false);
      expect(isValidReferenceNo('AB1')).toBe(false);
      expect(isValidReferenceNo('A'.repeat(41) + '1')).toBe(false);
    });

    it('returns false for generic words without valid reference structure', () => {
      expect(isValidReferenceNo('tender')).toBe(false);
      expect(isValidReferenceNo('procurement')).toBe(false);
      expect(isValidReferenceNo('corrigendum')).toBe(false);
      expect(isValidReferenceNo('quotation')).toBe(false);
      expect(isValidReferenceNo('bidding')).toBe(false);
    });

    it('returns false for strings without any digits', () => {
      expect(isValidReferenceNo('TENDER-NOTICE')).toBe(false);
      expect(isValidReferenceNo('PROCUREMENT-PKG')).toBe(false);
      expect(isValidReferenceNo('ABC-DEF-GHI')).toBe(false);
    });

    it('returns false for calendar dates formatted as references', () => {
      expect(isValidReferenceNo('15-06-2026')).toBe(false);
      expect(isValidReferenceNo('2026-06-15')).toBe(false);
      expect(isValidReferenceNo('06/2026')).toBe(false);
      expect(isValidReferenceNo('2026/04/12')).toBe(false);
    });

    it('returns false for non-reference prefixes (months, fiscal years, lots, upload paths)', () => {
      expect(isValidReferenceNo('Jun-2026')).toBe(false);
      expect(isValidReferenceNo('november-2025')).toBe(false);
      expect(isValidReferenceNo('FY-2026-27')).toBe(false);
      expect(isValidReferenceNo('Lot-12')).toBe(false);
      expect(isValidReferenceNo('covid-19')).toBe(false);
      expect(isValidReferenceNo('upload-12345')).toBe(false);
      expect(isValidReferenceNo('uploads/2026/05')).toBe(false);
      expect(isValidReferenceNo('item-42')).toBe(false);
      expect(isValidReferenceNo('annex-1')).toBe(false);
    });

    it('returns false for bare document types with short serials', () => {
      expect(isValidReferenceNo('RFP-01')).toBe(false);
      expect(isValidReferenceNo('rfp 12')).toBe(false);
      expect(isValidReferenceNo('NIT-5')).toBe(false);
      expect(isValidReferenceNo('EOI-99')).toBe(false);
      expect(isValidReferenceNo('Tender-1')).toBe(false);
    });

    it('returns false for file names and URL paths', () => {
      expect(isValidReferenceNo('tender_notice_123.pdf')).toBe(false);
      expect(isValidReferenceNo('specs_v2.docx')).toBe(false);
      expect(isValidReferenceNo('data/procurement/notice')).toBe(false);
      expect(isValidReferenceNo('uploads/2026/05/file')).toBe(false);
    });

    it('returns true for genuine procurement references', () => {
      expect(isValidReferenceNo('TSE-2425026')).toBe(true);
      expect(isValidReferenceNo('P&S/IT/2026/04')).toBe(true);
      expect(isValidReferenceNo('NDMA/PROC/2026/01')).toBe(true);
      expect(isValidReferenceNo('PUNJAB-FDE-8821')).toBe(true);
      expect(isValidReferenceNo('TEVTA/GIZ/2026-99')).toBe(true);
      expect(isValidReferenceNo('PPRA-ADV-10492')).toBe(true);
    });
  });

  describe('normalizeReferenceNo', () => {
    it('returns null for invalid references', () => {
      expect(normalizeReferenceNo(null)).toBeNull();
      expect(normalizeReferenceNo('')).toBeNull();
      expect(normalizeReferenceNo('tender')).toBeNull();
      expect(normalizeReferenceNo('15-06-2026')).toBeNull();
      expect(normalizeReferenceNo('RFP-01')).toBeNull();
    });

    it('lowercases and strips punctuation/spaces for valid references', () => {
      expect(normalizeReferenceNo('TSE-2425026')).toBe('tse2425026');
      expect(normalizeReferenceNo('P&S/IT/2026/04')).toBe('psit202604');
      expect(normalizeReferenceNo('NDMA / PROC / 2026-01')).toBe('ndmaproc202601');
      expect(normalizeReferenceNo('PUNJAB_FDE.8821')).toBe('punjabfde8821');
    });

    it('returns null if normalized alphanumeric string is shorter than 4 chars', () => {
      // Even if raw passes boundary, if normalized has < 4 chars
      expect(normalizeReferenceNo('A-1')).toBeNull();
    });
  });
});
