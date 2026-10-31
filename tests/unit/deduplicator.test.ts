import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  calculateStringSimilarity,
  isValidReferenceNo
} from '../../src/server/deduplicator.js';

describe('normalizeText', () => {
  it('converts to lowercase and trims whitespace', () => {
    expect(normalizeText('  HELLO WORLD  ')).toBe('hello world');
  });

  it('replaces ASCII punctuation with space and collapses multiple spaces', () => {
    expect(normalizeText('Solar/Panels - Inverter (5kW)!')).toBe('solar panels inverter 5kw');
  });

  it('preserves Urdu and Unicode letters and numbers sensibly', () => {
    expect(normalizeText('ٹیلی کام ڈویژن 2026')).toBe('ٹیلی کام ڈویژن 2026');
  });

  it('handles empty or blank text gracefully', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
  });
});

describe('calculateStringSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(calculateStringSimilarity('Procurement of IT Equipment', 'Procurement of IT Equipment')).toBe(1.0);
    expect(calculateStringSimilarity('hello', 'HELLO')).toBe(1.0);
  });

  it('returns 0.0 for empty or single-character strings', () => {
    expect(calculateStringSimilarity('', '')).toBe(0.0);
    expect(calculateStringSimilarity('a', 'a')).toBe(0.0);
    expect(calculateStringSimilarity('a', 'b')).toBe(0.0);
  });

  it('returns 0.0 for strings with no common bigrams', () => {
    expect(calculateStringSimilarity('abcdef', 'uvwxyz')).toBe(0.0);
  });

  it('calculates Dice bigram coefficient accurately with repeated bigrams', () => {
    // "night" (ni, ig, gh, ht) vs "nacht" (na, ac, ch, ht) -> intersection: 'ht' (1)
    // total: 4 + 4 = 8 -> 2*1 / 8 = 0.25
    expect(calculateStringSimilarity('night', 'nacht')).toBeCloseTo(0.25, 2);
  });

  it('evaluates near the 0.85 deduplication threshold boundary', () => {
    const s1 = 'Rehabilitation of District Hospital Swat Communication and Works';
    const s2 = 'Rehabilitation of District Hospital Swat Communication & Works';
    const sim = calculateStringSimilarity(s1, s2);
    expect(sim).toBeGreaterThanOrEqual(0.85);
  });
});

describe('isValidReferenceNo', () => {
  it('returns false for null, undefined, or empty strings', () => {
    expect(isValidReferenceNo(null)).toBe(false);
    expect(isValidReferenceNo(undefined)).toBe(false);
    expect(isValidReferenceNo('')).toBe(false);
    expect(isValidReferenceNo('   ')).toBe(false);
  });

  it('returns false for strings that are too short (< 4) or too long (> 40)', () => {
    expect(isValidReferenceNo('A1')).toBe(false);
    expect(isValidReferenceNo('123')).toBe(false);
    expect(isValidReferenceNo('A'.repeat(45) + '1')).toBe(false);
  });

  it('returns false if there is no digit', () => {
    expect(isValidReferenceNo('TenderNotice')).toBe(false);
    expect(isValidReferenceNo('ProcurementDepartment')).toBe(false);
  });

  it('returns false for blacklisted generic words even if trimmed', () => {
    expect(isValidReferenceNo('Tender')).toBe(false);
    expect(isValidReferenceNo('Notice')).toBe(false);
    expect(isValidReferenceNo('Procurement')).toBe(false);
    expect(isValidReferenceNo('Tenders')).toBe(false);
    expect(isValidReferenceNo('Quotation')).toBe(false);
    expect(isValidReferenceNo('Corrigendum')).toBe(false);
    expect(isValidReferenceNo('Advertisement')).toBe(false);
    expect(isValidReferenceNo('Bidding')).toBe(false);
  });

  it('returns true for genuine procurement reference numbers', () => {
    expect(isValidReferenceNo('TS12345')).toBe(true);
    expect(isValidReferenceNo('PID (ABC) 123')).toBe(true);
    expect(isValidReferenceNo('NDMA/INFRA/890')).toBe(true);
    expect(isValidReferenceNo('PROC-2026-99')).toBe(true);
    expect(isValidReferenceNo('FDE-EDU-001')).toBe(true);
  });
});
