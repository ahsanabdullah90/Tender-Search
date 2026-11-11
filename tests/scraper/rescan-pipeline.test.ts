import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  getTenderById,
  upsertScrapedTender,
  updateTenderStatus,
  updateTenderNotes
} from '../../src/server/db.js';
import type { UpsertScrapedTenderInput } from '../../src/server/db/repositories/tendersRepo.js';
import {
  computeTenderId,
  referencesOnlyPriorYears,
  isDirectDocumentUrl,
  orderDocumentCandidates,
  applyRescannedDeadline,
  applyRescanToExistingTender,
  holdForDocumentScope
} from '../../src/server/scrapers/ingestPipeline.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import type { Tender } from '../../src/types.js';

function makeTestTender(overrides: Partial<UpsertScrapedTenderInput> & { id: string; title: string }): UpsertScrapedTenderInput {
  return {
    id: overrides.id,
    canonical_id: overrides.canonical_id || overrides.id,
    reference_no: overrides.reference_no || null,
    title: overrides.title,
    organization: overrides.organization || 'Test Org',
    portal_id: overrides.portal_id || 'punjab_eproc',
    portal_name: overrides.portal_name || 'Punjab PPRA',
    direct_url: overrides.direct_url || 'https://example.gov.pk/t1',
    domain_tracks: overrides.domain_tracks || ['IT & Software'],
    matched_keywords: overrides.matched_keywords || [],
    match_score: overrides.match_score ?? 90,
    semantic_score: 0,
    embedding: null,
    publish_date: null,
    publish_date_source: null,
    closing_date: overrides.closing_date || null,
    closing_date_formatted: overrides.closing_date_formatted || '20 Nov 2026',
    estimated_value: null,
    location: 'Pakistan',
    description: '',
    cached_dossiers: [],
    attachment_urls: overrides.attachment_urls || [],
    has_corrigendum: overrides.has_corrigendum ?? 0,
    ingestion_status: overrides.ingestion_status || 'ready',
    deadline_source: overrides.deadline_source || 'html_row',
    deadline_confidence: null,
    doc_fetch_status: 'none',
    needs_review: overrides.needs_review ?? 0,
    review_reason: overrides.review_reason || null
  };
}

