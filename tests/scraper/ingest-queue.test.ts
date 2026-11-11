import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import * as ocrSvc from '../../src/server/ocrService.js';
import {
  db,
  initDatabase,
  DOSSIERS_DIR,
  getAllTenders,
  getTenderById,
  getJobsForTender,
  getExpiredUnreviewedTenderIds,
  setAppSetting
} from '../../src/server/db.js';
import { processAndSaveTender, crawlerDeps, currentScanStatus, orderDocumentCandidates } from '../../src/server/scrapers/crawlerEngine.js';
import { processDocumentQueue } from '../../src/server/ingestWorker.js';
import { beginScanBudget, endScanBudget } from '../../src/server/ingestBudget.js';
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
  });
});
