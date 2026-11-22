import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeText,
  calculateStringSimilarity,
  isValidReferenceNo,
  titlesAreDistinguishable,
  normalizeReferenceNo,
  findCanonicalMatch
} from '../../src/server/services/deduplicator.js';
import { db, initDatabase } from '../../src/server/db/index.js';
import { extractRefFromText } from '../../src/server/scrapers/crawlerEngine.js';

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
    expect(isValidReferenceNo('PSDF/PROC/2026/014')).toBe(true);
  });
});

describe('F3 Reference Number Extraction & Filtering (docs/15 F3 Table)', () => {
  it('extractRefFromText returns falsy for all 7 verified false-positive rows', () => {
    // 1. Month-year closing/opening fragments
    expect(extractRefFromText('Supply of solar panels Closing 15-Jun-2026 Opening 16-Jun-2026')).toBeFalsy();
    // 2. Month-year in tender notice
    expect(extractRefFromText('Tender Notice 30 June-2026')).toBeFalsy();
    // 3. Fiscal year notation
    expect(extractRefFromText('Procurement of IT equipment FY-2026-27 dated 01/07/2026')).toBeFalsy();
    // 4. Topic names with digits/hyphens
    expect(extractRefFromText('Hiring of firm for COVID-19 awareness')).toBeFalsy();
    // 5. Bare generic prefix with <= 2 digits
    expect(extractRefFromText('Construction of school RFP-01 Islamabad')).toBeFalsy();
    // 6. Lot notation
    expect(extractRefFromText('Lot-12 furniture')).toBeFalsy();
    // 7. Upload URLs containing year paths
    expect(extractRefFromText('Printing of books 2026-27 download /uploads/2026/05/file.pdf')).toBeFalsy();
  });

  it('normalizes genuine reference numbers and strips internal whitespace/formatting', () => {
    expect(normalizeReferenceNo('PSDF / PROC / 2026-014')).toBe('psdfproc2026014');
    expect(normalizeReferenceNo('PID (ABC) 123')).toBe('pidabc123');
    expect(normalizeReferenceNo('COVID-19')).toBeNull();
    expect(normalizeReferenceNo('Lot-12')).toBeNull();
  });
});

describe('A3 Title Distinguishability (docs/16 A3 Pairs)', () => {
  it('marks pairs differing by key content words as distinguishable so they stay separate', () => {
    // Pair 1: Laptops vs Printers
    expect(titlesAreDistinguishable('Supply of Laptops', 'Supply of Printers')).toBe(true);

    // Pair 2: Graphic Design vs Web Design
    expect(titlesAreDistinguishable(
      'Hiring of Training Providers for Graphic Design',
      'Hiring of Training Providers for Web Design'
    )).toBe(true);

    // Pair 3: Lahore Office vs Multan Office
    expect(titlesAreDistinguishable(
      'Procurement of Furniture for Lahore Office',
      'Procurement of Furniture for Multan Office'
    )).toBe(true);
  });

  it('allows identical or minor rephrasing without distinguishing tokens to merge across portals', () => {
    expect(titlesAreDistinguishable(
      'Procurement of IT Equipment and Servers for Data Center',
      'Procurement of IT Equipment and Servers for Data Center'
    )).toBe(false);

    // Minor stopword difference
    expect(titlesAreDistinguishable(
      'Supply and Installation of Solar Panels',
      'Supply of Solar Panels'
    )).toBe(false);
  });
});

