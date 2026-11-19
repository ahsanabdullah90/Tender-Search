import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import * as ocrSvc from '../../src/server/services/ocrService.js';
import {
  db,
  initDatabase,
  DOSSIERS_DIR,
  getAllTenders,
  getTenderById,
  getJobsForTender,
  getExpiredUnreviewedTenderIds,
  setAppSetting,
  backfillExistingTenderDocumentJobs,
  requeueFailedJobs,
  pruneOldDailyVisionCounters
} from '../../src/server/db/index.js';
import { processAndSaveTender, crawlerDeps, currentScanStatus, orderDocumentCandidates } from '../../src/server/scrapers/crawlerEngine.js';
import { processDocumentQueue } from '../../src/server/services/ingestWorker.js';
import { networkMonitorDeps, resetNetworkMonitorForTests, checkNetworkHealth } from '../../src/server/services/networkMonitor.js';
import { beginScanBudget, endScanBudget } from '../../src/server/services/ingestBudget.js';
import { findSubmissionDeadlines } from '../../src/server/services/documentExtractor.js';
import { PORTAL_DEFINITIONS } from '../../src/server/scrapers/portalList.js';
import { createApp } from '../../server.js';
import { makePdf, FILLER } from '../fixtures/documents/buildFixtures.js';

const DAY = 86400000;
const pktDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * DAY + 5 * 3600000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
};
const noticePdf = (deadlineOffsetDays: number, extra: string[] = []) =>
  makePdf([...FILLER, ...extra, `Last date for submission of bids: ${pktDate(deadlineOffsetDays)} at 11:00 AM`]);

const portal = () => PORTAL_DEFINITIONS.find(p => p.id === 'pseb')!;
const tracks = [
  { id: 'track-it', name: 'IT & Software', positive_keywords: ['servers', 'laptops'], negative_keywords: ['cctv'], is_active: 1 },
  { id: 'track-solar', name: 'Solar & Clean Energy', positive_keywords: ['solar', 'inverter'], negative_keywords: [], is_active: 1 }
];

/** Mock downloader: serves a buffer per URL (or fails), writing it into the tender's dossier folder. */
function serveDocuments(files: Record<string, Buffer | Error>) {
  crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (tenderId: string, url: string, label?: string) => {
    const body = files[url];
    if (!body) return null;
    if (body instanceof Error) throw body;
    const name = path.basename(new URL(url).pathname);
    const dir = path.resolve(DOSSIERS_DIR, tenderId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.resolve(dir, name), body);
    const mimeType = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/pdf';
    return { label: label || name, localPath: `/api/dossiers/${tenderId}/${name}`, originalUrl: url, mimeType, sha256: `sha-${name}`, sizeBytes: body.length };
  });
}

