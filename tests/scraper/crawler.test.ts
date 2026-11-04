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
  scoreCandidateTenderLinks,
  healPortalConnection,
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
  });
});