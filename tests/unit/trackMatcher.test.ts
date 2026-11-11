import { describe, it, expect } from 'vitest';
import { containsKeyword, matchTracks } from '../../src/server/scrapers/trackMatcher.js';

describe('trackMatcher (Domain Track Matching & Word Boundary Logic)', () => {
  describe('containsKeyword', () => {
    it('returns false on empty text or empty keyword', () => {
      expect(containsKeyword('', 'solar')).toBe(false);
      expect(containsKeyword('some text', '')).toBe(false);
      expect(containsKeyword('', '')).toBe(false);
      expect(containsKeyword('   ', '   ')).toBe(false);
    });

    it('matches exact whole words case-insensitively', () => {
      expect(containsKeyword('Procurement of Solar Panels', 'solar')).toBe(true);
      expect(containsKeyword('procurement of SOLAR panels', 'solar')).toBe(true);
      expect(containsKeyword('procurement of solar panels', 'SOLAR')).toBe(true);
    });

    it('strictly enforces word boundaries (no substring false positives)', () => {
      // "care" must not match "car"
      expect(containsKeyword('Healthcare and medical supplies', 'car')).toBe(false);
      // "audit" must not match "it"
      expect(containsKeyword('Annual financial audit for FY 2026', 'it')).toBe(false);
      // "station" must not match "stationery"
      expect(containsKeyword('Railway station construction', 'stationery')).toBe(false);
      // "tar" must not match "target"
      expect(containsKeyword('Annual target achievement report', 'tar')).toBe(false);
    });

    it('supports plural inflections (-s and -es) (F7)', () => {
      expect(containsKeyword('Supply of high performance laptops', 'laptop')).toBe(true);
      expect(containsKeyword('Procurement of commercial buses for transit', 'bus')).toBe(true);
      expect(containsKeyword('Installation of solar panel units', 'solar panel')).toBe(true);
    });

    it('matches hyphenated and punctuation-adjacent words', () => {
      expect(containsKeyword('Solar-powered street light system', 'solar')).toBe(true);
      expect(containsKeyword('Supply of IT/network equipment', 'it')).toBe(true);
      expect(containsKeyword('(Solar) electrification of schools', 'solar')).toBe(true);
    });

    it('handles multi-word phrases with variable whitespace', () => {
      expect(containsKeyword('Procurement of civil   works and renovation', 'civil works')).toBe(true);
      expect(containsKeyword('Supply of computer hardware and peripherals', 'computer hardware')).toBe(true);
      expect(containsKeyword('Supply of computer and hardware peripherals', 'computer hardware')).toBe(false);
    });
  });

  describe('matchTracks', () => {
    const mockTracks = [
      {
        id: 1,
        name: 'IT & Software',
        positive_keywords: ['software', 'laptop', 'computer hardware', 'server'],
        negative_keywords: ['furniture', 'janitorial']
      },
      {
        id: 2,
        name: 'Solar & Energy',
        positive_keywords: ['solar', 'inverter', 'photovoltaic'],
        negative_keywords: ['generator']
      }
    ];

    it('matches tenders with positive track keywords', () => {
      const item = {
        title: 'Procurement of High End Laptops and Servers',
        organization: 'Punjab Information Technology Board',
        description: 'Supply and installation of branded core i7 laptops'
      };

      const result = matchTracks(item, mockTracks);
      expect(result.matchedTracks).toContain('IT & Software');
      expect(result.matchedKeywords).toContain('laptop');
      expect(result.matchedKeywords).toContain('server');
      expect(result.matchScore).toBeGreaterThanOrEqual(40);
    });

    it('strictly applies hard negative keyword gate (negative words veto match)', () => {
      const item = {
        title: 'Supply of Office Furniture and Laptops',
        organization: 'Higher Education Commission',
        description: 'Package includes executive chairs, wooden tables and desks with janitorial services'
      };

      const result = matchTracks(item, mockTracks);
      // Even though "laptop" is present, "furniture" and "janitorial" veto IT & Software
      expect(result.matchedTracks).not.toContain('IT & Software');
    });

    it('suppresses generic portal organization name to prevent 100% false-positives', () => {
      // If organization matches portal name (e.g. National Disaster Management Authority),
      // organization name itself should not trigger false track matches
      const item = {
        title: 'Construction of warehouse shelter',
        organization: 'National Disaster Management Authority (NDMA)',
        description: 'Civil construction of earthquake resistant shelter'
      };

      const result = matchTracks(item, mockTracks);
      expect(result.matchedTracks).toHaveLength(0);
    });

    it('returns empty matches when neither positive keywords nor semantic similarity meet thresholds', () => {
      const item = {
        title: 'Supply of fresh milk and bakery items',
        organization: 'District Jail Lahore',
        description: 'Daily dietary provisions for inmates'
      };

      const result = matchTracks(item, mockTracks);
      expect(result.matchedTracks).toHaveLength(0);
      expect(result.matchedKeywords).toHaveLength(0);
      expect(result.matchScore).toBe(0);
    });
  });
});