describe('rescan-pipeline (Re-scan Lifecycle, Deadline Enforcement & Scope Holds)', () => {
  beforeEach(() => {
    initDatabase();
  });

  describe('computeTenderId (ID-1)', () => {
    it('generates deterministic SHA256 prefix for identical tender items', () => {
      const itemA = {
        referenceNo: 'TSE-2425026',
        title: 'Procurement of Solar Inverters',
        directUrl: 'https://eproc.punjab.gov.pk/tender/123'
      };
      const itemB = {
        referenceNo: 'TSE-2425026',
        title: 'Procurement of Solar Inverters',
        directUrl: 'https://eproc.punjab.gov.pk/tender/123'
      };

      const idA = computeTenderId('punjab_eproc', itemA);
      const idB = computeTenderId('punjab_eproc', itemB);

      expect(idA).toBe(idB);
      expect(idA).toMatch(/^tender-punjab_eproc-[0-9a-f]{16}$/);
    });

    it('normalizes title whitespace and casing so slight variations produce the same ID', () => {
      const itemA = {
        referenceNo: 'PROC-991',
        title: 'Supply of Laptops',
        directUrl: 'https://bppra.gob.pk/tenders/991'
      };
      const itemB = {
        referenceNo: 'PROC-991',
        title: '  Supply   of   Laptops  ',
        directUrl: 'https://bppra.gob.pk/tenders/991'
      };

      expect(computeTenderId('bppra', itemA)).toBe(computeTenderId('bppra', itemB));
    });

    it('produces distinct IDs for different portals or reference numbers', () => {
      const item1 = { referenceNo: 'REF-01', title: 'Solar PV', directUrl: 'https://a.gov.pk/1' };
      const item2 = { referenceNo: 'REF-02', title: 'Solar PV', directUrl: 'https://a.gov.pk/1' };

      expect(computeTenderId('punjab_eproc', item1)).not.toBe(computeTenderId('punjab_eproc', item2));
      expect(computeTenderId('punjab_eproc', item1)).not.toBe(computeTenderId('sppra', item1));
    });
  });

  describe('referencesOnlyPriorYears', () => {
    it('returns true when text explicitly mentions only years prior to current year', () => {
      const fixedNow = new Date('2026-11-11T12:00:00Z');
      expect(referencesOnlyPriorYears('Annual Tender Notice for FY 2023-2024', fixedNow)).toBe(true);
      expect(referencesOnlyPriorYears('Procurement of IT Equipment (2022-2023)', fixedNow)).toBe(true);
    });

    it('returns false when text mentions current year or upcoming years', () => {
      const fixedNow = new Date('2026-11-11T12:00:00Z');
      expect(referencesOnlyPriorYears('Procurement of Laptops for FY 2026-2027', fixedNow)).toBe(false);
      expect(referencesOnlyPriorYears('Supply of Furniture 2026', fixedNow)).toBe(false);
      expect(referencesOnlyPriorYears('Framework Agreement 2027-2028', fixedNow)).toBe(false);
    });

    it('returns false when no years are mentioned in text', () => {
      const fixedNow = new Date('2026-11-11T12:00:00Z');
      expect(referencesOnlyPriorYears('Supply of Office Stationery and Consumables', fixedNow)).toBe(false);
    });
  });

  describe('isDirectDocumentUrl & orderDocumentCandidates', () => {
    it('correctly identifies direct PDF, DOCX, and wpdmdl URLs', () => {
      expect(isDirectDocumentUrl('https://example.gov.pk/rfp.pdf')).toBe(true);
      expect(isDirectDocumentUrl('https://example.gov.pk/notice.docx?v=1')).toBe(true);
      expect(isDirectDocumentUrl('https://fde.gov.pk/?wpdmdl=8821')).toBe(true);
      expect(isDirectDocumentUrl('https://example.gov.pk/tender/detail/123')).toBe(false);
      expect(isDirectDocumentUrl(null)).toBe(false);
    });

    it('prioritizes direct RFP and corrigendum links, caps candidates at 5', () => {
      const item = {
        directUrl: 'https://example.gov.pk/tender/view/100',
        attachmentUrls: [
          'https://example.gov.pk/specs.pdf',
          'https://example.gov.pk/corrigendum-extension.pdf',
          'https://example.gov.pk/boq.xlsx',
          'https://example.gov.pk/nit-notice.pdf',
          'https://example.gov.pk/drawing.pdf',
          'https://example.gov.pk/terms.pdf'
        ]
      };

      const ordered = orderDocumentCandidates(item);
      expect(ordered.length).toBeLessThanOrEqual(5);
      // Corrigendum must be prioritized first
      expect(ordered[0]).toContain('corrigendum-extension.pdf');
    });
  });

  describe('applyRescannedDeadline (DL-3)', () => {
    it('updates deadline and logs corrigendum on extended deadline (later calendar day)', () => {
      const tenderId = 'tender-test-rescan-ext-1';
      upsertScrapedTender(makeTestTender({
        id: tenderId,
        canonical_id: tenderId,
        title: 'Solar Inverters Supply',
        organization: 'Energy Dept',
        portal_id: 'punjab_eproc',
        portal_name: 'Punjab PPRA',
        direct_url: 'https://eproc.punjab.gov.pk/t1',
        domain_tracks: ['Solar & Clean Energy'],
        matched_keywords: ['solar'],
        match_score: 90,
        closing_date: '2026-11-20T09:00:00.000Z',
        closing_date_formatted: '20 Nov 2026, 02:00 PM',
        deadline_source: 'html_row'
      }));

      const existing = getTenderById(tenderId)!;
      // Re-scan finds an extended closing date: 2026-11-28
      const hasCorrigendum = applyRescannedDeadline(existing, '2026-11-28T14:00:00+05:00');

      expect(hasCorrigendum).toBe(true);
      const updated = getTenderById(tenderId)!;
      expect(updated.closing_date).toContain('2026-11-28');
      expect(updated.has_corrigendum).toBe(1);
    });

    it('preserves existing deadline and flags for review on earlier calendar day (DL-3, A4)', () => {
      const tenderId = 'tender-test-rescan-earlier-1';
      upsertScrapedTender(makeTestTender({
        id: tenderId,
        canonical_id: tenderId,
        title: 'Server Hardware Supply',
        organization: 'PITB',
        portal_id: 'punjab_eproc',
        portal_name: 'Punjab PPRA',
        direct_url: 'https://eproc.punjab.gov.pk/t2',
        domain_tracks: ['IT & Software'],
        matched_keywords: ['server'],
        match_score: 90,
        closing_date: '2026-11-30T09:00:00.000Z',
        closing_date_formatted: '30 Nov 2026, 02:00 PM',
        deadline_source: 'html_row'
      }));

      const existing = getTenderById(tenderId)!;
      // Re-scan finds an earlier date: 2026-11-20
      const hasCorrigendum = applyRescannedDeadline(existing, '2026-11-20T14:00:00+05:00');

      expect(hasCorrigendum).toBe(false);
      const updated = getTenderById(tenderId)!;
      // The original later deadline is retained
      expect(updated.closing_date).toContain('2026-11-30');
      // Tender is flagged for human review
      expect(updated.needs_review).toBe(1);
      expect(updated.review_reason).toContain('deadline_moved_earlier');
    });

    it('does nothing on same calendar day re-scans with default hours', () => {
      const tenderId = 'tender-test-rescan-same-1';
      upsertScrapedTender(makeTestTender({
        id: tenderId,
        canonical_id: tenderId,
        title: 'Network Switches',
        organization: 'PITB',
        portal_id: 'punjab_eproc',
        portal_name: 'Punjab PPRA',
        direct_url: 'https://eproc.punjab.gov.pk/t3',
        domain_tracks: ['IT & Software'],
        matched_keywords: ['network'],
        match_score: 90,
        closing_date: '2026-11-25T09:00:00.000Z',
        closing_date_formatted: '25 Nov 2026, 02:00 PM',
        deadline_source: 'html_row',
        needs_review: 0,
        has_corrigendum: 0
      }));

      const existing = getTenderById(tenderId)!;
      const hasCorrigendum = applyRescannedDeadline(existing, '2026-11-25T14:00:00+05:00');

      expect(hasCorrigendum).toBe(false);
      const updated = getTenderById(tenderId)!;
      expect(Boolean(updated.needs_review)).toBe(false);
      expect(Boolean(updated.has_corrigendum)).toBe(false);
    });
  });

  describe('applyRescanToExistingTender (DL-4)', () => {
    const portal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;

    it('preserves pipeline status and notes across re-scans unconditionally', () => {
      const tenderId = 'tender-test-pipeline-preservation';
      upsertScrapedTender(makeTestTender({
        id: tenderId,
        canonical_id: tenderId,
        title: 'Solar Panels Package 1',
        organization: 'Energy Dept',
        portal_id: 'punjab_eproc',
        portal_name: 'Punjab PPRA',
        direct_url: 'https://eproc.punjab.gov.pk/solar1',
        domain_tracks: ['Solar & Clean Energy'],
        matched_keywords: ['solar'],
        match_score: 90,
        closing_date: '2026-12-01T09:00:00.000Z'
      }));

      // Advance tender to Preparing Bid in pipeline and write notes
      updateTenderStatus(tenderId, 'Preparing Bid');
      updateTenderNotes(tenderId, 'JV agreement prepared with ABC Solar Ltd.');

      const existing = getTenderById(tenderId)!;
      expect(existing.pipeline_status).toBe('Preparing Bid');
      expect(existing.status_notes).toBe('JV agreement prepared with ABC Solar Ltd.');

      // Re-scan visits the portal again
      const rawItem = {
        title: 'Solar Panels Package 1',
        organization: 'Energy Dept',
        directUrl: 'https://eproc.punjab.gov.pk/solar1',
        closingDate: '2026-12-01T09:00:00.000Z',
        attachmentUrls: ['https://eproc.punjab.gov.pk/doc1.pdf']
      };

      const result = applyRescanToExistingTender(existing, rawItem as any, portal, rawItem.attachmentUrls, {
        trustListingDeadline: true
      });

      expect(result.isNew).toBe(false);
      const afterRescan = getTenderById(tenderId)!;
      // Invariants strictly held:
      expect(afterRescan.pipeline_status).toBe('Preparing Bid');
      expect(afterRescan.status_notes).toBe('JV agreement prepared with ABC Solar Ltd.');
      expect(afterRescan.attachment_urls).toContain('https://eproc.punjab.gov.pk/doc1.pdf');
    });
  });

  describe('holdForDocumentScope (MATCH-2)', () => {
    const portal = PORTAL_DEFINITIONS.find(p => p.id === 'fde')!;

    it('inserts generic listing with candidate documents as awaiting_scope', () => {
      const tenderId = 'tender-fde-scope-hold-1';
      const item = {
        title: 'Tender Notice',
        organization: 'Federal Directorate of Education',
        directUrl: 'https://fde.gov.pk/download-category/tender/',
        closingDate: '2026-12-15T09:00:00.000Z',
        attachmentUrls: ['https://fde.gov.pk/?wpdmdl=9901']
      };

      const result = holdForDocumentScope(tenderId, item as any, portal, item.attachmentUrls);

      expect(result.awaitingScope).toBe(true);
      expect(result.matched).toBe(false);

      const saved = getTenderById(tenderId)!;
      expect(saved.ingestion_status).toBe('awaiting_scope');
      expect(saved.attachment_urls).toContain('https://fde.gov.pk/?wpdmdl=9901');
    });

    it('skips holding expired or past tenders', () => {
      const tenderId = 'tender-fde-scope-expired';
      const item = {
        title: 'Tender Notice Old',
        organization: 'FDE',
        directUrl: 'https://fde.gov.pk/old',
        closingDate: '2024-01-01T09:00:00.000Z', // In the past
        attachmentUrls: ['https://fde.gov.pk/old.pdf']
      };

      const result = holdForDocumentScope(tenderId, item as any, portal, item.attachmentUrls);
      expect(result.awaitingScope).toBeFalsy();
      expect(result.matched).toBe(false);
    });
  });
});
