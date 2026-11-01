import { describe, it, expect } from 'vitest';
import { matchTracks } from '../../src/server/scrapers/crawlerEngine.js';
import type { RawScrapedItem } from '../../src/server/scrapers/crawlerEngine.js';

describe('matchTracks', () => {
  const baseItem: RawScrapedItem = {
    title: 'Supply of High-End Laptops and Servers',
    organization: 'National University of Sciences & Technology',
    referenceNo: 'NUST-IT-2026-001',
    description: 'Procurement of enterprise grade compute infrastructure and networking switches.',
    directUrl: 'https://example.com/tender/1',
    closingDate: '2026-05-15T14:00:00+05:00'
  };

  it('matches positive keywords and calculates correct score', () => {
    const tracks = [
      {
        id: 'track-it',
        name: 'IT & Hardware',
        positive_keywords: ['laptops', 'servers'],
        negative_keywords: ['civil works', 'construction'],
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);

    expect(result.matchedTracks).toEqual(['IT & Hardware']);
    expect(result.matchedKeywords).toEqual(['laptops', 'servers']);
    // 2 keywords * 20 = 40 (between 30 and 100)
    expect(result.matchScore).toBe(40);
  });

  it('excludes track when negative keyword matches even if positive keywords match', () => {
    const tracks = [
      {
        id: 'track-it',
        name: 'IT & Hardware',
        positive_keywords: ['laptops', 'compute'],
        negative_keywords: ['networking'], // Present in description
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);

    expect(result.matchedTracks).toEqual([]);
    expect(result.matchedKeywords).toEqual([]);
    expect(result.matchScore).toBe(0);
  });

  it('is case-insensitive for text, organization, referenceNo, and keywords', () => {
    const itemWithMixedCase: RawScrapedItem = {
      title: 'rFp fOr cLoUd HoStInG',
      organization: 'NADRA Tech',
      referenceNo: 'NADRA-CLOUD-99',
      directUrl: 'https://example.com/tender/2',
      closingDate: null
    };

    const tracks = [
      {
        id: 'track-cloud',
        name: 'Cloud Services',
        positive_keywords: ['CLOUD HOSTING', 'nadra'],
        negative_keywords: ['HARDWARE'],
        is_active: 1
      }
    ];

    const result = matchTracks(itemWithMixedCase, tracks);

    expect(result.matchedTracks).toEqual(['Cloud Services']);
    expect(result.matchedKeywords).toEqual(['CLOUD HOSTING', 'nadra']);
    expect(result.matchScore).toBe(40);
  });

  it('matches keywords located in referenceNo and organization', () => {
    const itemMinimal: RawScrapedItem = {
      title: 'Annual General Supplies',
      organization: 'Pakistan Software Export Board',
      referenceNo: 'PSEB-ERP-05',
      directUrl: 'https://example.com/tender/3',
      closingDate: null
    };

    const tracks = [
      {
        id: 'track-erp',
        name: 'ERP Track',
        positive_keywords: ['ERP', 'Software Export'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(itemMinimal, tracks);

    expect(result.matchedTracks).toEqual(['ERP Track']);
    expect(result.matchedKeywords).toEqual(['ERP', 'Software Export']);
    expect(result.matchScore).toBe(40);
  });

  it('supports multiple matching tracks and aggregates keywords', () => {
    const tracks = [
      {
        id: 'track-1',
        name: 'Track 1',
        positive_keywords: ['servers'],
        negative_keywords: [],
        is_active: 1
      },
      {
        id: 'track-2',
        name: 'Track 2',
        positive_keywords: ['switches', 'compute'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);

    expect(result.matchedTracks).toEqual(['Track 1', 'Track 2']);
    expect(result.matchedKeywords).toEqual(['servers', 'switches', 'compute']);
    // 3 keywords * 20 = 60
    expect(result.matchScore).toBe(60);
  });

  it('clamps minimum matchScore to 30 for single keyword hit', () => {
    const tracks = [
      {
        id: 'track-1',
        name: 'Single Hit',
        positive_keywords: ['servers'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);
    // 1 keyword * 20 = 20, clamped to min 30
    expect(result.matchScore).toBe(30);
  });

  it('clamps maximum matchScore to 100 for 5+ keyword hits', () => {
    const tracks = [
      {
        id: 'track-1',
        name: 'Many Hits',
        positive_keywords: ['laptops', 'servers', 'compute', 'infrastructure', 'networking', 'switches'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);
    // 6 keywords * 20 = 120, clamped to max 100
    expect(result.matchedKeywords.length).toBe(6);
    expect(result.matchScore).toBe(100);
  });

  it('returns empty results and 0 score when no tracks match', () => {
    const tracks = [
      {
        id: 'track-pharma',
        name: 'Pharmaceuticals',
        positive_keywords: ['medicines', 'syringes'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(baseItem, tracks);

    expect(result.matchedTracks).toEqual([]);
    expect(result.matchedKeywords).toEqual([]);
    expect(result.matchScore).toBe(0);
  });

  it('gracefully handles tracks with missing or empty keyword arrays', () => {
    const tracks = [
      {
        id: 'track-empty',
        name: 'Empty Track'
      }
    ];

    const result = matchTracks(baseItem, tracks);

    expect(result.matchedTracks).toEqual([]);
    expect(result.matchedKeywords).toEqual([]);
    expect(result.matchScore).toBe(0);
  });

  it('does not false-positive match on default portal names like Ministry of Federal Education', () => {
    const unrelatedItem: RawScrapedItem = {
      title: 'Hiring of Janitorial and Security Guard Services',
      organization: 'Ministry of Federal Education & Professional Training',
      directUrl: 'https://mofept.gov.pk/Tenders',
      closingDate: null
    };

    const tracks = [
      {
        id: 'track-edu',
        name: 'Education & Learning',
        positive_keywords: ['education', 'training'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    const result = matchTracks(unrelatedItem, tracks);
    expect(result.matchedTracks).toEqual([]);
    expect(result.matchScore).toBe(0);
  });
});
