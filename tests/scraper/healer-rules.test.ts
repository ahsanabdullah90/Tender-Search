import { describe, it, expect } from 'vitest';
import {
  shouldTriggerAutoHeal,
  isAllowedPortalDomain,
  isValidHealedTendersUrl,
  hasVerifiedTenderYield,
  sanitizeBaseOrigin
} from '../../src/server/scrapers/healer.js';
import { PORTAL_DEFINITIONS, type PortalDefinition } from '../../src/server/scrapers/portalList.js';
import type { RawScrapedItem } from '../../src/server/scrapers/crawlerEngine.js';

describe('healer-rules (The 7 Self-Healing Anti-Corruption Rules)', () => {
  const punjabPortal: PortalDefinition = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
  const ndmaPortal: PortalDefinition = PORTAL_DEFINITIONS.find(p => p.id === 'ndma')!;

  describe('Rule 1: Strict Trigger Gating (shouldTriggerAutoHeal)', () => {
    it('never triggers Auto-Heal on null, undefined, or successful 0-item scans', () => {
      expect(shouldTriggerAutoHeal(null, false)).toBe(false);
      expect(shouldTriggerAutoHeal(undefined, false)).toBe(false);
      expect(shouldTriggerAutoHeal({ statusCode: 200 }, false)).toBe(false);
    });

    it('never triggers Auto-Heal on network timeouts, TLS resets, or Cloudflare challenges', () => {
      expect(shouldTriggerAutoHeal(new Error('ETIMEDOUT: Connection timed out'), false)).toBe(false);
      expect(shouldTriggerAutoHeal(new Error('ECONNRESET: Connection reset by peer'), false)).toBe(false);
      expect(shouldTriggerAutoHeal({ statusCode: 403, message: 'Cloudflare Turnstile challenge detected' }, false)).toBe(false);
      expect(shouldTriggerAutoHeal({ statusCode: 503, message: 'HTTP 503 Service Unavailable' }, false)).toBe(false);
      expect(shouldTriggerAutoHeal({ statusCode: 502, message: 'HTTP 502 Bad Gateway' }, false)).toBe(false);
    });

    it('triggers Auto-Heal on structural dead-link HTTP errors (404, 410, 500)', () => {
      expect(shouldTriggerAutoHeal({ statusCode: 404 }, false)).toBe(true);
      expect(shouldTriggerAutoHeal({ statusCode: 410 }, false)).toBe(true);
      expect(shouldTriggerAutoHeal(new Error('HTTP 404 Not Found'), false)).toBe(true);
      expect(shouldTriggerAutoHeal(new Error('HTTP 410 Gone'), false)).toBe(true);
      expect(shouldTriggerAutoHeal(new Error('HTTP 500 Internal Server Error'), false)).toBe(true);
    });

    it('always triggers Auto-Heal when manually invoked by the operator regardless of error state', () => {
      expect(shouldTriggerAutoHeal(null, true)).toBe(true);
      expect(shouldTriggerAutoHeal(new Error('Timeout'), true)).toBe(true);
      expect(shouldTriggerAutoHeal({ statusCode: 200 }, true)).toBe(true);
    });
  });

  describe('Rule 3: Registrable Domain Boundary (isAllowedPortalDomain)', () => {
    it('allows candidates sharing the exact portal hostname or subdomains', () => {
      expect(isAllowedPortalDomain('http://eproc.punjab.gov.pk/NewTenders.aspx', punjabPortal)).toBe(true);
      expect(isAllowedPortalDomain('https://punjab.gov.pk/procurement', punjabPortal)).toBe(true);
      expect(isAllowedPortalDomain('https://ndma.gov.pk/procurement/active', ndmaPortal)).toBe(true);
    });

    it('allows redirected official roots (e.g., Balochistan BPPRA redirect)', () => {
      const bppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'bppra')!;
      // Balochistan redirects to bpptwo.vdc.services:5451
      expect(isAllowedPortalDomain('https://bpptwo.vdc.services:5451/Tenders', bppraPortal, 'https://bpptwo.vdc.services:5451')).toBe(true);
    });

    it('strictly rejects third-party external domains and social/ad networks', () => {
      expect(isAllowedPortalDomain('https://www.facebook.com/punjab.ppra', punjabPortal)).toBe(false);
      expect(isAllowedPortalDomain('https://twitter.com/ndmapk', ndmaPortal)).toBe(false);
      expect(isAllowedPortalDomain('https://google.com/search?q=tenders', punjabPortal)).toBe(false);
      expect(isAllowedPortalDomain('https://malicious-procurement-phishing.com/tenders', punjabPortal)).toBe(false);
    });
  });

  describe('Rule 4: Anti-Downgrade & Path Integrity Guard (isValidHealedTendersUrl)', () => {
    it('rejects static file downloads from becoming the portal listing URL', () => {
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/downloads/bidding_doc.pdf', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/files/tender.docx', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/archive.zip', punjabPortal)).toBe(false);
    });

    it('rejects login walls, about pages, and non-procurement sections', () => {
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/login', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/auth/signin', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/about', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/contact/', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/careers/', punjabPortal)).toBe(false);
    });

    it('strictly prevents downgrading a specific listing path to a bare root "/"', () => {
      // punjab_eproc default is http://eproc.punjab.gov.pk/ActiveTenders.aspx
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/index.html', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/default.aspx', punjabPortal)).toBe(false);
    });

    it('accepts valid specific tender listing paths', () => {
      expect(isValidHealedTendersUrl('http://eproc.punjab.gov.pk/LiveTenders.aspx', punjabPortal)).toBe(true);
      expect(isValidHealedTendersUrl('https://ndma.gov.pk/procurement-notices', ndmaPortal)).toBe(true);
    });
  });

  describe('Rule 5: Quality-Verified Yield Proof (hasVerifiedTenderYield)', () => {
    it('returns false for empty lists or null/undefined inputs', () => {
      expect(hasVerifiedTenderYield([])).toBe(false);
      expect(hasVerifiedTenderYield(null as any)).toBe(false);
      expect(hasVerifiedTenderYield(undefined as any)).toBe(false);
    });

    it('returns true when >= 2 items are extracted', () => {
      const items: RawScrapedItem[] = [
        { title: 'Tender 1', organization: 'Org', directUrl: 'https://a.pk/1' },
        { title: 'Tender 2', organization: 'Org', directUrl: 'https://a.pk/2' }
      ];
      expect(hasVerifiedTenderYield(items)).toBe(true);
    });

    it('returns true for 1 item if it has BOTH a date AND a reference or attachment', () => {
      const itemWithDateAndRef: RawScrapedItem = {
        title: 'Tender 1',
        organization: 'Org',
        directUrl: 'https://a.pk/1',
        closingDate: '2026-12-01',
        referenceNo: 'REF-123'
      };
      expect(hasVerifiedTenderYield([itemWithDateAndRef])).toBe(true);

      const itemWithDateAndDoc: RawScrapedItem = {
        title: 'Tender 1',
        organization: 'Org',
        directUrl: 'https://a.pk/1',
        publishDate: '2026-11-01',
        attachmentUrls: ['https://a.pk/doc.pdf']
      };
      expect(hasVerifiedTenderYield([itemWithDateAndDoc])).toBe(true);
    });

    it('returns false for 1 item lacking date or reference/attachment', () => {
      const incompleteItem: RawScrapedItem = {
        title: 'Generic Tender',
        organization: 'Org',
        directUrl: 'https://a.pk/1'
      };
      expect(hasVerifiedTenderYield([incompleteItem])).toBe(false);
    });
  });

  describe('Rule 6: Strict base_url Normalization (sanitizeBaseOrigin)', () => {
    it('extracts clean origin and strips paths, query strings, and hashes', () => {
      expect(sanitizeBaseOrigin('https://ndma.gov.pk/tenders/active?page=1#top')).toBe('https://ndma.gov.pk');
      expect(sanitizeBaseOrigin('http://eproc.punjab.gov.pk:8080/ActiveTenders.aspx')).toBe('http://eproc.punjab.gov.pk:8080');
      expect(sanitizeBaseOrigin('https://techdestination.com/procurement/')).toBe('https://techdestination.com');
    });

    it('returns fallback on invalid URL strings', () => {
      expect(sanitizeBaseOrigin('not-a-valid-url', 'https://fallback.gov.pk')).toBe('https://fallback.gov.pk');
      expect(sanitizeBaseOrigin('', 'https://fallback.gov.pk')).toBe('https://fallback.gov.pk');
    });
  });

  describe('Rule 7: Canonical Baseline Immutability', () => {
    it('PORTAL_DEFINITIONS contains all 18 immutable canonical portals', () => {
      expect(PORTAL_DEFINITIONS).toHaveLength(18);
      const punjab = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
      expect(punjab.tendersUrl).toBe('http://eproc.punjab.gov.pk/ActiveTenders.aspx');
      expect(punjab.baseUrl).toBe('https://ppra.punjab.gov.pk');
    });
  });
});