describe('Phase 3: ingest flow, scan budget and background document worker', () => {
  const originalDownload = crawlerDeps.downloadAndCacheDossier;

  beforeEach(() => {
    initDatabase();
    for (const t of ['document_ingest_jobs', 'corrigendum_logs', 'pipeline_audit_logs', 'tenders', 'deleted_tenders']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM app_settings WHERE key LIKE 'ingest_%'`).run();
    setAppSetting('gemini_api_key', '');
    currentScanStatus.isScanning = false;
  });

  afterEach(() => {
    crawlerDeps.downloadAndCacheDossier = originalDownload;
    endScanBudget();
    currentScanStatus.isScanning = false;
    resetNetworkMonitorForTests();
    vi.restoreAllMocks();
  });

  it('orders documents: corrigendum first, then primary documents, capped at 5', () => {
    const urls = orderDocumentCandidates({
      directUrl: 'https://x.pk/listing',
      attachmentUrls: ['https://x.pk/boq.xlsx', 'https://x.pk/RFP.pdf', 'https://x.pk/Corrigendum-1.pdf', 'https://x.pk/a.pdf', 'https://x.pk/b.pdf', 'https://x.pk/c.pdf', 'https://x.pk/RFP.pdf']
    });
    expect(urls[0]).toBe('https://x.pk/Corrigendum-1.pdf');
    expect(urls[1]).toBe('https://x.pk/RFP.pdf');
    expect(urls).toHaveLength(5);
  });

  it('filters non-downloadable .html/.aspx links out of document candidates while retaining /pdf?file= and ?wpdmdl=', () => {
    const urls = orderDocumentCandidates({
      directUrl: 'https://bpptwo.vdc.services:5451/Tenders',
      attachmentUrls: [
        'https://bpptwo.vdc.services:9446/Reports/Works/BiddingDocumentWorks.html?id=101',
        'https://bpptwo.vdc.services:9446/Reports/GoodsProcurement/NITDocument.html?id=101',
        'https://epms.ppra.gov.pk/public/tenders/pdf?file=notice.pdf',
        'https://fde.gov.pk/?wpdmdl=5521',
        'https://bpptwo.vdc.services:9446/Images/BOQManual/real-boq.pdf'
      ]
    });
    expect(urls).toEqual([
      'https://epms.ppra.gov.pk/public/tenders/pdf?file=notice.pdf',
      'https://fde.gov.pk/?wpdmdl=5521',
      'https://bpptwo.vdc.services:9446/Images/BOQManual/real-boq.pdf'
    ]);
  });

  describe('ingest', () => {
    it('reads an undated tender\'s document locally before insert and records provenance (no Gemini)', async () => {
      const vision = vi.spyOn(ocrSvc, 'extractTenderFromImage');
      const url = 'https://techdestination.com/wp-content/uploads/2026/11/RFP-Servers.pdf';
      serveDocuments({ [url]: noticePdf(12, ['Tender No. PSEB/IT/2026-15']) });

      const res = await processAndSaveTender({ title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: url }, portal(), tracks);
      expect(res.isNew).toBe(true);
      const t = getAllTenders()[0];
      expect(t.closing_date).not.toBeNull();
      expect(t.deadline_source).toBe('primary_doc');
      expect(t.deadline_confidence).toBe('high');
      expect(t.doc_fetch_status).toBe('complete');
      expect(t.reference_no).toBe('PSEB/IT/2026-15');
      expect(t.cached_dossiers).toHaveLength(1);
      expect(t.publish_date).toBe('2026-11-30'); // upload-folder fallback, not "today"
      expect(vision).not.toHaveBeenCalled();
    });

    it('rejects and suppresses when the document deadline has clearly passed', async () => {
      const url = 'https://techdestination.com/wp-content/uploads/2026/09/RFP-Laptops.pdf';
      serveDocuments({ [url]: noticePdf(-20) });
      const res = await processAndSaveTender({ title: 'Supply of Laptops', organization: 'PSEB', directUrl: url }, portal(), tracks);
      expect(res.isNew).toBe(false);
      expect(getAllTenders()).toHaveLength(0);
      expect((db.prepare('SELECT COUNT(*) c FROM deleted_tenders').get() as any).c).toBe(1);
    });

    it('a corrigendum that moves the deadline earlier is applied and flagged, not deleted, and survives retention', async () => {
      const rfp = 'https://x.pk/uploads/RFP-Servers.pdf';
      const corr = 'https://x.pk/uploads/Corrigendum-Servers.pdf';
      serveDocuments({
        [rfp]: noticePdf(20),
        [corr]: makePdf(['CORRIGENDUM', ...FILLER, `The last date for submission of bids is revised to ${pktDate(-1)} at 11:00 AM`])
      });
      const res = await processAndSaveTender(
        { title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: 'https://x.pk/tenders/1', closingDate: new Date(Date.now() + 20 * DAY).toISOString(), attachmentUrls: [rfp, corr] },
        portal(),
        tracks
      );
      // Dated, not a direct document: nothing read before insert, both queued
      expect(res.isNew).toBe(true);
      const id = getAllTenders()[0].id;
      expect(getJobsForTender(id)).toHaveLength(2);

      await processDocumentQueue(5);
      const t = getTenderById(id)!;
      expect(t).not.toBeNull();
      expect(t.needs_review).toBe(1);
      expect(t.review_reason).toMatch(/^deadline_moved_earlier/);
      expect(t.deadline_source).toBe('corrigendum_doc');
      expect(new Date(t.closing_date!).getTime()).toBeLessThan(Date.now());
      expect(getExpiredUnreviewedTenderIds(0, 100)).not.toContain(id);
    });

    it('queues documents whose upfront download fails, then the worker recovers them', async () => {
      const url = 'https://x.pk/uploads/2026/11/Notice-Servers.pdf';
      serveDocuments({ [url]: new Error('ETIMEDOUT') });
      await processAndSaveTender({ title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: url }, portal(), tracks);
      const id = getAllTenders()[0].id;
      expect(getTenderById(id)!.doc_fetch_status).toBe('pending');
      expect(getJobsForTender(id)[0].status).toBe('pending');

      serveDocuments({ [url]: noticePdf(9) });
      const report = await processDocumentQueue(5);
      expect(report.completed).toBe(1);
      const t = getTenderById(id)!;
      expect(t.doc_fetch_status).toBe('complete');
      expect(t.closing_date).not.toBeNull();
      expect(t.deadline_source).toBe('primary_doc');
    });

    it('the scan time budget sends documents to the background queue', async () => {
      setAppSetting('ingest_upfront_time_budget_sec', '0');
      const budget = beginScanBudget();
      const url = 'https://x.pk/uploads/2026/11/Notice-Laptops.pdf';
      const download = vi.fn();
      crawlerDeps.downloadAndCacheDossier = download;
      await processAndSaveTender({ title: 'Supply of Laptops', organization: 'PSEB', directUrl: url }, portal(), tracks);
      expect(download).not.toHaveBeenCalled();
      expect(budget.documentsDeferred).toBe(1);
      expect(getAllTenders()[0].doc_fetch_status).toBe('pending');
    });

    it('the scan Vision budget defers scanned notices to the worker', async () => {
      setAppSetting('gemini_api_key', 'test-key');
      setAppSetting('ingest_vision_calls_per_scan', '0');
      const budget = beginScanBudget();
      const vision = vi.spyOn(ocrSvc, 'extractTenderFromImage');
      const url = 'https://x.pk/uploads/2026/11/notice-servers.jpg';
      serveDocuments({ [url]: Buffer.from('jpeg') });
      await processAndSaveTender({ title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: url }, portal(), tracks);
      expect(vision).not.toHaveBeenCalled();
      expect(budget.visionDeferred).toBe(1);
      const t = getAllTenders()[0];
      expect(t.cached_dossiers).toHaveLength(1);
      expect(getJobsForTender(t.id)).toHaveLength(1);
    });

    it('re-scores tracks from the document scope: gains a track, drops on a negative keyword', async () => {
      const url = 'https://x.pk/uploads/2026/11/RFP-Servers.pdf';
      serveDocuments({ [url]: noticePdf(10, ['Scope of Work: supply of rack servers with rooftop solar panels and inverter backup']) });
      await processAndSaveTender({ title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: url }, portal(), tracks);
      expect(getAllTenders()[0].domain_tracks).toEqual(expect.arrayContaining(['IT & Software', 'Solar & Clean Energy']));

      db.prepare('DELETE FROM tenders').run();
      const url2 = 'https://x.pk/uploads/2026/11/RFP-Laptops.pdf';
      serveDocuments({ [url2]: noticePdf(10, ['Scope of Work: supply of laptops and solar inverter with CCTV cameras']) });
      await processAndSaveTender({ title: 'Supply of Laptops and Solar Inverter', organization: 'PSEB', directUrl: url2 }, portal(), tracks);
      const t = getAllTenders()[0];
      expect(t.domain_tracks).toEqual(['Solar & Clean Energy']); // IT dropped: "cctv" is excluded for IT
    });

    it('B6b: an old upload folder rejects only when no document could be read', async () => {
      const unreadable = 'https://x.pk/wp-content/uploads/2025/01/Old-Servers.jpg';
      serveDocuments({ [unreadable]: Buffer.from('jpeg') });
      expect((await processAndSaveTender({ title: 'Supply of Rack Servers 2026', organization: 'PSEB', directUrl: unreadable }, portal(), tracks)).isNew).toBe(false);

      const readable = 'https://x.pk/wp-content/uploads/2025/01/Template-Laptops.pdf';
      serveDocuments({ [readable]: noticePdf(15) });
      expect((await processAndSaveTender({ title: 'Supply of Laptops 2026', organization: 'PSEB', directUrl: readable }, portal(), tracks)).isNew).toBe(true);
    });
  });

  describe('worker', () => {
    const queueDatedTender = async (title: string, url: string) => {
      await processAndSaveTender(
        { title, organization: 'PSEB', directUrl: `https://x.pk/tenders/${encodeURIComponent(title)}`, attachmentUrls: [url], closingDate: null, publishDate: new Date().toISOString().slice(0, 10) },
        portal(),
        tracks
      );
    };

    it('auto-expires an unreviewed tender when a recovered document shows the deadline passed', async () => {
      const url = 'https://x.pk/uploads/2026/11/RFP-Servers.pdf';
      serveDocuments({ [url]: new Error('ECONNRESET') });
      await queueDatedTender('Supply of Rack Servers', url);
      const id = getAllTenders()[0].id;

      serveDocuments({ [url]: noticePdf(-3) });
      const report = await processDocumentQueue(5);
      expect(report.expired).toBe(1);
      expect(getTenderById(id)).toBeNull();
      expect(db.prepare('SELECT 1 FROM deleted_tenders WHERE id = ?').get(id)).toBeDefined();
    });

    it('never auto-expires a bookmarked tender; flags it instead of deleting', async () => {
      const url = 'https://x.pk/uploads/2026/11/RFP-Laptops.pdf';
      serveDocuments({ [url]: new Error('ECONNRESET') });
      await queueDatedTender('Supply of Laptops', url);
      const id = getAllTenders()[0].id;
      db.prepare('UPDATE tenders SET is_bookmarked = 1 WHERE id = ?').run(id);

      serveDocuments({ [url]: noticePdf(-3) });
      await processDocumentQueue(5);
      expect(getTenderById(id)).not.toBeNull();
    });

    it('skips while a scan is running', async () => {
      currentScanStatus.isScanning = true;
      expect((await processDocumentQueue(5)).skipped).toBe('scan_running');
    });

    it('defers scanned documents when the daily Vision budget is spent, without using an attempt', async () => {
      setAppSetting('gemini_api_key', 'test-key');
      setAppSetting('ingest_vision_calls_per_day', '0');
      const url = 'https://x.pk/uploads/2026/11/notice-servers.jpg';
      serveDocuments({ [url]: new Error('ETIMEDOUT') });
      await queueDatedTender('Supply of Rack Servers', url);
      const id = getAllTenders()[0].id;

      serveDocuments({ [url]: Buffer.from('jpeg') });
      const report = await processDocumentQueue(5);
      expect(report.deferred).toBe(1);
      const job = getJobsForTender(id)[0];
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(job.last_error).toMatch(/Vision budget/);
    });
  });

  describe('API', () => {
    const app = createApp();

    it('PATCH /review confirms a flagged tender', async () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, title, organization, portal_id, portal_name, direct_url, needs_review, review_reason)
        VALUES ('t-flag', 't-flag', 'Flagged', 'Org', 'pseb', 'PSEB', 'https://x.pk/1', 1, 'deadline_moved_earlier: a → b')
      `).run();
      expect((await request(app).patch('/api/tenders/t-flag/review').send({ action: 'nope' })).status).toBe(400);
      const res = await request(app).patch('/api/tenders/t-flag/review').send({ action: 'confirm' });
      expect(res.status).toBe(200);
      expect(res.body.tender.needs_review).toBe(0);
      expect(res.body.tender.review_reason).toBeNull();
      expect((await request(app).patch('/api/tenders/missing/review').send({ action: 'confirm' })).status).toBe(404);
    });

    it('POST /retry-documents re-queues failed downloads', async () => {
      const url = 'https://x.pk/uploads/2026/11/RFP-Servers.pdf';
      serveDocuments({ [url]: new Error('ECONNRESET') });
      await processAndSaveTender({ title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: 'https://x.pk/t/9', attachmentUrls: [url], closingDate: new Date(Date.now() + 9 * DAY).toISOString() }, portal(), tracks);
      const id = getAllTenders()[0].id;
      db.prepare(`UPDATE document_ingest_jobs SET status = 'failed', attempts = 3 WHERE tender_id = ?`).run(id);
      db.prepare(`UPDATE tenders SET doc_fetch_status = 'failed' WHERE id = ?`).run(id);

      currentScanStatus.isScanning = true; // keep the kicked worker from running during the assertion
      const res = await request(app).post(`/api/tenders/${id}/retry-documents`);
      expect(res.status).toBe(200);
      expect(res.body.requeued).toBe(1);
      expect(res.body.tender.doc_fetch_status).toBe('pending');
      expect(getJobsForTender(id)[0].attempts).toBe(0);
    });

    it('P1-1: backfills existing direct-document and attachment_urls tenders and queues attachments on duplicate re-scan', async () => {
      db.prepare(`
        INSERT INTO tenders (
          id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
          closing_date, closing_date_formatted, pipeline_status, doc_fetch_status, cached_dossiers, attachment_urls
        ) VALUES
          ('t-legacy-pdf', 't-legacy-pdf', 'REF-LEG-1', 'Supply of Rack Servers Legacy', 'PSEB', 'pseb', 'PSEB', 'https://x.pk/uploads/2026/11/legacy.pdf', ?, '25 Nov 2026', 'New Opportunity', 'none', '[]', '[]'),
          ('t-legacy-html', 't-legacy-html', 'REF-LEG-2', 'Supply of Solar Panels Legacy', 'PSEB', 'pseb', 'PSEB', 'https://x.pk/tenders/2', ?, '25 Nov 2026', 'New Opportunity', 'none', '[]', '[]')
      `).run(
        new Date(Date.now() + 10 * DAY).toISOString(),
        new Date(Date.now() + 10 * DAY).toISOString()
      );

      // 1. Backfill catches the direct-document row
      const backfilled = backfillExistingTenderDocumentJobs();
      expect(backfilled).toBe(1);
      expect(getJobsForTender('t-legacy-pdf')).toHaveLength(1);
      expect(getTenderById('t-legacy-pdf')?.doc_fetch_status).toBe('pending');

      // 2. Re-scanning the HTML-listing duplicate with attachments attaches & queues them
      const attUrl = 'https://x.pk/uploads/2026/11/solar-rfp.pdf';
      await processAndSaveTender({
        referenceNo: 'REF-LEG-2',
        title: 'Supply of Solar Panels Legacy',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/2',
        attachmentUrls: [attUrl],
        closingDate: new Date(Date.now() + 10 * DAY).toISOString()
      }, portal(), tracks);

      const updatedHtml = getTenderById('t-legacy-html')!;
      expect(updatedHtml.attachment_urls).toEqual([attUrl]);
      expect(updatedHtml.doc_fetch_status).toBe('pending');
      expect(getJobsForTender('t-legacy-html').map(j => j.url)).toEqual([attUrl]);

      // 3. requeueFailedJobs also enqueues unqueued attachment_urls
      db.prepare(`DELETE FROM document_ingest_jobs WHERE tender_id = 't-legacy-html'`).run();
      db.prepare(`UPDATE tenders SET doc_fetch_status = 'none' WHERE id = 't-legacy-html'`).run();
      expect(requeueFailedJobs('t-legacy-html')).toBe(1);
      expect(getJobsForTender('t-legacy-html')).toHaveLength(1);
    });

    it('P1-4: flags needs_review when a duplicate re-scan reports an earlier calendar-day deadline', async () => {
      const initialClose = new Date(Date.now() + 12 * DAY).toISOString();
      const earlierClose = new Date(Date.now() + 6 * DAY).toISOString();

      await processAndSaveTender({
        referenceNo: 'REF-EARLIER-01',
        title: 'Supply of Enterprise Laptops',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/earlier',
        closingDate: initialClose
      }, portal(), tracks);

      const saved = getAllTenders()[0];
      expect(saved.needs_review).toBe(0);

      // Re-scan with an earlier calendar day
      const dupRes = await processAndSaveTender({
        referenceNo: 'REF-EARLIER-01',
        title: 'Supply of Enterprise Laptops',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/earlier',
        closingDate: earlierClose
      }, portal(), tracks);

      expect(dupRes.isNew).toBe(false);
      const after = getTenderById(saved.id)!;
      expect(after.closing_date).toBe(initialClose); // does not drag deadline backwards silently
      expect(after.needs_review).toBe(1);
      expect(after.review_reason).toMatch(/^deadline_moved_earlier:/);
    });

    it('P2-4: stages tender during upfront fetch and deletes staging row when B6 rejects', async () => {
      const url = 'https://x.pk/uploads/2026/10/expired-staging.pdf';
      let observedStatusDuringFetch: string | undefined;
      crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (tenderId: string) => {
        const row = db.prepare('SELECT ingestion_status FROM tenders WHERE id = ?').get(tenderId) as { ingestion_status: string } | undefined;
        observedStatusDuringFetch = row?.ingestion_status;
        // Also verify Inbox getAllTenders() hides the staging row while fetch is in flight
        expect(getAllTenders()).toHaveLength(0);
        const dir = path.resolve(DOSSIERS_DIR, tenderId);
        fs.mkdirSync(dir, { recursive: true });
        const buf = noticePdf(-5);
        fs.writeFileSync(path.join(dir, 'expired.pdf'), buf);
        return {
          label: 'Notice',
          localPath: `/api/dossiers/${tenderId}/expired.pdf`,
          originalUrl: url,
          mimeType: 'application/pdf',
          sha256: 'abc',
          sizeBytes: buf.length
        };
      });

      const res = await processAndSaveTender(
        { title: 'Supply of Rack Servers', organization: 'PSEB', directUrl: url },
        portal(),
        tracks
      );
      expect(observedStatusDuringFetch).toBe('staging');
      expect(res.isNew).toBe(false);
      const remaining = (db.prepare('SELECT count(*) as c FROM tenders').get() as { c: number }).c;
      expect(remaining).toBe(0);
    });

    it('P2-6, P2-7, P2-8: extracts new submission phrasings, prunes old daily vision counters, and updates ingest budgets via API', async () => {
      // P2-6
      const d1 = findSubmissionDeadlines('Date of bid submission: 28-11-2026 at 02:30 PM');
      const d2 = findSubmissionDeadlines('Submission of bids: 29-11-2026 by 11:00 AM');
      const d3 = findSubmissionDeadlines('Dropped in the tender box on or before 30-11-2026');
      expect(d1).toHaveLength(1);
      expect(d2).toHaveLength(1);
      expect(d3).toHaveLength(1);

      // P2-7
      setAppSetting('ingest_vision_calls_2025-01-01', '42');
      setAppSetting('ingest_vision_calls_2099-12-31', '5');
      expect(pruneOldDailyVisionCounters(7)).toBeGreaterThanOrEqual(1);
      const oldRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'ingest_vision_calls_2025-01-01'`).get();
      const futureRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'ingest_vision_calls_2099-12-31'`).get();
      expect(oldRow).toBeUndefined();
      expect(futureRow).toBeDefined();

      // P2-8
      const postRes = await request(app).post('/api/system/ingest-budgets').send({
        upfrontTimeBudgetSec: 180,
        maxFileMb: 30,
        visionCallsPerScan: 15,
        visionCallsPerDay: 80
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body.budgets).toMatchObject({
        upfrontTimeBudgetSec: 180,
        maxFileMb: 30,
        visionCallsPerScan: 15,
        visionCallsPerDay: 80
      });

      const getRes = await request(app).get('/api/system/ingest-budgets');
      expect(getRes.status).toBe(200);
      expect(getRes.body.upfrontTimeBudgetSec).toBe(180);
    });
  });

  describe('Audit Fixes: A1, A5, F4, F2, B8', () => {
    it('A1: undated tender older than 14 days re-scanned keeps stage, notes and dossiers', async () => {
      const url = 'https://x.pk/tenders/undated-laptop-tender';
      const item = { title: 'Procurement of Core Laptops', organization: 'PSEB', directUrl: url };
      const res1 = await processAndSaveTender(item, portal(), tracks);
      expect(res1.isNew).toBe(true);

      const tender = getAllTenders()[0];
      // Simulate age > 14 days, pipeline stage Under Review, custom notes, and a cached dossier
      db.prepare(`
        UPDATE tenders
        SET pipeline_status = 'Under Review',
            status_notes = 'Important evaluation notes',
            created_at = datetime('now', '-20 days'),
            cached_dossiers = ?
        WHERE id = ?
      `).run(JSON.stringify([{ label: 'Original Doc', localPath: '/api/dossiers/1/doc.pdf', originalUrl: url, mimeType: 'application/pdf', sha256: 'abc', sizeBytes: 100 }]), tender.id);

      // Re-scan of the same item
      const res2 = await processAndSaveTender(item, portal(), tracks);
      expect(res2.isNew).toBe(false);

      const after = getTenderById(tender.id)!;
      expect(after.pipeline_status).toBe('Under Review');
      expect(after.status_notes).toBe('Important evaluation notes');
      expect(after.cached_dossiers).toHaveLength(1);
      expect(after.cached_dossiers[0].label).toBe('Original Doc');
    });

    it('A5: earlier date flags for review, later date logs corrigendum', async () => {
      const url = 'https://x.pk/tenders/dated-server-tender';
      const res1 = await processAndSaveTender({
        title: 'Procurement of Edge Servers',
        organization: 'PSEB',
        directUrl: url,
        closingDate: '2026-12-15T10:00:00.000Z'
      }, portal(), tracks);
      expect(res1.isNew).toBe(true);
      const tenderId = getAllTenders()[0].id;

      // Re-scan with later date (extension)
      const res2 = await processAndSaveTender({
        title: 'Procurement of Edge Servers',
        organization: 'PSEB',
        directUrl: url,
        closingDate: '2026-12-25T10:00:00.000Z'
      }, portal(), tracks);
      expect(res2.isNew).toBe(false);
      expect(res2.hasCorrigendum).toBe(true);
      const extended = getTenderById(tenderId)!;
      expect(extended.closing_date).toBe('2026-12-25T10:00:00.000Z');
      expect(extended.has_corrigendum).toBe(1);
      const logs = db.prepare('SELECT * FROM corrigendum_logs WHERE tender_id = ?').all(tenderId) as any[];
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some(l => l.change_type === 'deadline_extension')).toBe(true);

      // Re-scan with earlier date
      const res3 = await processAndSaveTender({
        title: 'Procurement of Edge Servers',
        organization: 'PSEB',
        directUrl: url,
        closingDate: '2026-12-10T10:00:00.000Z'
      }, portal(), tracks);
      expect(res3.isNew).toBe(false);
      const flagged = getTenderById(tenderId)!;
      // Stored date should remain unchanged
      expect(flagged.closing_date).toBe('2026-12-25T10:00:00.000Z');
      expect(flagged.needs_review).toBe(1);
      expect(flagged.review_reason).toContain('earlier');
    });

    it('F4: suppressed tender returns with later future deadline', async () => {
      const url = 'https://x.pk/tenders/suppressed-tender';
      // First scan with past date
      const res1 = await processAndSaveTender({
        title: 'Old Servers RFP 2026',
        organization: 'PSEB',
        directUrl: url,
        closingDate: '2026-10-15T10:00:00.000Z'
      }, portal(), tracks);
      expect(res1.isNew).toBe(false);

      // Verify it was suppressed in deleted_tenders
      const deleted = db.prepare('SELECT * FROM deleted_tenders WHERE id LIKE ?').all('%pseb%') as any[];
      expect(deleted.length).toBeGreaterThanOrEqual(1);

      // Now tender returns with an extended future deadline
      const res2 = await processAndSaveTender({
        title: 'Old Servers RFP 2026',
        organization: 'PSEB',
        directUrl: url,
        closingDate: '2026-12-30T10:00:00.000Z'
      }, portal(), tracks);
      expect(res2.isNew).toBe(true);
      const unsuppressed = getAllTenders().find(t => t.title.includes('Old Servers'));
      expect(unsuppressed).toBeDefined();
      expect(unsuppressed?.closing_date).toBe('2026-12-30T10:00:00.000Z');
    });

    it('MATCH-3 / F2: generic title held as awaiting_scope; worker releases on matching PDF and drops on non-matching with reason = no-track-match', async () => {
      // Ensure only IT & Software track is active
      db.prepare(`DELETE FROM domain_tracks`).run();
      db.prepare(`
        INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
        VALUES ('track-it', 'IT & Software', '["servers", "laptops"]', '["cctv"]', 1)
      `).run();

      const matchDocUrl = 'https://x.pk/uploads/2026/11/Notice-Generic-1.pdf';
      const noMatchDocUrl = 'https://x.pk/uploads/2026/11/Notice-Generic-2.pdf';

      serveDocuments({
        [matchDocUrl]: noticePdf(10, ['Scope of Work: Supply of enterprise rack servers']),
        [noMatchDocUrl]: noticePdf(10, ['Scope of Work: Agricultural livestock feed and cattle fodder'])
      });

      // Item 1: No track match from title, has attachment
      const res1 = await processAndSaveTender({
        title: 'Tender Notice No 101',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/101',
        attachmentUrls: [matchDocUrl]
      }, portal(), tracks);
      expect(res1.isNew).toBe(false);
      expect(res1.awaitingScope).toBe(true);

      // Tender is stored as awaiting_scope
      const held = db.prepare(`SELECT * FROM tenders WHERE ingestion_status = 'awaiting_scope'`).all() as any[];
      expect(held.length).toBe(1);
      const heldId = held[0].id;

      // Item 2: No track match from title, has non-matching attachment
      const res2 = await processAndSaveTender({
        title: 'Tender Notice No 102',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/102',
        attachmentUrls: [noMatchDocUrl]
      }, portal(), tracks);
      expect(res2.awaitingScope).toBe(true);

      // Run document queue worker
      await processDocumentQueue(5);

      // Item 1 should have been released to ready and assigned IT & Software track
      const released = getTenderById(heldId);
      expect(released).not.toBeNull();
      expect(released?.ingestion_status).toBe('ready');
      expect(released?.domain_tracks).toContain('IT & Software');

      // Item 2 should have been purged and suppressed with reason = 'no-track-match' (MATCH-3)
      const held2 = db.prepare(`SELECT * FROM tenders WHERE title = 'Tender Notice No 102'`).get();
      expect(held2).toBeUndefined();
      const deletedRecord = db.prepare(`SELECT reason FROM deleted_tenders WHERE reason = 'no-track-match'`).all() as any[];
      expect(deletedRecord.length).toBeGreaterThan(0);
    });

    it('DOC-9 / B8: timed-out download on old folder does not suppress', async () => {
      // CMS upload folder from 6 months ago in 2026 (older than 90 days, but current calendar year)
      const url = 'https://x.pk/wp-content/uploads/2026/05/rfp.pdf';
      serveDocuments({ [url]: new Error('ETIMEDOUT: Connection timed out') });

      const res = await processAndSaveTender({
        title: 'Procurement of High-End Workstations and Servers',
        organization: 'PSEB',
        directUrl: url
      }, portal(), tracks);

      // Because download timed out, nothing is known about content, so it should NOT be suppressed
      expect(res.isNew).toBe(true);
      const tender = getAllTenders().find(t => t.direct_url === url);
      expect(tender).toBeDefined();
      expect(tender?.doc_fetch_status).toBe('pending');
      expect(getJobsForTender(tender!.id).length).toBe(1);
      const suppressed = db.prepare('SELECT 1 FROM deleted_tenders WHERE id = ?').get(tender?.id);
      expect(suppressed).toBeUndefined();
    });

    it('finalizes awaiting_scope tender when a remaining job fails permanently (queues 3rd PDF first, else deletes as no-track-match)', async () => {
      db.prepare(`DELETE FROM domain_tracks`).run();
      db.prepare(`
        INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active)
        VALUES ('track-it', 'IT & Software', '["servers", "laptops"]', '[]', 1)
      `).run();

      const nonMatchPdf = 'https://x.pk/uploads/2026/11/Notice-Unrelated.pdf';
      const failingPdf = 'https://x.pk/uploads/2026/11/Corrupted-Doc.pdf';
      const thirdMatchPdf = 'https://x.pk/uploads/2026/11/Third-Annex.pdf';

      serveDocuments({
        [nonMatchPdf]: noticePdf(10, ['Scope of Work: Agricultural cattle fodder']),
        [failingPdf]: new Error('HTTP 500'),
        [thirdMatchPdf]: noticePdf(10, ['Scope of Work: Supply of rack servers'])
      });

      // 1. With a 3rd unqueued downloadable PDF: failing the 2nd job enqueues the 3rd PDF
      const resWith3 = await processAndSaveTender({
        title: 'Tender Notice No 303',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/303',
        attachmentUrls: [nonMatchPdf, failingPdf, thirdMatchPdf]
      }, portal(), tracks);
      expect(resWith3.awaitingScope).toBe(true);
      const idWith3 = (db.prepare(`SELECT id FROM tenders WHERE title = 'Tender Notice No 303'`).get() as any).id;
      db.prepare(`UPDATE document_ingest_jobs SET max_attempts = 1 WHERE tender_id = ? AND url = ?`).run(idWith3, failingPdf);

      await processDocumentQueue(5);
      // After nonMatchPdf succeeded and failingPdf permanently failed, thirdMatchPdf was queued
      const jobsAfterFail = getJobsForTender(idWith3);
      expect(jobsAfterFail.some(j => j.url === thirdMatchPdf && j.status === 'pending')).toBe(true);
      // Next worker run reads thirdMatchPdf and releases tender
      await processDocumentQueue(5);
      expect(getTenderById(idWith3)?.ingestion_status).toBe('ready');

      // 2. With only 2 attachments (1 non-matching PDF + 1 permanently failing PDF): tender is deleted as no-track-match
      const resWith2 = await processAndSaveTender({
        title: 'Tender Notice No 304',
        organization: 'PSEB',
        directUrl: 'https://x.pk/tenders/304',
        attachmentUrls: [nonMatchPdf, failingPdf]
      }, portal(), tracks);
      expect(resWith2.awaitingScope).toBe(true);
      const idWith2 = (db.prepare(`SELECT id FROM tenders WHERE title = 'Tender Notice No 304'`).get() as any).id;
      db.prepare(`UPDATE document_ingest_jobs SET max_attempts = 1 WHERE tender_id = ? AND url = ?`).run(idWith2, failingPdf);

      await processDocumentQueue(5);
      expect(getTenderById(idWith2)).toBeNull();
      const supRow = db.prepare(`SELECT reason FROM deleted_tenders WHERE id = ?`).get(idWith2) as { reason: string } | undefined;
      expect(supRow?.reason).toBe('no-track-match');
    });

    it('holds processDocumentQueue when degraded/offline, refunds attempts on transient errors, and defers upfront PDFs on degraded scans', async () => {
      // 1. Degraded network pauses background queue without claiming jobs or burning attempts
      networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 2100 });
      await processAndSaveTender({
        title: 'Solar Microgrid Equipment Procurement',
        organization: 'Energy Dept',
        closingDate: new Date(Date.now() + 7 * DAY).toISOString(),
        directUrl: 'https://x.pk/tenders/solar-1',
        attachmentUrls: ['https://x.pk/uploads/solar-rfp.pdf']
      }, portal(), tracks);

      const pausedReport = await processDocumentQueue(5);
      expect(pausedReport.skipped).toBe('network_unhealthy');
      expect(pausedReport.claimed).toBe(0);

      // 2. Undated tender on degraded network skips blocking upfront download and queues with pending status
      const undatedRes = await processAndSaveTender({
        title: 'Solar Batteries Supply Framework',
        organization: 'Energy Dept',
        directUrl: 'https://x.pk/uploads/solar-batteries.pdf'
      }, portal(), tracks);
      expect(undatedRes.isNew).toBe(true);
      const deferredTender = getAllTenders().find(t => t.direct_url === 'https://x.pk/uploads/solar-batteries.pdf');
      expect(deferredTender?.doc_fetch_status).toBe('pending');
      expect(getJobsForTender(deferredTender!.id)).toHaveLength(1);

      // 3. When online again, transient download error calls deferJob (attempts refunded to 0), whereas HTTP 404 calls failJob
      networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 40 });
      await checkNetworkHealth({ force: true });
      const transientUrl = 'https://x.pk/uploads/solar-rfp.pdf';
      crawlerDeps.downloadAndCacheDossier = vi.fn().mockImplementation(async (_tid: string, url: string, _lbl?: string, opts?: any) => {
        if (url === transientUrl) {
          opts?.onError?.(new Error('connect ETIMEDOUT 1.2.3.4:443'), { isTransientNetwork: true });
          return null;
        }
        opts?.onError?.(new Error('HTTP 404 loading file'), { isTransientNetwork: false });
        return null;
      });

      const workerReport = await processDocumentQueue(5);
      expect(workerReport.deferred).toBe(1);
      expect(workerReport.failed).toBe(1);

      const transientTender = getAllTenders().find(t => t.direct_url === 'https://x.pk/tenders/solar-1')!;
      const transientJob = getJobsForTender(transientTender.id)[0];
      const deadJob = getJobsForTender(deferredTender!.id)[0];
      expect(transientJob.attempts).toBe(0);
      expect(transientJob.status).toBe('pending');
      expect(deadJob.attempts).toBe(1);
    });
  });
});
