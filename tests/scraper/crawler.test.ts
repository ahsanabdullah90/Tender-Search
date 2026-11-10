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
  compactHtmlForAiExtraction,
  isGenericListingUrl,
  analyzeTenderById,
  fetchDocumentsForTender,
  scoreCandidateTenderLinks,
  healPortalConnection,
  sanitizeBaseOrigin,
  shouldTriggerAutoHeal,
  isAllowedPortalDomain,
  isValidHealedTendersUrl,
  hasVerifiedTenderYield,
  isNonBidEvaluationOrPlanTitle,
  crawlerDeps,
  currentScanStatus
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
  const originalDownload = crawlerDeps.downloadAndCacheDossier;
  const originalFetchBuffer = crawlerDeps.fetchFileBuffer;

  beforeEach(() => {
    initDatabase();
    currentScanStatus.isScanning = false;
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
    db.prepare('DELETE FROM deleted_tenders').run();

    crawlerDeps.sleep = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    crawlerDeps.fetchHtml = originalFetch;
    crawlerDeps.sleep = originalSleep;
    crawlerDeps.downloadAndCacheDossier = originalDownload;
    crawlerDeps.fetchFileBuffer = originalFetchBuffer;
    currentScanStatus.isScanning = false;
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

    it('parses NDMA .tender-card, FDE h3.package-title, PSDF .inner-advertisement-listing-box, and PSEB PDF links', () => {
      // 1. NDMA .tender-card
      const ndmaPortal = PORTAL_DEFINITIONS.find(p => p.id === 'ndma')!;
      const ndmaHtml = `
        <div class="tender-card">
          <div class="tender-card__title">
            <a href="/storage/tenders/Solar_System_RFP.pdf">Provision and Installation of Solar System</a>
          </div>
          <div class="tender-card__meta" data-label="Opening Date">15 Oct, 2026</div>
          <div class="tender-card__meta" data-label="Submission Date">30 Oct, 2026</div>
        </div>
      `;
      const ndmaRes = parsePortalHtml(ndmaHtml, ndmaPortal);
      expect(ndmaRes.items.length).toBe(1);
      expect(ndmaRes.items[0].title).toBe('Provision and Installation of Solar System');
      expect(ndmaRes.items[0].closingDate).toContain('2026-10-30');
      expect(ndmaRes.items[0].publishDate).toContain('2026-10-15');
      expect(ndmaRes.items[0].attachmentUrls).toContain('https://ndma.gov.pk/storage/tenders/Solar_System_RFP.pdf');

      // 2. FDE h3.package-title
      const fdePortal = PORTAL_DEFINITIONS.find(p => p.id === 'fde')!;
      const fdeHtml = `
        <div class="card">
          <h3 class="package-title">
            <a href="https://fde.gov.pk/download/renovation-labs/">22-08-2026, RENOVATION OF LABORATORIES IN EDUCATIONAL INSTITUTIONS</a>
          </h3>
        </div>
      `;
      const fdeRes = parsePortalHtml(fdeHtml, fdePortal);
      expect(fdeRes.items.length).toBe(1);
      expect(fdeRes.items[0].title).toBe('RENOVATION OF LABORATORIES IN EDUCATIONAL INSTITUTIONS');
      expect(fdeRes.items[0].closingDate).toContain('2026-08-22');

      // 3. PSDF .inner-advertisement-listing-box
      const psdfPortal = PORTAL_DEFINITIONS.find(p => p.id === 'psdf')!;
      const psdfHtml = `
        <div class="inner-advertisement-listing-box">
          <img class="adver-thumbnail" src="https://psdf.org.pk/wp-content/uploads/2026/10/Notice.png" />
          <h4 class="listingadver-title1">Hiring of Training Service Providers for Youth Skills</h4>
        </div>
      `;
      const psdfRes = parsePortalHtml(psdfHtml, psdfPortal);
      expect(psdfRes.items.length).toBe(1);
      expect(psdfRes.items[0].title).toBe('Hiring of Training Service Providers for Youth Skills');
      expect(psdfRes.items[0].attachmentUrls?.[0]).toContain('Notice.png');

      // 4. PSEB Elementor PDF links with generic "Click to view" label
      const psebPortal = PORTAL_DEFINITIONS.find(p => p.id === 'pseb')!;
      const psebHtml = `
        <div class="e-con">
          <span>Submission Deadline: September 25, 2026</span>
          <a href="https://techdestination.com/wp-content/uploads/2026/10/RFP-for-Purchase-of-Stationery-Items.pdf">Click to view</a>
          <a href="https://techdestination.com/wp-content/uploads/2025/01/Pakistan-Recognized-as-the-Tech-Destination-of-the-Year-1.pdf">READ MORE</a>
        </div>
      `;
      const psebRes = parsePortalHtml(psebHtml, psebPortal);
      expect(psebRes.items.length).toBe(1);
      expect(psebRes.items[0].title).toBe('RFP for Purchase of Stationery Items');
      expect(psebRes.items[0].closingDate).toContain('2026-09-25');

      // 5. Ignite / PEEF table rows where first link is "Download" and dates use ordinals/Month DD, YYYY
      const ignitePortal = PORTAL_DEFINITIONS.find(p => p.id === 'ignite')!;
      const igniteHtml = `
        <table>
          <tbody>
            <tr>
              <td>Tender Notice - Provision of Solar Inverters</td>
              <td>Jun 30th 2026</td>
              <td>Jul 16th 2026</td>
              <td><a href="/wp-content/uploads/solar_rfp.pdf">Download</a></td>
            </tr>
          </tbody>
        </table>
      `;
      const igniteRes = parsePortalHtml(igniteHtml, ignitePortal);
      expect(igniteRes.items.length).toBe(1);
      expect(igniteRes.items[0].title).toBe('Tender Notice - Provision of Solar Inverters');
      expect(igniteRes.items[0].publishDate).toContain('2026-06-30');
      expect(igniteRes.items[0].closingDate).toContain('2026-07-16');

      // 6. Unauthenticated login_required portal with login.php link
      const tsPortal = PORTAL_DEFINITIONS.find(p => p.id === 'tender_services')!;
      const tsUnauthHtml = `
        <html><body>
          <a href="https://tenderservice.pk/permits/login.php">Login</a>
          <table><tbody><tr><td>Some marketing directory row text here</td></tr></tbody></table>
        </body></html>
      `;
      const tsRes = parsePortalHtml(tsUnauthHtml, tsPortal);
      expect(tsRes.hitlRequired).toBe(true);
      expect(tsRes.isLoginRequired).toBe(true);
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
      expect(portal?.last_error_message).toBe('0 tenders found on page — check website URL manually if active tenders are expected');
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
      // OCR dates are normalized to canonical UTC ISO (14:00 PKT = 09:00 UTC)
      expect(updated?.closing_date).toBe('2026-12-25T09:00:00.000Z');

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

  describe('Self-Healing Scraper & BPPRA ePPS Multi-Row Extraction', () => {
    const bppraTendersTableHtml = `
      <html><head><title>Tenders</title></head><body>
        <table class="table table-striped table-bordered border-primary fs-7">
          <thead>
            <tr>
              <th>Sr.</th>
              <th>Title & Documents</th>
              <th>Procuring Agency</th>
              <th>UNSPSC (Class of Object)</th>
              <th>Estimated budget</th>
            </tr>
          </thead>
          <tbody>
            <tr class="tender-row-main">
              <td class="td-sr-cell" rowspan="3">1</td>
              <td class="td-title-cell" rowspan="3">
                <div class="td-title-docs">
                  <div class="td-title-top">
                    <a class="cursor-pointer td-title-link">
                      <b>TSE-2627111220143</b><br>
                      Provision of Domestic Solar Energy Solutions in Tehsil Barshore<br>
                      <small><b>(Large Civil Works more than 25 Million PKR)</b></small>
                    </a>
                  </div>
                  <div class="td-doc-links">
                    <a class="td-doc-link" href="https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=105941">Bidding Document</a>
                    <a class="td-doc-link" href="https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/NITDocument.html?id=105941">NIT Document</a>
                    <a class="td-doc-link" href="https://bpptwo.vdc.services:9446/Images/BOQManual/solar-boq.pdf">BOQ Document</a>
                  </div>
                </div>
              </td>
              <td>URBAN PLANNING & DEV DEPARTMENT QUETTA</td>
              <td>Power Supply Solar and Energy Works</td>
              <td>Rs. 133,600,000 Approved</td>
            </tr>
            <tr class="tender-row-dates"><td colspan="3">Date</td></tr>
            <tr class="tender-row-dates">
              <td>
                <b>Publish:</b> <span>04-Nov-2026</span>
                <b>Dead Line:</b> <span>25-Nov-2026 10:00 AM</span>
                <b>Opening Date:</b> <span>25-Nov-2026 11:00 AM</span>
              </td>
              <td></td><td></td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    it('parses BPPRA multi-row (tr.tender-row-main + sibling tr.tender-row-dates) accurately without splitting rows', () => {
      const bppraPortal = PORTAL_DEFINITIONS.find(p => p.id === 'bppra')!;
      const result = parsePortalHtml(bppraTendersTableHtml, bppraPortal);

      expect(result.hitlRequired).toBe(false);
      expect(result.items.length).toBe(1);

      const item = result.items[0];
      expect(item.referenceNo).toBe('TSE-2627111220143');
      expect(item.title).toContain('Provision of Domestic Solar Energy Solutions in Tehsil Barshore');
      expect(item.organization).toContain('URBAN PLANNING & DEV DEPARTMENT QUETTA');
      expect(item.estimatedValue).toBe('Rs. 133,600,000 Approved');
      expect(item.publishDate).toContain('2026-11-04');
      expect(item.closingDate).toContain('2026-11-25');
      expect(item.attachmentUrls?.length).toBe(3);
      expect(item.attachmentUrls).toContain('https://bpptwo.vdc.services:9446/Images/BOQManual/solar-boq.pdf');
    });

    it('scores candidate tender navigation links on homepage accurately (Step 3)', () => {
      const homepageHtml = `
        <html><body>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About Us</a>
            <a href="/rules">Rules & Regulations</a>
            <a href="/Tenders">Tenders</a>
            <a href="/Tendersstats">More</a>
            <a href="https://www.google.com/maps/place/Balochistan+Public+Procurement+Regulatory+Authority(BPPRA)">Map</a>
          </nav>
        </body></html>
      `;
      const scored = scoreCandidateTenderLinks(homepageHtml, 'https://bpptwo.vdc.services:5451/');
      expect(scored.length).toBeGreaterThan(0);
      expect(scored[0].href).toBe('https://bpptwo.vdc.services:5451/Tenders');
      expect(scored[0].score).toBeGreaterThanOrEqual(15);
      // Should filter out Google Maps and negative-scored links
      expect(scored.some(s => s.href.includes('google.com/maps'))).toBe(false);
      expect(scored.some(s => s.href.includes('/rules'))).toBe(false);
    });

    it('auto-heals a broken tenders_url via 5-Step Discovery and updates SQLite portal_health', async () => {
      // Simulate legacy broken URL in SQLite for BPPRA
      updatePortalHealth('bppra', {
        base_url: 'https://bpptwo.vdc.services:5451',
        tenders_url: 'https://bppra.gob.pk/active-tenders/',
        access_mode: 'public',
        status: 'error',
        last_error_message: 'HTTP 500 from portal server'
      });

      const homepageHtml = `
        <html><head><title>BPPRA</title></head><body>
          <nav><a href="/Tenders">Tenders</a></nav>
        </body></html>
      `;

      crawlerDeps.fetchHtml = vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://bppra.gob.pk/active-tenders/') {
          throw new Error('HTTP 500 from portal server');
        }
        if (url === 'https://bpptwo.vdc.services:5451' || url === 'https://bppra.gob.pk') {
          return homepageHtml;
        }
        if (url === 'https://bpptwo.vdc.services:5451/Tenders') {
          return bppraTendersTableHtml;
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      crawlerDeps.downloadAndCacheDossier = vi.fn().mockResolvedValue(null);

      await startCrawlerScan('bppra', true);

      const healedRow = getPortalHealthList().find(p => p.portal_id === 'bppra');
      expect(healedRow?.status).toBe('online');
      expect(healedRow?.tenders_url).toBe('https://bpptwo.vdc.services:5451/Tenders');
      expect(healedRow?.verified_status).toContain('Auto-healed -> https://bpptwo.vdc.services:5451/Tenders');
      expect(healedRow?.last_error_message).toBeNull();
    });

    it('falls back to Adaptive AI HTML Layout Extraction when CSS selectors yield 0 items on custom DOM', async () => {
      const customDomHtml = `
        <html><body>
          <section class="custom-blazor-grid">
            <div class="custom-procurement-block">
              <span>Tender Notice Ref: BPPRA-SOLAR-2026</span>
              <span>Provision of Solar Energy Microgrids for Schools in Quetta</span>
              <span>Submission Deadline: 28-12-2026</span>
              <a href="/docs/solar-microgrid-nit.pdf">View Notice</a>
            </div>
          </section>
        </body></html>
      `;

      crawlerDeps.fetchHtml = vi.fn().mockResolvedValue(customDomHtml);

      const spyAiList = vi.spyOn(ocrSvc, 'extractTenderListFromHtmlWithAI').mockResolvedValueOnce([
        {
          referenceNo: 'BPPRA-SOLAR-2026',
          title: 'Provision of Solar Energy Microgrids for Schools in Quetta',
          organization: 'Balochistan BPPRA',
          directUrl: 'https://bpptwo.vdc.services:5451/docs/solar-microgrid-nit.pdf',
          closingDate: '2026-12-28T14:00:00+05:00',
          attachmentUrls: ['https://bpptwo.vdc.services:5451/docs/solar-microgrid-nit.pdf']
        }
      ]);

      const compacted = compactHtmlForAiExtraction(customDomHtml, 'https://bpptwo.vdc.services:5451');
      expect(compacted).toContain('[View Notice](https://bpptwo.vdc.services:5451/docs/solar-microgrid-nit.pdf)');

      await startCrawlerScan('bppra', true);

      expect(spyAiList).toHaveBeenCalledTimes(1);
      const savedTenders = getAllTenders();
      expect(savedTenders.some(t => t.reference_no === 'BPPRA-SOLAR-2026')).toBe(true);
      spyAiList.mockRestore();
    });
  });
  describe('Scraping Integrity & False-Positive Defenses', () => {
    it('strips select, option, form, and search filters in compactHtmlForAiExtraction', () => {
      const dirtyHtml = `
        <div>
          <form class="job-search">
            <select name="procurement_id">
              <option value="1">Historical Tender 1</option>
              <option value="2">Historical Tender 2</option>
            </select>
            <input type="text" placeholder="Search..." />
          </form>
          <div class="active-tenders">
            <a href="/tender/101">Genuine Live Tender 101</a>
          </div>
        </div>
      `;

      const compacted = compactHtmlForAiExtraction(dirtyHtml, 'https://example.gov.pk');
      expect(compacted).not.toContain('Historical Tender 1');
      expect(compacted).not.toContain('Historical Tender 2');
      expect(compacted).toContain('[Genuine Live Tender 101](https://example.gov.pk/tender/101)');
    });

    it('accurately parses GBPPRA .job-post-item cards and ignores dropdown options', () => {
      const gbppraHtml = `
        <div class="job-search">
          <select name="procurement_id">
            <option value="3284">"Capacity Building of Youth of GB in digital skills"</option>
          </select>
        </div>
        <div class="job-post-item">
          <div class="job-post-item-header">
            <h2>[TSE-202611043306]</h2>
            <h2>Fabrication of Ambulance District Health Office Hunza</h2>
          </div>
          <div class="job-post-item-body">
            <div><span class="fa fa-university"></span> <a href="#">District Health Officer Hunza</a></div>
            <div class="text-success">04 Nov, 2026</div>
            <div class="text-danger">20 Nov, 2026</div>
          </div>
          <div class="job-post-item-body">
            <a href="https://gbppra.gov.pk/storage/proc_files/9Kl6Xm1-metaQWR2ZXJ0aXNlbWVudCBGYWJyaWNhdGlvbiBvZiBBbWJ1bGFuY2UgRC5wZGY=-.pdf">Notice</a>
          </div>
          <div>
            <a href="https://gbppra.gov.pk/procurementdetails/3306" class="btn btn-primary">View Details</a>
          </div>
        </div>
      `;

      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'gilgit')!;
      const result = parsePortalHtml(gbppraHtml, portal);

      expect(result.items.length).toBe(1);
      const item = result.items[0];
      expect(item.referenceNo).toBe('TSE-202611043306');
      expect(item.title).toBe('Fabrication of Ambulance District Health Office Hunza');
      expect(item.organization).toBe('District Health Officer Hunza');
      expect(item.directUrl).toBe('https://gbppra.gov.pk/procurementdetails/3306');
      expect(item.attachmentUrls).toEqual([
        'https://gbppra.gov.pk/storage/proc_files/9Kl6Xm1-metaQWR2ZXJ0aXNlbWVudCBGYWJyaWNhdGlvbiBvZiBBbWJ1bGFuY2UgRC5wZGY=-.pdf'
      ]);
    });

    it('identifies generic listing URLs vs specific detail pages', () => {
      const portal = PORTAL_DEFINITIONS.find(p => p.id === 'gilgit')!;
      expect(isGenericListingUrl('https://gbppra.gov.pk', portal)).toBe(true);
      expect(isGenericListingUrl('https://gbppra.gov.pk/', portal)).toBe(true);
      expect(isGenericListingUrl('https://gbppra.gov.pk/tenders', portal)).toBe(true);
      expect(isGenericListingUrl('https://gbppra.gov.pk/procurementdetails/3306', portal)).toBe(false);
      expect(isGenericListingUrl('https://gbppra.gov.pk/storage/proc_files/notice.pdf', portal)).toBe(false);
    });

    it('guards analyzeTenderById against whole-body PDF scraping when direct_url is a listing URL', async () => {
      // Seed tender with generic portal URL
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, title, organization, direct_url, pipeline_status)
        VALUES ('t-generic-url-guard', 't-generic-url-guard', 'gilgit', 'GBPPRA', 'Unique Unmatched Opportunity Title', 'Govt of GB', 'https://gbppra.gov.pk/', 'New Opportunity')
      `).run();

      const homepageWithUnrelatedPdfs = `
        <html><body>
          <div class="banner">
            <a href="https://gbppra.gov.pk/storage/proc_files/completely-unrelated-file.pdf">Random PDF</a>
          </div>
          <div>Other Unrelated Content</div>
        </body></html>
      `;

      crawlerDeps.fetchHtml = vi.fn().mockResolvedValue(homepageWithUnrelatedPdfs);

      const analyzed = await analyzeTenderById('t-generic-url-guard', { forceRefresh: true });
      expect(analyzed).not.toBeNull();
      // Must NOT scrape the random unrelated PDF from the homepage
      const dossiers = Array.isArray(analyzed?.cached_dossiers) ? analyzed.cached_dossiers : JSON.parse(analyzed?.cached_dossiers as any || '[]');
      expect(dossiers.length).toBe(0);
    });

    it('enforces the 7-Rule Auto-Healer Governance & Anti-Corruption Framework', async () => {
      const punjabPortal = PORTAL_DEFINITIONS.find(p => p.id === 'punjab_eproc')!;

      // Rule 1: Never trigger auto-heal on 0-item scans, timeouts, or 502/503/504 errors; only on 404/410/500 or manual trigger
      expect(shouldTriggerAutoHeal(null, false)).toBe(false);
      expect(shouldTriggerAutoHeal(new Error('Connection timed out'), false)).toBe(false);
      expect(shouldTriggerAutoHeal(new Error('ETIMEDOUT'), false)).toBe(false);
      expect(shouldTriggerAutoHeal(new Error('HTTP 503 from portal server'), false)).toBe(false);
      expect(shouldTriggerAutoHeal(new Error('HTTP 404 from portal server'), false)).toBe(true);
      expect(shouldTriggerAutoHeal(new Error('HTTP 410 from portal server'), false)).toBe(true);
      expect(shouldTriggerAutoHeal(null, true)).toBe(true);

      // Rule 3: Registrable Domain Boundary Lock (block external ministry/footer links)
      expect(isAllowedPortalDomain('https://eproc.punjab.gov.pk/ActiveTenders.aspx', punjabPortal)).toBe(true);
      expect(isAllowedPortalDomain('https://sub.eproc.punjab.gov.pk/tenders', punjabPortal)).toBe(true);
      expect(isAllowedPortalDomain('https://unrelated-ministry.gov.pk/tenders', punjabPortal)).toBe(false);

      // Rule 4: Anti-Downgrade & Path Guard (never downgrade /ActiveTenders.aspx to root "/" or static file)
      expect(isValidHealedTendersUrl('https://eproc.punjab.gov.pk/', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('https://eproc.punjab.gov.pk/index.html', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('https://eproc.punjab.gov.pk/login', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('https://eproc.punjab.gov.pk/docs/manual.pdf', punjabPortal)).toBe(false);
      expect(isValidHealedTendersUrl('https://eproc.punjab.gov.pk/ViewTenders.aspx', punjabPortal)).toBe(true);

      // Rule 5: Quality-Verified Yield Proof (reject 0 items or 1 item without date+ref/attachment)
      expect(hasVerifiedTenderYield([])).toBe(false);
      expect(hasVerifiedTenderYield([{
        title: 'Unverified Single Link',
        organization: 'Org',
        directUrl: 'https://eproc.punjab.gov.pk/page'
      }])).toBe(false);
      expect(hasVerifiedTenderYield([{
        title: 'Verified Single Tender',
        organization: 'Org',
        directUrl: 'https://eproc.punjab.gov.pk/tender/1',
        closingDate: '2026-12-01T14:00:00.000Z',
        referenceNo: 'PPRA-2026-01'
      }])).toBe(true);

      // Rule 6: Strict base_url Origin Normalization
      expect(sanitizeBaseOrigin('https://www.giz.de/en/workingwithgiz/bidding_procurement.html')).toBe('https://www.giz.de');
    });

    it('never runs healPortalConnection on a 0-item HTTP 200 scan and surfaces manual URL check warning', async () => {
      const emptyPageHtml = '<html><body><div>Welcome to portal</div></body></html>';
      const fetchSpy = vi.fn().mockResolvedValue(emptyPageHtml);
      crawlerDeps.fetchHtml = fetchSpy;

      await startCrawlerScan('peef', true);

      // Should only fetch the primary tendersUrl once, never crawling homepage/candidates on 0-item scan
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const peefHealth = getPortalHealthList().find(p => p.portal_id === 'peef');
      expect(peefHealth?.tenders_url).toBe('https://peef.org.pk/tenders');
      expect(peefHealth?.last_error_message).toContain('0 tenders found on page — check website URL manually');
    });

    it('parses Ignite table rows without creating a fake <article> wrapper mega-row', () => {
      const igniteHtml = `
        <article class="post-page">
          <h2>Tender Notice</h2>
          <table>
            <tbody>
              <tr>
                <td>1</td>
                <td><a href="https://ignite.org.pk/wp-content/uploads/rfp-cloud.pdf">RFP for National Cloud Infrastructure</a></td>
                <td>15-11-2026</td>
                <td>30-11-2026</td>
              </tr>
              <tr>
                <td>2</td>
                <td><a href="https://ignite.org.pk/wp-content/uploads/rfp-cyber.pdf">Hiring of Cybersecurity Audit Firm</a></td>
                <td>16-11-2026</td>
                <td>05-12-2026</td>
              </tr>
            </tbody>
          </table>
        </article>
      `;
      const ignitePortal = PORTAL_DEFINITIONS.find(p => p.id === 'ignite')!;
      const res = parsePortalHtml(igniteHtml, ignitePortal);
      expect(res.items.length).toBe(2);
      expect(res.items.some(i => i.title === 'Tender Notice')).toBe(false);
    });

    it('parses PSDF dropdown PDFs and lazy-loaded images while skipping evaluation reports and old archives', () => {
      const psdfHtml = `
        <div id="tendersdownload-button">
          <div class="dropdown-content">
            <a href="https://psdf.org.pk/wp-content/uploads/2026/02/Advance-Tech-Digital-Skills-Scholarship-Program-2025-26-2.pdf">
              <ul class="tenders-dropdown-inner">
                <li>Advance Tech Digital Skills Scholarship Program (2025-26)</li>
              </ul>
            </a>
            <a href="https://psdf.org.pk/wp-content/uploads/2026/05/Technical-Evaluation-Report-Procurement-of-Tool-Kits-1.pdf">
              <ul class="tenders-dropdown-inner">
                <li>Technical Evaluation Report</li>
              </ul>
            </a>
            <a href="https://psdf.org.pk/wp-content/uploads/2022/09/Old-Archive-RFP.pdf">
              <ul class="tenders-dropdown-inner">
                <li>Old 2022 RFP</li>
              </ul>
            </a>
          </div>
        </div>
        <div class="inner-advertisement-listing-box">
          <img class="adver-thumbnail" data-lazy-src="https://psdf.org.pk/wp-content/uploads/2026/10/umeed-ad.jpg" src="" />
          <h4 class="listingadver-title1" style="display:none;">Hiring of Training Service Providers for Umeed Program</h4>
          <h4 class="listingadver-title">Hiring of Training Servic</h4>
        </div>
      `;
      const psdfPortal = PORTAL_DEFINITIONS.find(p => p.id === 'psdf')!;
      const res = parsePortalHtml(psdfHtml, psdfPortal);
      expect(res.items.length).toBe(2);
      expect(res.items[0].title).toBe('Advance Tech Digital Skills Scholarship Program (2025-26)');
      expect(res.items[0].attachmentUrls).toEqual(['https://psdf.org.pk/wp-content/uploads/2026/02/Advance-Tech-Digital-Skills-Scholarship-Program-2025-26-2.pdf']);
      expect(res.items[1].title).toBe('Hiring of Training Service Providers for Umeed Program');
      expect(res.items[1].attachmentUrls).toEqual(['https://psdf.org.pk/wp-content/uploads/2026/10/umeed-ad.jpg']);
    });

    it('filters NDMA evaluation reports, normalizes double slashes, and supports FDE WPDM & UNGM rows', () => {
      // 1. NDMA
      const ndmaHtml = `
        <div class="tender-card">
          <div class="tender-card__title"><a href="https://www.ndma.gov.pk//storage/tender/eval-1.pdf">Technical Evaluation Report for Relief Tents</a></div>
        </div>
        <div class="tender-card">
          <div class="tender-card__title"><a href="https://www.ndma.gov.pk//storage/tender/nit-solar.pdf">Procurement of Emergency Solar Generators</a></div>
          <div data-label="Closing">25-11-2026</div>
        </div>
      `;
      const ndmaPortal = PORTAL_DEFINITIONS.find(p => p.id === 'ndma')!;
      const ndmaRes = parsePortalHtml(ndmaHtml, ndmaPortal);
      expect(ndmaRes.items.length).toBe(1);
      expect(ndmaRes.items[0].title).toBe('Procurement of Emergency Solar Generators');
      expect(ndmaRes.items[0].directUrl).toBe('https://www.ndma.gov.pk/storage/tender/nit-solar.pdf');

      // 2. FDE WPDM
      const fdeHtml = `
        <div class="card">
          <h3 class="package-title"><a href="https://fde.gov.pk/download/supply-of-science-kits/">20-11-2026, Supply of Science Kits for Model Colleges</a></h3>
          <a class="wpdm-download-link" data-downloadurl="https://fde.gov.pk/download/supply-of-science-kits/?wpdmdl=4512" href="#">Download</a>
        </div>
      `;
      const fdePortal = PORTAL_DEFINITIONS.find(p => p.id === 'fde')!;
      const fdeRes = parsePortalHtml(fdeHtml, fdePortal);
      expect(fdeRes.items.length).toBe(1);
      expect(fdeRes.items[0].attachmentUrls).toContain('https://fde.gov.pk/download/supply-of-science-kits/?wpdmdl=4512');

      // 3. UNGM
      const ungmHtml = `
        <div class="tableRow dataRow notice-table" data-noticeid="299104">
          <div class="tableCell"><a href="/Public/Notice/299104"><span class="ungm-title">Provision of Solar Hybrid Systems for Health Facilities in KP</span></a></div>
          <div class="tableCell">28-Nov-2026</div>
          <div class="tableCell">10-Nov-2026</div>
          <div class="tableCell">UNDP</div>
          <div class="tableCell">Request for proposal</div>
          <div class="tableCell">UNDP-PAK-00921</div>
        </div>
      `;
      const ungmPortal = PORTAL_DEFINITIONS.find(p => p.id === 'ungm')!;
      const ungmRes = parsePortalHtml(ungmHtml, ungmPortal);
      expect(ungmRes.items.length).toBe(1);
      expect(ungmRes.items[0].title).toBe('Provision of Solar Hybrid Systems for Health Facilities in KP');
      expect(ungmRes.items[0].referenceNo).toBe('UNDP-PAK-00921');
      expect(ungmRes.items[0].organization).toContain('UNDP');
      expect(ungmRes.items[0].directUrl).toBe('https://www.ungm.org/Public/Notice/299104');
    });
  });

  describe('Document Pre-Fetch & Automated Deadline Enforcement', () => {
    it('pre-fetches document upfront when tender lacks closingDate and saves extracted metadata with cached_dossier', async () => {
      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === 'pseb')!;
      const testItem: RawScrapedItem = {
        title: 'Procurement of Enterprise Cloud Services',
        organization: 'Pakistan Software Export Board',
        directUrl: 'https://techdestination.com/wp-content/uploads/2026/11/Cloud-Procurement.pdf',
        attachmentUrls: ['https://techdestination.com/wp-content/uploads/2026/11/Cloud-Procurement.pdf']
      };

      const tracks = [{
        id: 'track-it',
        name: 'IT & Software',
        positive_keywords: ['cloud', 'enterprise'],
        negative_keywords: [],
        is_active: 1
      }];

      crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (tenderId, url, label) => {
        const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
        fs.mkdirSync(tenderDir, { recursive: true });
        fs.writeFileSync(path.resolve(tenderDir, 'Cloud-Procurement.pdf'), 'fake-pdf-content');
        return {
          label: 'Cloud Procurement',
          localPath: `/api/dossiers/${tenderId}/Cloud-Procurement.pdf`,
          originalUrl: url,
          mimeType: 'application/pdf',
          sha256: 'cloud123sha',
          sizeBytes: 1024
        };
      });

      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'PSEB-CLOUD-2026',
        organization: '',
        title: '',
        closingDateISO: '2026-12-20T15:00:00+05:00',
        closingDateFormatted: '20 Dec 2026, 03:00 PM PKT',
        summaryScope: 'Full cloud migration and hosting services for Pakistani tech export firms.',
        estimatedValue: 'PKR 85,000,000',
        isCorrigendum: false
      });

      const res = await processAndSaveTender(testItem, portalDef, tracks);
      expect(res.isNew).toBe(true);

      const saved = getAllTenders().find(t => t.title === testItem.title);
      expect(saved).toBeDefined();
      expect(saved?.reference_no).toBe('PSEB-CLOUD-2026');
      // OCR dates are normalized to canonical UTC ISO before persisting (15:00 PKT = 10:00 UTC)
      expect(saved?.closing_date).toBe('2026-12-20T10:00:00.000Z');
      expect(saved?.estimated_value).toBe('PKR 85,000,000');
      expect(saved?.description).toContain('Full cloud migration');
      expect(saved?.cached_dossiers?.length).toBe(1);
      expect(saved?.cached_dossiers?.[0].sha256).toBe('cloud123sha');

      spyOcr.mockRestore();
    });

    it('strictly skips saving and suppresses tender when extracted document deadline is in the past (Rule B6)', async () => {
      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === 'pseb')!;
      const expiredItem: RawScrapedItem = {
        title: 'RFP for Purchase of Stationery Computer Stationery Items through Close Frame Work Agreement',
        organization: 'Pakistan Software Export Board (TechDestination)',
        directUrl: 'https://techdestination.com/wp-content/uploads/2026/10/RFP-for-Purchase-of-Stationery.pdf',
        attachmentUrls: ['https://techdestination.com/wp-content/uploads/2026/10/RFP-for-Purchase-of-Stationery.pdf']
      };

      const tracks = [{
        id: 'track-stationery',
        name: 'Office Stationery',
        positive_keywords: ['stationery', 'computer'],
        negative_keywords: [],
        is_active: 1
      }];

      crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (tenderId, url, label) => {
        const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
        fs.mkdirSync(tenderDir, { recursive: true });
        fs.writeFileSync(path.resolve(tenderDir, 'RFP-for-Purchase-of-Stationery.pdf'), 'fake-pdf-content');
        return {
          label: 'Stationery RFP',
          localPath: `/api/dossiers/${tenderId}/RFP-for-Purchase-of-Stationery.pdf`,
          originalUrl: url,
          mimeType: 'application/pdf',
          sha256: 'stationerysha',
          sizeBytes: 2048
        };
      });

      // Extracted deadline is Oct 22, 2026 (past deadline relative to simulated/current Nov 10, 2026)
      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'FFW10221',
        organization: '',
        title: '',
        closingDateISO: '2026-10-22T15:00:00+05:00',
        closingDateFormatted: '22 Oct 2026, 03:00 PM PKT',
        summaryScope: 'Purchase of stationery items for PSEB.',
        estimatedValue: null,
        isCorrigendum: false
      });

      const res = await processAndSaveTender(expiredItem, portalDef, tracks);
      expect(res.isNew).toBe(false);

      // Verify tender was never inserted into SQLite
      const foundInDb = getAllTenders().find(t => t.title === expiredItem.title);
      expect(foundInDb).toBeUndefined();

      // Verify suppression record was created in deleted_tenders
      const deletedRecord = db.prepare('SELECT * FROM deleted_tenders WHERE id LIKE ?').get('%pseb%') as any;
      expect(deletedRecord).toBeDefined();

      spyOcr.mockRestore();
    });

    it('auto-expires unreviewed tender when fetchDocumentsForTender extracts an expired deadline', async () => {
      // Insert a fresh opportunity without closing date
      const testId = 'tender-test-fetch-expired-1';
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, pipeline_status, closing_date)
        VALUES (?, ?, 'Tender Under Fetch Review', 'Org', 'fde', 'Federal Directorate of Education', 'https://fde.gov.pk/download/rfp-science.pdf', 'New Opportunity', NULL)
      `).run(testId, testId);

      crawlerDeps.fetchFileBuffer = vi.fn().mockResolvedValue(Buffer.from('dummy-pdf-content'));

      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'FDE-LAB-2025',
        organization: '',
        title: '',
        closingDateISO: '2025-10-30T11:00:00+05:00',
        closingDateFormatted: '30 Oct 2025, 11:00 AM PKT',
        summaryScope: 'Expired Science Lab RFP',
        estimatedValue: null,
        isCorrigendum: false
      });

      const result = await fetchDocumentsForTender(testId);
      expect(result.expired).toBe(true);
      expect(result.tender).toBeNull();

      const foundAfter = getTenderById(testId);
      expect(foundAfter).toBeNull();

      spyOcr.mockRestore();
    });

    it('auto-expires unreviewed tender when analyzeTenderById extracts an expired deadline', async () => {
      const testId = 'tender-test-analyze-expired-1';
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, pipeline_status, closing_date, cached_dossiers)
        VALUES (?, ?, 'Tender For AI Analysis', 'Org', 'fde', 'Federal Directorate of Education', 'https://fde.gov.pk/test2', 'New Opportunity', NULL, ?)
      `).run(
        testId,
        testId,
        JSON.stringify([{
          label: 'Notice',
          localPath: `/api/dossiers/${testId}/notice.pdf`,
          originalUrl: 'https://fde.gov.pk/notice.pdf',
          mimeType: 'application/pdf',
          sha256: 'notice999',
          sizeBytes: 1024
        }])
      );

      const tenderDir = path.resolve(DOSSIERS_DIR, testId);
      fs.mkdirSync(tenderDir, { recursive: true });
      fs.writeFileSync(path.resolve(tenderDir, 'notice.pdf'), 'pdf-bytes');

      const spyOcr = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce({
        referenceNo: 'FDE-SEC-2025',
        organization: '',
        title: '',
        closingDateISO: '2025-12-23T11:00:00+05:00',
        closingDateFormatted: '23 Dec 2025, 11:00 AM PKT',
        summaryScope: 'Security guard provision',
        estimatedValue: null,
        isCorrigendum: false
      });

      const result = await analyzeTenderById(testId);
      expect(result).toBeNull();

      const foundAfter = getTenderById(testId);
      expect(foundAfter).toBeNull();

      spyOcr.mockRestore();
    });
  });

  describe('Pipeline audit regressions (findings 1-5)', () => {
    const DAY = 86400000;
    const psebPortal = () => PORTAL_DEFINITIONS.find(p => p.id === 'pseb')!;
    const itTracks = [{
      id: 'track-it',
      name: 'IT & Software',
      positive_keywords: ['cloud', 'servers'],
      negative_keywords: [],
      is_active: 1
    }];
    const ocrResult = (closingDateISO: string | null) => ({
      referenceNo: 'AUDIT-REF-1',
      closingDateISO,
      closingDateFormatted: 'Not Available',
      summaryScope: 'Audit regression scope',
      estimatedValue: null,
      isCorrigendum: false,
      organization: null,
      title: null
    } as any);
    const mockDownloadWritingPdf = () => {
      crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (tenderId: string, url: string) => {
        const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
        fs.mkdirSync(tenderDir, { recursive: true });
        fs.writeFileSync(path.resolve(tenderDir, 'notice.pdf'), 'fake-pdf');
        return {
          label: 'Notice',
          localPath: `/api/dossiers/${tenderId}/notice.pdf`,
          originalUrl: url,
          mimeType: 'application/pdf',
          sha256: `sha-${tenderId}`,
          sizeBytes: 8
        };
      });
    };
    const insertTender = (id: string, extra: { closing_date?: string | null; status?: string; bookmarked?: number; directUrl?: string; dossiers?: any[] } = {}) => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, pipeline_status, closing_date, is_bookmarked, cached_dossiers)
        VALUES (?, ?, 'Cloud Servers Supply', 'Org', 'fde', 'Federal Directorate of Education', ?, ?, ?, ?, ?)
      `).run(
        id, id,
        extra.directUrl ?? 'https://fde.gov.pk/download/cloud-servers.pdf',
        extra.status ?? 'New Opportunity',
        extra.closing_date ?? null,
        extra.bookmarked ?? 0,
        JSON.stringify(extra.dossiers ?? [])
      );
    };

    // Finding 1
    it('never persists an unparseable OCR deadline (it would escape B6 and every retention query)', async () => {
      mockDownloadWritingPdf();
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(ocrResult('next Friday'));

      const res = await processAndSaveTender({
        title: 'Supply of Cloud Servers',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/wp-content/uploads/2026/11/cloud-servers.pdf'
      }, psebPortal(), itTracks);

      expect(res.isNew).toBe(true);
      const saved = getAllTenders()[0];
      expect(saved.closing_date).toBeNull();
      expect(saved.closing_date_formatted).toBe('Not Available');
    });

    it('drops an unparseable scraped closing date instead of storing it', async () => {
      const res = await processAndSaveTender({
        title: 'Supply of Cloud Servers for Data Centre',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-servers',
        closingDate: 'To be announced'
      }, psebPortal(), itTracks);

      expect(res.isNew).toBe(true);
      const row = db.prepare('SELECT closing_date FROM tenders').get() as any;
      expect(row.closing_date).toBeNull();
    });

    it('rejects a direct-document tender whose OCR deadline (with Z offset) is in the past', async () => {
      mockDownloadWritingPdf();
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(
        ocrResult(new Date(Date.now() - 3 * DAY).toISOString())
      );

      const res = await processAndSaveTender({
        title: 'Cloud Servers Annual Maintenance',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/wp-content/uploads/2026/11/cloud-amc.pdf'
      }, psebPortal(), itTracks);

      expect(res.isNew).toBe(false);
      expect(getAllTenders().length).toBe(0);
      expect((db.prepare('SELECT COUNT(*) c FROM deleted_tenders').get() as any).c).toBe(1);
    });

    // Finding 2
    it('keeps undated and still-recent suppression records through retention cleanup', async () => {
      const { cleanExpiredDeletedTenderRecords } = await import('../../src/server/db.js');
      const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
      const ins = db.prepare(`INSERT INTO deleted_tenders (id, canonical_id, closing_date, deleted_at) VALUES (?, ?, ?, datetime('now', ?))`);
      ins.run('undated-old', 'undated-old', null, '-30 days');          // previously purged after 7 days
      ins.run('recently-deleted', 'recently-deleted', iso(-20), '-10 days'); // inside 90-day window
      ins.run('long-gone', 'long-gone', iso(-200), '-100 days');         // both windows passed

      const removed = cleanExpiredDeletedTenderRecords();
      expect(removed).toBe(1);
      const ids = (db.prepare('SELECT id FROM deleted_tenders ORDER BY id').all() as any[]).map(r => r.id);
      expect(ids).toEqual(['recently-deleted', 'undated-old']);
    });

    it('does not resurrect a user-deleted undated tender after the retention cycle runs', async () => {
      const { deleteTenders: repoDelete, cleanExpiredDeletedTenderRecords } = await import('../../src/server/db.js');
      const item: RawScrapedItem = {
        title: 'Cloud Servers Procurement Notice',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-servers-procurement'
      };
      await processAndSaveTender({ ...item }, psebPortal(), itTracks);
      const id = getAllTenders()[0].id;
      repoDelete([id], 'user');
      db.prepare(`UPDATE deleted_tenders SET deleted_at = datetime('now', '-30 days')`).run();

      cleanExpiredDeletedTenderRecords();
      const again = await processAndSaveTender({ ...item }, psebPortal(), itTracks);
      expect(again.isNew).toBe(false);
      expect(getAllTenders().length).toBe(0);
      // The re-sighting refreshed the suppression record
      const rec = db.prepare(`SELECT julianday('now') - julianday(deleted_at) AS age FROM deleted_tenders WHERE id = ?`).get(id) as any;
      expect(rec.age).toBeLessThan(1);
    });

    // Finding 3
    it('suppresses tenders deleted from a later pipeline stage so they are not re-imported', async () => {
      const { deleteTenders: repoDelete } = await import('../../src/server/db.js');
      const item: RawScrapedItem = {
        title: 'Cloud Servers Under Review',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-servers-review',
        closingDate: new Date(Date.now() + 20 * DAY).toISOString()
      };
      await processAndSaveTender({ ...item }, psebPortal(), itTracks);
      const id = getAllTenders()[0].id;
      db.prepare(`UPDATE tenders SET pipeline_status = 'Under Review' WHERE id = ?`).run(id);

      repoDelete([id], 'user');
      expect(db.prepare('SELECT 1 FROM deleted_tenders WHERE id = ?').get(id)).toBeDefined();

      const again = await processAndSaveTender({ ...item }, psebPortal(), itTracks);
      expect(again.isNew).toBe(false);
      expect(getTenderById(id)).toBeNull();
    });

    // Finding 4
    it('keeps the listing deadline when a direct document OCR shows an older, past deadline', async () => {
      mockDownloadWritingPdf();
      const listingDeadline = new Date(Date.now() + 15 * DAY).toISOString();
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(
        ocrResult(new Date(Date.now() - 10 * DAY).toISOString())
      );

      const res = await processAndSaveTender({
        title: 'Cloud Servers Extended Notice',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/wp-content/uploads/2026/11/cloud-extended.pdf',
        closingDate: listingDeadline
      }, psebPortal(), itTracks);

      expect(res.isNew).toBe(true);
      expect(getAllTenders()[0].closing_date).toBe(listingDeadline);
    });

    it('background attachment OCR with a past date does not delete a tender with a later known deadline', async () => {
      mockDownloadWritingPdf();
      const listingDeadline = new Date(Date.now() + 15 * DAY).toISOString();
      const ocrSpy = vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(
        ocrResult(new Date(Date.now() - 10 * DAY).toISOString())
      );

      await processAndSaveTender({
        title: 'Cloud Servers With Annexure',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-annexure',
        closingDate: listingDeadline,
        attachmentUrls: ['https://techdestination.com/wp-content/uploads/2026/11/annexure.pdf']
      }, psebPortal(), itTracks);

      // Tender has no reference_no, so the background path runs OCR on the attachment
      await vi.waitFor(() => expect(ocrSpy).toHaveBeenCalled());
      await new Promise(r => setTimeout(r, 20));

      const saved = getAllTenders();
      expect(saved.length).toBe(1);
      expect(saved[0].closing_date).toBe(listingDeadline);
    });

    it('fetch-documents does not expire a tender with a future deadline because an attachment is older', async () => {
      const future = new Date(Date.now() + 12 * DAY).toISOString();
      insertTender('tender-audit-fetch-1', { closing_date: future });
      crawlerDeps.fetchFileBuffer = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(
        ocrResult(new Date(Date.now() - 30 * DAY).toISOString())
      );

      const result = await fetchDocumentsForTender('tender-audit-fetch-1');
      expect(result.expired).toBe(false);
      expect(result.tender?.pipeline_status).toBe('New Opportunity');
      expect(getTenderById('tender-audit-fetch-1')?.closing_date).toBe(future);
    });

    it('analyze does not auto-expire a bookmarked tender', async () => {
      const id = 'tender-audit-analyze-bm';
      insertTender(id, {
        bookmarked: 1,
        directUrl: 'https://fde.gov.pk/tenders/42',
        dossiers: [{ label: 'Notice', localPath: `/api/dossiers/${id}/notice.pdf`, originalUrl: 'https://fde.gov.pk/notice.pdf', mimeType: 'application/pdf', sha256: 'bm1', sizeBytes: 8 }]
      });
      fs.mkdirSync(path.resolve(DOSSIERS_DIR, id), { recursive: true });
      fs.writeFileSync(path.resolve(DOSSIERS_DIR, id, 'notice.pdf'), 'pdf');
      vi.spyOn(ocrSvc, 'extractTenderFromImage').mockResolvedValueOnce(
        ocrResult(new Date(Date.now() - 5 * DAY).toISOString())
      );

      const result = await analyzeTenderById(id);
      expect(result).not.toBeNull();
      expect(getTenderById(id)).not.toBeNull();
    });

    // Finding 5
    it('B6b keeps an old-published tender that has a valid future deadline', async () => {
      const res = await processAndSaveTender({
        title: 'Cloud Servers Re-advertised',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-readvertised',
        publishDate: new Date(Date.now() - 120 * DAY).toISOString(),
        closingDate: new Date(Date.now() + 10 * DAY).toISOString()
      }, psebPortal(), itTracks);
      expect(res.isNew).toBe(true);
    });

    it('B6b rejects and suppresses an undated tender published over 90 days ago', async () => {
      const res = await processAndSaveTender({
        title: 'Cloud Servers Stale Notice',
        organization: 'PSEB',
        directUrl: 'https://techdestination.com/tenders/cloud-stale',
        publishDate: new Date(Date.now() - 120 * DAY).toISOString()
      }, psebPortal(), itTracks);
      expect(res.isNew).toBe(false);
      expect(getAllTenders().length).toBe(0);
      expect((db.prepare('SELECT COUNT(*) c FROM deleted_tenders').get() as any).c).toBe(1);
    });

    it('B6c uses a rolling year window rather than a hard-coded 2010-2025 range', async () => {
      const { referencesOnlyPriorYears } = await import('../../src/server/scrapers/crawlerEngine.js');
      const jan2027 = new Date('2027-01-15T00:00:00Z');
      const mar2026 = new Date('2026-03-15T00:00:00Z');
      const nov2026 = new Date('2026-11-10T00:00:00Z');

      expect(referencesOnlyPriorYears('Annual Tender 2026', jan2027)).toBe(true); // old regex missed this
      expect(referencesOnlyPriorYears('Annual Tender 2026', nov2026)).toBe(false);
      expect(referencesOnlyPriorYears('Tender 2025 /uploads/2025/12/x.pdf', nov2026)).toBe(true);
      expect(referencesOnlyPriorYears('Replacing 2024 equipment, delivery 2026', nov2026)).toBe(false);
      expect(referencesOnlyPriorYears('Supply for FY 2025-26', mar2026)).toBe(false);
      expect(referencesOnlyPriorYears('Supply for FY 2025-26', nov2026)).toBe(true);
      expect(referencesOnlyPriorYears('RFP_2025_final.pdf', nov2026)).toBe(true); // underscore-delimited years
      expect(referencesOnlyPriorYears('Cloud servers, no year', nov2026)).toBe(false);
    });
  });
});