describe('Cross-portal undated-vs-dated deduplication (Workstream E)', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM tenders').run();
  });

  it('matches an undated agency notice against a dated statutory tender when Dice >= 0.90 and orgSim >= 0.50, or Dice >= 0.94 regardless of orgSim', () => {
    db.prepare(`
      INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, ingestion_status)
      VALUES ('stat-1', 'stat-1', 'punjab_eproc', 'Punjab PPRA', NULL, 'Hiring of Industry Training Partners for Advance Technology Program (Round III)', 'Punjab Skills Development Fund', 'https://eproc.punjab.gov.pk/t/1', '2026-12-20T09:00:00.000Z', 'ready')
    `).run();

    // Case 1: Dice >= 0.90 & orgSim >= 0.50 (different punctuation/trailing whitespace)
    const matchWithOrg = findCanonicalMatch({
      title: 'Hiring of Industry Training Partners for Advance Technology Program Round III',
      organization: 'Punjab Skills Development Fund (PSDF)',
      closingDate: null,
      portalId: 'psdf'
    });
    expect(matchWithOrg.isDuplicate).toBe(true);
    expect(matchWithOrg.matchedTenderId).toBe('stat-1');
    expect(matchWithOrg.tier).toBe('lexical');

    // Case 2: Dice >= 0.94 even when orgSim < 0.50
    const matchHighDice = findCanonicalMatch({
      title: 'Hiring of Industry Training Partners for Advance Technology Program (Round III)',
      organization: 'PSDF Lahore Secretariat',
      closingDate: null,
      portalId: 'psdf'
    });
    expect(matchHighDice.isDuplicate).toBe(true);
    expect(matchHighDice.matchedTenderId).toBe('stat-1');
  });

  it('matches an incoming dated statutory tender against a recent undated agency tender', () => {
    db.prepare(`
      INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, ingestion_status, created_at)
      VALUES ('agency-1', 'agency-1', 'psdf', 'PSDF', NULL, 'Provision of HR Outsourcing Services for Regional Offices', 'Punjab Skills Development Fund (PSDF)', 'https://psdf.org.pk/hr.pdf', NULL, 'ready', datetime('now', '-2 days'))
    `).run();

    const match = findCanonicalMatch({
      title: 'Provision of HR Outsourcing Services for Regional Offices',
      organization: 'Punjab Skills Development Fund',
      closingDate: '2026-12-28T09:00:00.000Z',
      portalId: 'punjab_eproc'
    });
    expect(match.isDuplicate).toBe(true);
    expect(match.matchedTenderId).toBe('agency-1');
    expect(match.tier).toBe('lexical');
  });

  it('rejects mixed-date pairs when Dice < 0.90, when titles are distinguishable, or from the same portal (DED-3)', () => {
    db.prepare(`
      INSERT INTO tenders (id, canonical_id, portal_id, portal_name, reference_no, title, organization, direct_url, closing_date, ingestion_status)
      VALUES
        ('stat-lot1', 'stat-lot1', 'punjab_eproc', 'Punjab PPRA', NULL, 'Procurement of Lab Equipment for TEVTA Lahore Lot 1', 'TEVTA Punjab', 'https://eproc.punjab.gov.pk/t/lot1', '2026-12-25T09:00:00.000Z', 'ready'),
        ('stat-low', 'stat-low', 'epms_ppra', 'Federal PPRA', NULL, 'Consultancy Services for Curriculum Standardization and Assessment', 'NAVTTC', 'https://epms.ppra.gov.pk/t/low', '2026-12-25T09:00:00.000Z', 'ready')
    `).run();

    // Distinguishable (Lot 1 vs Lot 2, Lahore vs Multan) must stay separate despite high Dice
    const distLot = findCanonicalMatch({
      title: 'Procurement of Lab Equipment for TEVTA Lahore Lot 2',
      organization: 'TEVTA Punjab',
      closingDate: null,
      portalId: 'psdf'
    });
    expect(distLot.isDuplicate).toBe(false);

    const distCity = findCanonicalMatch({
      title: 'Procurement of Lab Equipment for TEVTA Multan Lot 1',
      organization: 'TEVTA Punjab',
      closingDate: null,
      portalId: 'psdf'
    });
    expect(distCity.isDuplicate).toBe(false);

    // Mixed-date pair below 0.90 lexical similarity must NOT merge
    const lowSim = findCanonicalMatch({
      title: 'Consultancy Services for Assessment Framework Design',
      organization: 'NAVTTC',
      closingDate: null,
      portalId: 'fde'
    });
    expect(lowSim.isDuplicate).toBe(false);

    // Same portal is strictly excluded (DED-3)
    const samePortal = findCanonicalMatch({
      title: 'Procurement of Lab Equipment for TEVTA Lahore Lot 1',
      organization: 'TEVTA Punjab',
      closingDate: null,
      portalId: 'punjab_eproc'
    });
    expect(samePortal.isDuplicate).toBe(false);
  });
});
