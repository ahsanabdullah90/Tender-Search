import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  db,
  initDatabase,
  getPortalHealthList,
  updatePortalHealth,
  getAllTenders,
  getTenderById,
  saveDomainTrack,
  DOSSIERS_DIR
} from '../../src/server/db.js';
import {
  parsePortalHtml,
  extractDatesFromText,
  processAndSaveTender,
  startCrawlerScan,
  seedRealisticTenders,
  getActivePortalsList,
  formatClosingDate,
  parseDateString,
  fetchHtmlWithTolerantAgent,
  crawlerDeps
} from '../../src/server/scrapers/crawlerEngine.js';
import http from 'http';
import * as ocrSvc from '../../src/server/ocrService.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import type { RawScrapedItem } from '../../src/server/scrapers/crawlerEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'portals');

describe('Crawler Engine & Scraper Pipeline', () => {
  const originalFetch = crawlerDeps.fetchHtml;
  const originalSleep = crawlerDeps.sleep;

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();

    crawlerDeps.sleep = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    crawlerDeps.fetchHtml = originalFetch;
    crawlerDeps.sleep = originalSleep;
    vi.restoreAllMocks();
  });

  describe('extractDatesFromText (Bug B7)', () => {
    it('accurately disambiguates labeled publish and closing dates', () => {
      const text = 'Published on: 01-05-2026 | Submission Deadline: 25-05-2026 14:00';
      const dates = extractDatesFromText(text);

      expect(dates.publishDate).toContain('2026-05-01');
      expect(dates.closingDate).toContain('2026-05-25');
    });

    it('prefers closing deadline label over generic dates', () => {
      const text = 'Tender Meeting 10-05-2026, Last Date for Submission: 30-05-2026';
      const dates = extractDatesFromText(text);

      expect(dates.closingDate).toContain('2026-05-30');
    });

    it('sorts multiple unlabeled dates chronologically (earlier is publish, later is closing)', () => {
      const text = 'Notice dates: 12-06-2026 to 28-06-2026 for bidding';
      const dates = extractDatesFromText(text);

      expect(dates.publishDate).toContain('2026-06-12');
      expect(dates.closingDate).toContain('2026-06-28');
    });

    it('handles single date appropriately', () => {
      const closingOnly = extractDatesFromText('Bid submission closing on 15-08-2026');
      expect(closingOnly.closingDate).toContain('2026-08-15');

      const publishOnly = extractDatesFromText('Advertised on 01-08-2026 in daily newspapers');
      expect(publishOnly.publishDate).toContain('2026-08-01');
      expect(publishOnly.closingDate).toBeNull();
    });

    it('returns nulls when no valid dates exist', () => {
      const dates = extractDatesFromText('General notice without any timestamp or day information');
      expect(dates.publishDate).toBeNull();
      expect(dates.closingDate).toBeNull();
    });
  });

  describe('parsePortalHtml with HTML Fixtures', () => {
    it('parses Punjab PPRA fixture table rows accurately', () => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, 'punjab_eproc', 'page.html'), 'utf8');
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;

      const result = parsePortalHtml(html, portal);
      expect(result.hitlRequired).toBe(false);
      expect(result.items.length).toBe(2);

      const item1 = result.items[0];
      expect(item1.referenceNo).toBe('IPL-2026-1042');
      expect(item1.title).toContain('Procurement of Solar Panels');
      expect(item1.closingDate).toContain('2026-05-20');
      expect(item1.attachmentUrls?.length).toBeGreaterThan(0);
    });

    it('parses Sindh SPPRA fixture items accurately', () => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, 'sppra', 'page.html'), 'utf8');
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'sppra')!;

      const result = parsePortalHtml(html, portal);
      expect(result.hitlRequired).toBe(false);
      expect(result.items.length).toBe(1);

      const item = result.items[0];
      expect(item.referenceNo).toBe('SPPRA-EDU-2026-901');
      expect(item.title).toContain('Educational Textbooks');
      expect(item.closingDate).toContain('2026-06-18');
      expect(item.publishDate).toContain('2026-06-02');
    });

    it('parses Federal EPADS fixture items accurately', () => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, 'epads', 'page.html'), 'utf8');
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'epads')!;

      const result = parsePortalHtml(html, portal);
      expect(result.hitlRequired).toBe(false);
      expect(result.items.length).toBe(1);

      const item = result.items[0];
      expect(item.referenceNo).toBe('TS-554219');
      expect(item.title).toContain('Office Stationery');
      expect(item.closingDate).toContain('2026-05-28');
    });

    it('detects Cloudflare Turnstile challenge and flags hitlRequired (Bug B4)', () => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, 'cloudflare_challenge', 'page.html'), 'utf8');
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'epads')!;

      const result = parsePortalHtml(html, portal);
      expect(result.hitlRequired).toBe(true);
      expect(result.items.length).toBe(0);
    });

    it('detects login requirement and flags isLoginRequired (Bug B5)', () => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, 'login_required', 'page.html'), 'utf8');
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'tender_services')!;

      const result = parsePortalHtml(html, portal);
      expect(result.hitlRequired).toBe(true);
      expect(result.isLoginRequired).toBe(true);
      expect(result.items.length).toBe(0);
    });
  });

  describe('processAndSaveTender', () => {
    const samplePortal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
    const activeTracks = [
      {
        id: 'track-solar',
        name: 'Solar & Clean Energy',
        positive_keywords: ['solar', 'inverter'],
        negative_keywords: [],
        is_active: 1
      }
    ];

    it('saves a matching new active tender opportunity', async () => {
      const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      const item: RawScrapedItem = {
        title: 'Installation of Solar Inverters in Hospitals',
        organization: 'Health Department Punjab',
        referenceNo: 'HEALTH-SOLAR-01',
        directUrl: 'https://example.com/solar1',
        closingDate: futureDate
      };

      const result = await processAndSaveTender(item, samplePortal, activeTracks);
      expect(result.matched).toBe(true);
      expect(result.isNew).toBe(true);

      const saved = getAllTenders();
      expect(saved.length).toBe(1);
      expect(saved[0].reference_no).toBe('HEALTH-SOLAR-01');
      expect(saved[0].pipeline_status).toBe('New Opportunity');
    });

    it('skips saving when no track keywords match', async () => {
      const item: RawScrapedItem = {
        title: 'Procurement of Police Uniforms and Boots',
        organization: 'Police Department',
        referenceNo: 'POL-UNI-99',
        directUrl: 'https://example.com/boots'
      };

      const result = await processAndSaveTender(item, samplePortal, activeTracks);
      expect(result.matched).toBe(false);
      expect(result.isNew).toBe(false);
      expect(getAllTenders().length).toBe(0);
    });

    it('skips saving new tender if closing date is already in the past (Bug B6)', async () => {
      const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const item: RawScrapedItem = {
        title: 'Old Solar Panels Installation Notice',
        organization: 'Energy Dept',
        referenceNo: 'OLD-SOLAR-199',
        directUrl: 'https://example.com/old-solar',
        closingDate: pastDate
      };

      const result = await processAndSaveTender(item, samplePortal, activeTracks);
      expect(result.matched).toBe(true);
      expect(result.isNew).toBe(false);
      expect(getAllTenders().length).toBe(0);
    });

    it('detects closing date extension as a corrigendum on existing tender', async () => {
      const initialDate = '2026-12-01T14:00:00+05:00';
      const extendedDate = '2026-12-15T14:00:00+05:00';

      const initialItem: RawScrapedItem = {
        title: 'Solar Grid Tie System',
        organization: 'WAPDA',
        referenceNo: 'WAPDA-SOLAR-77',
        directUrl: 'https://example.com/grid1',
        closingDate: initialDate
      };

      const res1 = await processAndSaveTender(initialItem, samplePortal, activeTracks);
      expect(res1.isNew).toBe(true);

      const extendedItem: RawScrapedItem = {
        title: 'Solar Grid Tie System',
        organization: 'WAPDA',
        referenceNo: 'WAPDA-SOLAR-77',
        directUrl: 'https://example.com/grid1',
        closingDate: extendedDate
      };

      const res2 = await processAndSaveTender(extendedItem, samplePortal, activeTracks);
      expect(res2.isNew).toBe(false);
      expect(res2.hasCorrigendum).toBe(true);

      const updated = getAllTenders()[0];
      expect(updated.closing_date).toBe(extendedDate);
      expect(updated.has_corrigendum).toBe(1);
    });
  });

  describe('startCrawlerScan Orchestration (B2, B5)', () => {
    it('executes scan, saves items, and resets consecutive zero yields on online portal', async () => {
      const punjabHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'punjab_eproc', 'page.html'), 'utf8');
      crawlerDeps.fetchHtml = vi.fn().mockResolvedValue(punjabHtml);

      // Pre-set consecutive zero yields to test reset
      updatePortalHealth('punjab_eproc', {
        status: 'error',
        consecutive_zero_yields: 2,
        last_error_message: 'Previous timeout'
      });

      const scanResult = await startCrawlerScan('punjab_eproc', true);
      expect(scanResult.isScanning).toBe(false);

      const portal = getPortalHealthList().find(p => p.portal_id === 'punjab_eproc');
      expect(portal?.status).toBe('online');
      expect(portal?.consecutive_zero_yields).toBe(0);
      expect(portal?.last_error_message).toBeNull();
    });

    it('increments consecutive zeros and sets error message on empty results (Bug B5)', async () => {
      const emptyHtml = '<html><body><div>No active records available today.</div></body></html>';
      crawlerDeps.fetchHtml = vi.fn().mockResolvedValue(emptyHtml);

      updatePortalHealth('punjab_eproc', { consecutive_zero_yields: 0 });

      await startCrawlerScan('punjab_eproc', true);

      let portal = getPortalHealthList().find(p => p.portal_id === 'punjab_eproc');
      expect(portal?.consecutive_zero_yields).toBe(1);
      expect(portal?.last_error_message).toBe('No listings found on the last scan');
      expect(portal?.status).toBe('online');

      // Second zero yield
      await startCrawlerScan('punjab_eproc', true);
      portal = getPortalHealthList().find(p => p.portal_id === 'punjab_eproc');
      expect(portal?.consecutive_zero_yields).toBe(2);

      // Third zero yield triggers 'selector_broken'
      await startCrawlerScan('punjab_eproc', true);
      portal = getPortalHealthList().find(p => p.portal_id === 'punjab_eproc');
      expect(portal?.consecutive_zero_yields).toBe(3);
      expect(portal?.status).toBe('selector_broken');
    });

    it('handles scrape network error and updates portal health to error', async () => {
      crawlerDeps.fetchHtml = vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection dropped by gateway'));

      await startCrawlerScan('punjab_eproc', true);

      const portal = getPortalHealthList().find(p => p.portal_id === 'punjab_eproc');
      expect(portal?.status).toBe('error');
      expect(portal?.last_error_message).toContain('ETIMEDOUT');
    });

    it('downloads attachments in background when attachmentUrls are provided', async () => {
      const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      const itemWithAttachment: RawScrapedItem = {
        title: 'Procurement of Solar PV Modules',
        organization: 'Punjab Energy Department',
        directUrl: 'http://example.com/solar-pv',
        closingDate: futureDate,
        description: 'Solar power system installation',
        attachmentUrls: ['http://127.0.0.1:1/file.pdf']
      };

      const tracks = [{
        id: 'track-solar',
        name: 'Solar & Clean Energy',
        positive_keywords: ['solar', 'photovoltaic'],
        negative_keywords: [],
        is_active: 1
      }];

      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
      const res = await processAndSaveTender(itemWithAttachment, portalDef, tracks);
      expect(res.isNew).toBe(true);
      expect(res.matched).toBe(true);
    });

    it('seeds realistic sample tenders on clean database and skips if already present', () => {
      expect((db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c).toBe(0);
      seedRealisticTenders();
      const countAfter = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
      expect(countAfter).toBeGreaterThan(5);

      // Subsequent call does nothing
      seedRealisticTenders();
      expect((db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c).toBe(countAfter);
    });

    it('maps all db portal fields in getActivePortalsList', () => {
      updatePortalHealth('epads', {
        portal_name: 'Federal EPADS Custom',
        category: 'Federal/Regional',
        tier: 'http',
        base_url: 'https://custom-epads.gov.pk',
        tenders_url: 'https://custom-epads.gov.pk/tenders',
        login_url: 'https://custom-epads.gov.pk/login',
        access_mode: 'login_required',
        verified_status: 'online',
        session_cookies: 'test=1'
      });

      const portals = getActivePortalsList('epads');
      expect(portals.length).toBe(1);
      const epads = portals[0];
      expect(epads.name).toBe('Federal EPADS Custom');
      expect(epads.baseUrl).toBe('https://custom-epads.gov.pk');
      expect(epads.loginUrl).toBe('https://custom-epads.gov.pk/login');
      expect(epads.accessMode).toBe('login_required');
      expect((epads as any).sessionCookies).toBe('test=1');
    });

    it('handles timeout in fetchHtmlWithTolerantAgent', async () => {
      const origGet = http.get;
      const spy = vi.spyOn(http, 'get').mockImplementationOnce((url: any, opts: any, cb: any) => {
        const req = origGet(url, opts, cb);
        setImmediate(() => req.emit('timeout'));
        return req;
      });

      let serverPort = 0;
      const srv = http.createServer((req, res) => {});
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => {
        serverPort = (srv.address() as any).port;
        resolve();
      }));

      await expect(fetchHtmlWithTolerantAgent(`http://127.0.0.1:${serverPort}`)).rejects.toThrow('Connection timed out');

      spy.mockRestore();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    it('returns null for impossible dates in parseDateString', () => {
      expect(parseDateString('31-Feb-2026')).toBeNull();
      expect(parseDateString('2026-02-31')).toBeNull();
      expect(parseDateString('2026-05-15 25:00:00')).toBeNull();
    });

    it('downloads image attachment in background and performs OCR extraction', async () => {
      let serverPort = 0;
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from('fake image content'));
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => {
        serverPort = (srv.address() as any).port;
        resolve();
      }));

      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'OCR-REF-999',
        organization: 'Punjab Energy Department',
        title: 'Procurement of Solar PV Modules',
        closingDateISO: '2026-12-25T14:00:00+05:00',
        closingDateFormatted: '25 Dec 2026, 02:00 PM PKT',
        estimatedValue: null,
        summaryScope: 'Solar scope',
        isCorrigendum: false
      });

      const itemWithoutDateOrRef: RawScrapedItem = {
        title: 'Procurement of Solar PV Modules',
        organization: 'Punjab Energy Department',
        directUrl: 'http://example.com/solar-ocr',
        attachmentUrls: [`http://127.0.0.1:${serverPort}/scan.jpg`]
      };

      const tracks = [{
        id: 'track-solar',
        name: 'Solar & Clean Energy',
        positive_keywords: ['solar'],
        negative_keywords: [],
        is_active: 1
      }];

      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
      const res = await processAndSaveTender(itemWithoutDateOrRef, portalDef, tracks);
      expect(res.isNew).toBe(true);

      // Wait for background download + OCR promise
      await new Promise(r => setTimeout(r, 200));

      const updated = getAllTenders().find(t => t.title === 'Procurement of Solar PV Modules');
      expect(updated?.reference_no).toBe('OCR-REF-999');
      expect(updated?.closing_date).toBe('2026-12-25T14:00:00+05:00');

      spyOcr.mockRestore();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    it('handles OCR extraction errors gracefully in background', async () => {
      let serverPort = 0;
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from('fake image content'));
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => {
        serverPort = (srv.address() as any).port;
        resolve();
      }));

      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockRejectedValueOnce(new Error('OCR Timeout'));

      const item: RawScrapedItem = {
        title: 'Solar Panels In Hospital',
        organization: 'Health Department',
        directUrl: 'http://example.com/solar-err',
        attachmentUrls: [`http://127.0.0.1:${serverPort}/scan.jpg`]
      };

      const tracks = [{
        id: 'track-solar',
        name: 'Solar',
        positive_keywords: ['solar'],
        negative_keywords: [],
        is_active: 1
      }];

      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;
      await processAndSaveTender(item, portalDef, tracks);
      await new Promise(r => setTimeout(r, 200));

      spyOcr.mockRestore();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });
  });

  describe('fetchHtmlWithTolerantAgent & Edge Cases', () => {
    it('fetches HTML with custom cookies and follows redirects', async () => {
      let receivedCookie = '';
      const srv = http.createServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/target' });
          res.end();
        } else if (req.url === '/target') {
          receivedCookie = req.headers.cookie || '';
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Target Page</body></html>');
        } else if (req.url === '/cf-challenge') {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          res.end('<html><head><title>Just a moment... cloudflare challenge</title></head></html>');
        } else if (req.url === '/error500') {
          res.writeHead(500);
          res.end('Internal Server Error');
        } else if (req.url === '/infinite-loop') {
          res.writeHead(302, { Location: '/infinite-loop' });
          res.end();
        }
      });

      let port = 0;
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => {
        port = (srv.address() as any).port;
        resolve();
      }));

      try {
        // 1. Redirect and cookie header check
        const html = await fetchHtmlWithTolerantAgent(`http://127.0.0.1:${port}/redirect`, 0, 'session=test_val');
        expect(html).toContain('Target Page');
        expect(receivedCookie).toBe('session=test_val');

        // 2. Cloudflare challenge on 403 status returns body
        const cfHtml = await fetchHtmlWithTolerantAgent(`http://127.0.0.1:${port}/cf-challenge`);
        expect(cfHtml).toContain('cloudflare challenge');

        // 3. HTTP 500 error rejects
        await expect(fetchHtmlWithTolerantAgent(`http://127.0.0.1:${port}/error500`)).rejects.toThrow('HTTP 500 from portal server');

        // 4. Too many redirects rejects
        await expect(fetchHtmlWithTolerantAgent(`http://127.0.0.1:${port}/infinite-loop`)).rejects.toThrow('Too many redirects');

        // 5. Invalid URL rejects
        await expect(fetchHtmlWithTolerantAgent('not-a-valid-url')).rejects.toThrow('Invalid URL');
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    it('handles formatClosingDate error fallback to Not Available', () => {
      const corruptDateObj = {
        getTime: () => 1234567,
        toLocaleDateString: () => { throw new Error('Localization crash'); }
      };
      // Force exception in formatClosingDate
      const origDate = global.Date;
      try {
        (global as any).Date = class extends origDate {
          constructor(...args: any[]) {
            if (args.length > 0 && args[0] === 'force-error') {
              return corruptDateObj as any;
            }
            super(...(args as [any]));
          }
        };
        expect(formatClosingDate('force-error')).toBe('Not Available');
      } finally {
        global.Date = origDate;
      }
    });
  });
});
