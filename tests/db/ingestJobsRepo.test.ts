import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  initDatabase,
  createManualTender,
  deleteTenders,
  getAllTenders,
  getTenderById,
  getPortalTenderSummary,
  getExpiredUnreviewedTenderIds,
  getKpiStats,
  setTenderIngestionStatus,
  releaseStaleStagingTenders,
  enqueueDocumentJobs,
  claimDueJobs,
  completeJob,
  failJob,
  releaseExpiredLeases,
  requeueFailedJobs,
  getJobSummaryForTender,
  getJobsForTender,
  deriveDocFetchStatus,
  refreshTenderDocFetchStatus,
  documentJobPriority,
  JOB_PRIORITY
} from '../../src/server/db/index.js';
import { findCanonicalMatch } from '../../src/server/services/deduplicator.js';

const minutesFromNow = (iso: string) => (new Date(iso.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 60000;

describe('Phase 1: ingestion schema, document job queue and staging visibility', () => {
  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM document_ingest_jobs').run();
    db.prepare('DELETE FROM corrigendum_logs').run();
    db.prepare('DELETE FROM pipeline_audit_logs').run();
    db.prepare('DELETE FROM tenders').run();
  });

  const newTender = (title = 'Supply of Rack Servers') =>
    createManualTender({ title, organization: 'PSEB', closing_date: new Date(Date.now() + 10 * 86400000).toISOString() });

  describe('1.1 schema migration', () => {
    it('is idempotent and adds the provenance columns and job table', () => {
      expect(() => { initDatabase(); initDatabase(); }).not.toThrow();
      const cols = (db.prepare('PRAGMA table_info(tenders)').all() as { name: string; dflt_value: string | null }[]);
      const byName = Object.fromEntries(cols.map(c => [c.name, c]));
      for (const c of ['ingestion_status', 'deadline_source', 'deadline_confidence', 'doc_fetch_status', 'needs_review', 'review_reason']) {
        expect(byName[c], c).toBeDefined();
      }
      expect(byName.ingestion_status.dflt_value).toBe("'ready'");
      expect(byName.doc_fetch_status.dflt_value).toBe("'none'");

      const jobCols = (db.prepare('PRAGMA table_info(document_ingest_jobs)').all() as { name: string }[]).map(c => c.name);
      expect(jobCols).toEqual(expect.arrayContaining(['tender_id', 'url', 'priority', 'attempts', 'status', 'lease_until', 'next_retry_at']));
    });

    it('new tenders default to ready / none / not flagged', () => {
      const t = getTenderById(newTender().id)!;
      expect(t.ingestion_status).toBe('ready');
      expect(t.doc_fetch_status).toBe('none');
      expect(t.needs_review).toBe(0);
    });
  });

  describe('1.2 ingestJobsRepo', () => {
    it('assigns priority: corrigendum, then primary documents, then other files', () => {
      expect(documentJobPriority('https://x.gov.pk/uploads/Corrigendum-No-2.pdf')).toBe(JOB_PRIORITY.corrigendum);
      expect(documentJobPriority('Addendum%201.pdf')).toBe(JOB_PRIORITY.corrigendum);
      expect(documentJobPriority('https://x.gov.pk/RFP-Cloud.pdf')).toBe(JOB_PRIORITY.primary);
      expect(documentJobPriority('Tender Notice')).toBe(JOB_PRIORITY.primary);
      expect(documentJobPriority('https://x.gov.pk/BOQ-annex.xlsx')).toBe(JOB_PRIORITY.other);
    });

    it('enqueue is idempotent per (tender, url) and requires an existing tender', () => {
      const t = newTender();
      expect(enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }, { url: 'https://x/b.pdf' }])).toBe(2);
      expect(enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }, { url: '' }])).toBe(0);
      expect(getJobsForTender(t.id)).toHaveLength(2);
      expect(() => enqueueDocumentJobs('no-such-tender', [{ url: 'https://x/c.pdf' }])).toThrow();
    });

    it('claims due jobs by priority, counts the attempt, and never hands out the same job twice', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [
        { url: 'https://x/boq.xlsx' },
        { url: 'https://x/RFP.pdf' },
        { url: 'https://x/corrigendum.pdf' }
      ]);

      const first = claimDueJobs(2, 10);
      expect(first.map(j => j.url)).toEqual(['https://x/corrigendum.pdf', 'https://x/RFP.pdf']);
      expect(first.every(j => j.status === 'processing' && j.attempts === 1)).toBe(true);
      expect(minutesFromNow(first[0].lease_until!)).toBeGreaterThan(9);

      const second = claimDueJobs(5, 10);
      expect(second.map(j => j.url)).toEqual(['https://x/boq.xlsx']);
      expect(claimDueJobs(5, 10)).toHaveLength(0);
    });

    it('does not claim jobs whose retry time is in the future', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }]);
      db.prepare(`UPDATE document_ingest_jobs SET next_retry_at = datetime('now', '+5 minutes')`).run();
      expect(claimDueJobs(5)).toHaveLength(0);
    });

    it('backs off 2 → 10 minutes between failures and marks the job failed after max attempts', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }]);
      const [job] = claimDueJobs(1);

      expect(failJob(job.id, 'ETIMEDOUT')).toBe('pending');
      let row = getJobsForTender(t.id)[0];
      expect(row.last_error).toBe('ETIMEDOUT');
      expect(minutesFromNow(row.next_retry_at)).toBeGreaterThan(1.5);
      expect(minutesFromNow(row.next_retry_at)).toBeLessThan(2.5);

      db.prepare(`UPDATE document_ingest_jobs SET next_retry_at = datetime('now', '-1 minute')`).run();
      claimDueJobs(1);
      expect(failJob(job.id, 'ECONNRESET')).toBe('pending');
      row = getJobsForTender(t.id)[0];
      expect(minutesFromNow(row.next_retry_at)).toBeGreaterThan(9);

      db.prepare(`UPDATE document_ingest_jobs SET next_retry_at = datetime('now', '-1 minute')`).run();
      claimDueJobs(1);
      expect(failJob(job.id, '404')).toBe('failed');
      expect(getJobsForTender(t.id)[0].status).toBe('failed');
      expect(failJob('job-missing', 'x')).toBeNull();
    });

    it('returns expired leases to the queue, or fails them when out of attempts', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }, { url: 'https://x/b.pdf', maxAttempts: 1 }]);
      claimDueJobs(5);
      db.prepare(`UPDATE document_ingest_jobs SET lease_until = datetime('now', '-1 minute')`).run();

      expect(releaseExpiredLeases()).toBe(2);
      const byUrl = Object.fromEntries(getJobsForTender(t.id).map(j => [j.url, j]));
      expect(byUrl['https://x/a.pdf'].status).toBe('pending');
      expect(byUrl['https://x/b.pdf'].status).toBe('failed');
      expect(byUrl['https://x/b.pdf'].last_error).toContain('Lease expired');
      // An active lease is left alone
      claimDueJobs(5);
      expect(releaseExpiredLeases()).toBe(0);
    });

    it('requeues failed jobs with fresh attempts for an operator retry', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf', maxAttempts: 1 }]);
      const [job] = claimDueJobs(1);
      failJob(job.id, '500');
      expect(requeueFailedJobs(t.id)).toBe(1);
      const row = getJobsForTender(t.id)[0];
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(claimDueJobs(1)).toHaveLength(1);
    });

    it('derives doc_fetch_status from job states', () => {
      const t = newTender();
      expect(refreshTenderDocFetchStatus(t.id)).toBe('none');
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf', maxAttempts: 1 }, { url: 'https://x/b.pdf', maxAttempts: 1 }]);
      expect(refreshTenderDocFetchStatus(t.id)).toBe('pending');

      const [a, b] = claimDueJobs(2);
      completeJob(a.id);
      failJob(b.id, 'timeout');
      expect(getJobSummaryForTender(t.id)).toEqual({ pending: 0, processing: 0, done: 1, failed: 1, total: 2 });
      expect(refreshTenderDocFetchStatus(t.id)).toBe('partial');
      expect(getTenderById(t.id)!.doc_fetch_status).toBe('partial');

      expect(deriveDocFetchStatus({ pending: 0, processing: 0, done: 2, failed: 0, total: 2 })).toBe('complete');
      expect(deriveDocFetchStatus({ pending: 0, processing: 0, done: 0, failed: 2, total: 2 })).toBe('failed');
      expect(deriveDocFetchStatus({ pending: 0, processing: 1, done: 1, failed: 0, total: 2 })).toBe('pending');
    });

    it('deletes a tender\'s jobs with the tender (ON DELETE CASCADE)', () => {
      const t = newTender();
      enqueueDocumentJobs(t.id, [{ url: 'https://x/a.pdf' }]);
      deleteTenders([t.id], 'user');
      expect((db.prepare('SELECT COUNT(*) c FROM document_ingest_jobs').get() as any).c).toBe(0);
    });
  });

  describe('1.3 staging rows are hidden from every read path but visible to dedup', () => {
    it('excludes staging tenders from listing, portal summary, KPIs and retention', () => {
      const visible = newTender('Visible Cloud Servers');
      const staged = newTender('Staged Cloud Servers');
      setTenderIngestionStatus(staged.id, 'staging');
      // Make both eligible for the expired-unreviewed sweep
      db.prepare(`UPDATE tenders SET closing_date = datetime('now', '-10 days'), portal_id = 'pseb'`).run();

      const ids = getAllTenders().map(t => t.id);
      expect(ids).toContain(visible.id);
      expect(ids).not.toContain(staged.id);
      expect(getAllTenders({ status: 'New Opportunity' }).map(t => t.id)).not.toContain(staged.id);

      db.prepare(`UPDATE tenders SET closing_date = datetime('now', '+10 days')`).run();
      expect(getPortalTenderSummary().reduce((n, r) => n + r.total_count, 0)).toBe(1);
      expect(getKpiStats().totalTracked).toBe(1);

      db.prepare(`UPDATE tenders SET closing_date = datetime('now', '-10 days')`).run();
      const expired = getExpiredUnreviewedTenderIds(2, 100);
      expect(expired).toContain(visible.id);
      expect(expired).not.toContain(staged.id);

      // Direct lookup still works (detail view, background worker)
      expect(getTenderById(staged.id)).not.toBeNull();
    });

    it('lets duplicate detection see a staging tender so a parallel scan cannot insert it twice', () => {
      const staged = createManualTender({ title: 'Supply of Laptops', organization: 'FDE', reference_no: 'FDE-IT-2026-77' });
      setTenderIngestionStatus(staged.id, 'staging');
      const match = findCanonicalMatch({ referenceNo: 'FDE-IT-2026-77', title: 'Supply of Laptops', organization: 'FDE' });
      expect(match.isDuplicate).toBe(true);
      expect(match.matchedTenderId).toBe(staged.id);
    });

    it('releases tenders stuck in staging after a crash', () => {
      const fresh = newTender('Fresh staging');
      const stuck = newTender('Stuck staging');
      setTenderIngestionStatus(fresh.id, 'staging');
      setTenderIngestionStatus(stuck.id, 'staging');
      db.prepare(`UPDATE tenders SET updated_at = datetime('now', '-2 hours') WHERE id = ?`).run(stuck.id);

      expect(releaseStaleStagingTenders(60)).toBe(1);
      expect(getTenderById(stuck.id)!.ingestion_status).toBe('ready');
      expect(getTenderById(fresh.id)!.ingestion_status).toBe('staging');
    });
  });
});
