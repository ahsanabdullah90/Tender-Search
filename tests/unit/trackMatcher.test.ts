import { describe, it, expect } from 'vitest';
import { containsKeyword, matchTracks, type MatchableItem } from '../../src/server/scrapers/trackMatcher.js';

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
      expect(containsKeyword('Enterprise network switches for data centers', 'switch')).toBe(true);
    });

    it('matches hyphenated and punctuation-adjacent words', () => {
      expect(containsKeyword('Solar-powered street light system', 'solar')).toBe(true);
      expect(containsKeyword('Supply of IT/network equipment', 'it')).toBe(true);
      expect(containsKeyword('(Solar) electrification of schools', 'solar')).toBe(true);
      expect(containsKeyword('High-end laptops/desktops', 'laptop')).toBe(true);
    });

    it('handles multi-word phrases with variable whitespace', () => {
      expect(containsKeyword('Procurement of civil   works and renovation', 'civil works')).toBe(true);
      expect(containsKeyword('Supply of computer hardware and peripherals', 'computer hardware')).toBe(true);
      expect(containsKeyword('Supply of computer and hardware peripherals', 'computer hardware')).toBe(false);
      expect(containsKeyword('Civil engineer for road works', 'civil works')).toBe(false);
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
      const item: MatchableItem = {
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
      const item: MatchableItem = {
        title: 'Supply of Office Furniture and Laptops',
        organization: 'Higher Education Commission',
        description: 'Package includes executive chairs, wooden tables and desks with janitorial services'
      };

      const result = matchTracks(item, mockTracks);
      // Even though "laptop" is present, "furniture" and "janitorial" veto IT & Software
      expect(result.matchedTracks).not.toContain('IT & Software');
    });

    it('is case-insensitive for text, organization, referenceNo, and keywords', () => {
      const itemWithMixedCase: MatchableItem = {
        title: 'rFp fOr cLoUd HoStInG',
        organization: 'NADRA Tech',
        referenceNo: 'NADRA-CLOUD-99'
      };

      const tracks = [
        {
          id: 'track-cloud',
          name: 'Cloud Services',
          positive_keywords: ['CLOUD HOSTING', 'nadra'],
          negative_keywords: ['HARDWARE']
        }
      ];

      const result = matchTracks(itemWithMixedCase, tracks);
      expect(result.matchedTracks).toEqual(['Cloud Services']);
      expect(result.matchedKeywords).toEqual(['CLOUD HOSTING', 'nadra']);
      expect(result.matchScore).toBe(40);
    });

    it('matches keywords located in referenceNo and organization', () => {
      const itemMinimal: MatchableItem = {
        title: 'Annual General Supplies',
        organization: 'Pakistan Software Export Board',
        referenceNo: 'PSEB-ERP-05'
      };

      const tracks = [
        {
          id: 'track-erp',
          name: 'ERP Track',
          positive_keywords: ['ERP', 'Software Export'],
          negative_keywords: []
        }
      ];

      const result = matchTracks(itemMinimal, tracks);
      expect(result.matchedTracks).toEqual(['ERP Track']);
      expect(result.matchedKeywords).toEqual(['ERP', 'Software Export']);
      expect(result.matchScore).toBe(40);
    });

    it('supports multiple matching tracks and aggregates keywords', () => {
      const baseItem: MatchableItem = {
        title: 'Enterprise Server and Microgrid Project',
        organization: 'NUST',
        description: 'High performance servers and solar inverters for campus.'
      };

      const tracks = [
        {
          id: 't1',
          name: 'Track 1',
          positive_keywords: ['servers'],
          negative_keywords: []
        },
        {
          id: 't2',
          name: 'Track 2',
          positive_keywords: ['solar', 'inverters'],
          negative_keywords: []
        }
      ];

      const result = matchTracks(baseItem, tracks);
      expect(result.matchedTracks).toEqual(['Track 1', 'Track 2']);
      expect(result.matchedKeywords).toEqual(['servers', 'solar', 'inverters']);
      expect(result.matchScore).toBe(60);
    });

    it('clamps minimum matchScore to 30 for single keyword hit', () => {
      const baseItem: MatchableItem = {
        title: 'Supply of Servers',
        organization: 'Org'
      };
      const tracks = [
        {
          id: 't1',
          name: 'Track 1',
          positive_keywords: ['servers'],
          negative_keywords: []
        }
      ];

      const result = matchTracks(baseItem, tracks);
      // 1 keyword * 20 = 20, clamped to min 30
      expect(result.matchScore).toBe(30);
    });

    it('clamps maximum matchScore to 100 for 5+ keyword hits', () => {
      const baseItem: MatchableItem = {
        title: 'Procurement of laptops, servers, software, network, hardware, switches',
        organization: 'PITB'
      };
      const tracks = [
        {
          id: 't1',
          name: 'Track 1',
          positive_keywords: ['laptops', 'servers', 'software', 'network', 'hardware', 'switches'],
          negative_keywords: []
        }
      ];

      const result = matchTracks(baseItem, tracks);
      expect(result.matchScore).toBe(100);
    });

    it('gracefully handles tracks with missing or empty keyword arrays', () => {
      const baseItem: MatchableItem = {
        title: 'General Supplies',
        organization: 'Org'
      };
      const tracks = [{ id: 'empty', name: 'Empty Track' }];

      const result = matchTracks(baseItem, tracks);
      expect(result.matchedTracks).toEqual([]);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.matchScore).toBe(0);
    });

    it('suppresses generic portal organization name to prevent 100% false-positives', () => {
      // If organization matches portal name (e.g. National Disaster Management Authority),
      // organization name itself should not trigger false track matches
      const item: MatchableItem = {
        title: 'Construction of warehouse shelter',
        organization: 'National Disaster Management Authority (NDMA)',
        description: 'Civil construction of earthquake resistant shelter'
      };

      const result = matchTracks(item, mockTracks);
      expect(result.matchedTracks).toHaveLength(0);
    });

    it('returns empty matches when neither positive keywords nor semantic similarity meet thresholds', () => {
      const item: MatchableItem = {
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
