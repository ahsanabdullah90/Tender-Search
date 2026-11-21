import crypto from 'crypto';
import { db, safeJsonParse } from '../connection.js';

/**
 * Durable document-ingest queue (docs/13-ingestion-pipeline-plan.md, Phase 1.2).
 * Rows live in `document_ingest_jobs` and are removed automatically (ON DELETE CASCADE) when
 * their tender is deleted. Every status change goes through this repository.
 */

export type IngestJobStatus = 'pending' | 'processing' | 'done' | 'failed';
export type DocFetchStatus = 'none' | 'pending' | 'partial' | 'complete' | 'failed';

export interface IngestJob {
  id: string;
  tender_id: string;
  url: string;
  label: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  status: IngestJobStatus;
  lease_until: string | null;
  last_error: string | null;
  next_retry_at: string;
  created_at: string;
}

export interface EnqueueJobInput {
  url: string;
  label?: string | null;
  /** Lower runs first. Defaults to documentJobPriority(label || url). */
  priority?: number;
  maxAttempts?: number;
}

export const JOB_PRIORITY = { corrigendum: 10, primary: 20, other: 50 } as const;
export const DETAIL_DISCOVER_LABEL = '__detail_discover__';

/** Retry delays after the 1st, 2nd, 3rd... failed attempt (minutes). The last value repeats. */
export const JOB_BACKOFF_MINUTES = [2, 10, 30];

/**
 * Dedicated tender detail pages whose listing row omits downloadable PDF/attachment links,
 * so the background worker must inspect the detail page HTML once to discover them.
 * Generic listing URLs and unrelated sites are excluded so tests and non-document links stay untouched.
 */
export function isDetailPageDiscoveryUrl(url?: string | null, portalId?: string | null): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (isDirectDocLink(url)) return false;
  if (/epms\.ppra\.gov\.pk\/public\/tenders\/tender-details\//i.test(url)) return true;
  if (portalId === 'epms_ppra' && /\/tender-details\//i.test(url)) return true;
  if (/fde\.gov\.pk\/download\/[^/?#]+/i.test(url) && !/\/download-category\//i.test(url) && !/[?&]wpdmdl=\d+/i.test(url)) {
    return true;
  }
  return false;
}

/**
 * Corrigenda/addenda/extensions first (they can change the deadline), then the main bidding
 * documents, then everything else (BOQs, drawings, annexures).
 */
export function documentJobPriority(labelOrUrl: string): number {
  const text = decodeURIComponentSafe(labelOrUrl).toLowerCase();
  if (/corrigend|addend|amendment|extension|errat/.test(text)) return JOB_PRIORITY.corrigendum;
  if (/\brfp\b|\brfq\b|\bnit\b|\beoi\b|bidding|tender[\s_-]*(notice|document)|notice|\bifb\b/.test(text)) return JOB_PRIORITY.primary;
  return JOB_PRIORITY.other;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Queues documents for a tender. Idempotent: a (tender_id, url) pair already queued, in any
 * state, is left untouched. The tender must already exist (foreign key). Returns how many new
 * jobs were created.
 */
export function enqueueDocumentJobs(tenderId: string, jobs: EnqueueJobInput[]): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO document_ingest_jobs (id, tender_id, url, label, priority, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let created = 0;
  const tx = db.transaction(() => {
    for (const job of jobs) {
      if (!job.url) continue;
      const priority =
        job.priority ??
        (job.label === DETAIL_DISCOVER_LABEL
          ? JOB_PRIORITY.primary
          : documentJobPriority(`${job.label || ''} ${job.url}`));
      const res = insert.run(
        `job-${crypto.randomUUID()}`,
        tenderId,
        job.url,
        job.label ?? null,
        priority,
        job.maxAttempts ?? 3
      );
      created += res.changes;
    }
  });
  tx();
  return created;
}

/**
 * Atomically claims up to `limit` due jobs: marks them 'processing', sets a lease, and counts the
 * attempt at claim time (so a crash mid-job still uses up an attempt and a poison document
 * cannot loop forever). Prioritizes tracked/bookmarked ready tenders first, then open Inbox
 * ('ready') tenders by soonest closing deadline, then hidden 'awaiting_scope' listings.
 */
export function claimDueJobs(limit: number = 5, leaseMinutes: number = 10): IngestJob[] {
  const select = db.prepare(`
    SELECT j.id FROM document_ingest_jobs j
    LEFT JOIN tenders t ON t.id = j.tender_id
    WHERE j.status = 'pending' AND julianday(j.next_retry_at) <= julianday('now')
    ORDER BY
      CASE
        WHEN t.ingestion_status = 'ready' AND (t.is_bookmarked = 1 OR t.pipeline_status NOT IN ('New Opportunity', 'Passed')) THEN 0
        WHEN t.ingestion_status = 'ready' THEN 1
        ELSE 2
      END ASC,
      CASE
        WHEN t.ingestion_status = 'ready' AND t.closing_date IS NOT NULL AND julianday(t.closing_date) >= julianday('now')
          THEN julianday(t.closing_date)
        ELSE 99999999
      END ASC,
      j.priority ASC,
      j.created_at ASC
    LIMIT ?
  `);
  const claim = db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        lease_until = datetime('now', '+' || ? || ' minutes')
    WHERE id = ? AND status = 'pending'
  `);
  const fetchRow = db.prepare('SELECT * FROM document_ingest_jobs WHERE id = ?');

  const tx = db.transaction((): IngestJob[] => {
    const claimed: IngestJob[] = [];
    for (const { id } of select.all(limit) as { id: string }[]) {
      if (claim.run(leaseMinutes, id).changes > 0) {
        claimed.push(fetchRow.get(id) as IngestJob);
      }
    }
    return claimed;
  });
  return tx();
}

export function completeJob(jobId: string): boolean {
  return db.prepare(`
    UPDATE document_ingest_jobs SET status = 'done', lease_until = NULL, last_error = NULL WHERE id = ?
  `).run(jobId).changes > 0;
}

/**
 * Records a failed attempt. Retries with exponential backoff (2 → 10 → 30 minutes) until
 * max_attempts is reached, then marks the job 'failed'. Returns the job's new status.
 */
export function failJob(jobId: string, error: string): IngestJobStatus | null {
  const job = db.prepare('SELECT attempts, max_attempts FROM document_ingest_jobs WHERE id = ?').get(jobId) as
    | { attempts: number; max_attempts: number }
    | undefined;
  if (!job) return null;

  const message = String(error || 'Unknown error').slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    db.prepare(`
      UPDATE document_ingest_jobs SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?
    `).run(message, jobId);
    return 'failed';
  }

  const delay = JOB_BACKOFF_MINUTES[Math.min(Math.max(job.attempts - 1, 0), JOB_BACKOFF_MINUTES.length - 1)];
  db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'pending', lease_until = NULL, last_error = ?,
        next_retry_at = datetime('now', '+' || ? || ' minutes')
    WHERE id = ?
  `).run(message, delay, jobId);
  return 'pending';
}

/**
 * Returns 'processing' jobs whose lease has expired (worker crashed or was killed) to the queue,
 * or marks them 'failed' if they have used all their attempts. Returns how many were released.
 */
export function releaseExpiredLeases(): number {
  const tx = db.transaction(() => {
    const exhausted = db.prepare(`
      UPDATE document_ingest_jobs
      SET status = 'failed', lease_until = NULL,
          last_error = COALESCE(last_error, 'Lease expired (worker interrupted)')
      WHERE status = 'processing' AND julianday(lease_until) < julianday('now') AND attempts >= max_attempts
    `).run().changes;
    const requeued = db.prepare(`
      UPDATE document_ingest_jobs
      SET status = 'pending', lease_until = NULL, next_retry_at = CURRENT_TIMESTAMP
      WHERE status = 'processing' AND julianday(lease_until) < julianday('now')
    `).run().changes;
    return exhausted + requeued;
  });
  return tx();
}

/**
 * Puts a claimed job back in the queue without using up an attempt, e.g. when the daily Gemini
 * Vision budget is spent and a scanned document must wait.
 */
export function deferJob(jobId: string, minutes: number, reason: string): boolean {
  return db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'pending', lease_until = NULL, last_error = ?,
        attempts = MAX(attempts - 1, 0),
        next_retry_at = datetime('now', '+' || ? || ' minutes')
    WHERE id = ?
  `).run(reason, minutes, jobId).changes > 0;
}

/** Puts a tender's failed jobs back in the queue with fresh attempts (operator "Retry" action). */
export function requeueFailedJobs(tenderId: string): number {
  const requeued = db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'pending', attempts = 0, lease_until = NULL, next_retry_at = CURRENT_TIMESTAMP
    WHERE tender_id = ? AND status = 'failed'
  `).run(tenderId).changes;

  // Also enqueue any stored attachment_urls or direct-document direct_url not yet in the queue.
  let newlyQueued = 0;
  try {
    const row = db.prepare('SELECT direct_url, attachment_urls FROM tenders WHERE id = ?').get(tenderId) as
      | { direct_url: string | null; attachment_urls?: string | null }
      | undefined;
    if (row) {
      const urls = collectRowDocumentUrls(row.direct_url, row.attachment_urls);
      if (urls.length > 0) {
        newlyQueued = enqueueDocumentJobs(tenderId, urls.map(url => ({ url })));
      }
    }
  } catch {}
  return requeued + newlyQueued;
}

function isDirectDocLink(url?: string | null): boolean {
  return Boolean(url && (/\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(url) || /[?&]wpdmdl=\d+/i.test(url)));
}

function isDownloadableCandidateLink(url?: string | null): boolean {
  return Boolean(url && (!/\.(html?|aspx?|php|jsp)(\?|$)/i.test(url) || /[?&]wpdmdl=\d+/i.test(url) || /\/pdf\?file=/i.test(url)));
}

function collectRowDocumentUrls(directUrl?: string | null, attachmentUrlsRaw?: string | null): string[] {
  const urls: string[] = [];
  if (isDirectDocLink(directUrl)) urls.push(directUrl!);
  for (const u of safeJsonParse<string[]>(attachmentUrlsRaw || '[]', [])) {
    if (u && isDownloadableCandidateLink(u) && !urls.includes(u)) urls.push(u);
  }
  return urls.slice(0, 5);
}

/**
 * One-time / idempotent backfill (docs/14 P1-1): queues document jobs for existing New Opportunity
 * tenders that have a direct document URL, stored attachment_urls, or a supported dedicated detail
 * page URL, no cached dossiers yet, and doc_fetch_status = 'none'. Returns how many tenders had jobs queued.
 */
export function backfillExistingTenderDocumentJobs(): number {
  const rows = db.prepare(`
    SELECT id, portal_id, direct_url, attachment_urls FROM tenders
    WHERE pipeline_status = 'New Opportunity'
      AND COALESCE(doc_fetch_status, 'none') = 'none'
      AND (cached_dossiers IS NULL OR cached_dossiers = '[]')
  `).all() as { id: string; portal_id: string; direct_url: string | null; attachment_urls?: string | null }[];

  let tendersQueued = 0;
  for (const row of rows) {
    const urls = collectRowDocumentUrls(row.direct_url, row.attachment_urls);
    const jobsToQueue: EnqueueJobInput[] = urls.length > 0
      ? urls.map(url => ({ url }))
      : isDetailPageDiscoveryUrl(row.direct_url, row.portal_id)
        ? [{ url: row.direct_url!, label: DETAIL_DISCOVER_LABEL, priority: JOB_PRIORITY.primary }]
        : [];
    if (jobsToQueue.length === 0) continue;
    const added = enqueueDocumentJobs(row.id, jobsToQueue);
    if (added > 0) {
      refreshTenderDocFetchStatus(row.id);
      tendersQueued++;
    }
  }
  return tendersQueued;
}

/**
 * Marks queued/in-flight document jobs matching `urls` (and optionally the dedicated detail-page
 * discovery job) as 'done' for a tender. Used when an on-demand fetch already downloaded them.
 */
export function markDocumentJobsDoneForUrls(
  tenderId: string,
  urls: string[],
  options?: { includeDetailDiscover?: boolean }
): number {
  const cleanUrls = Array.from(new Set(urls.filter(Boolean)));
  let updated = 0;
  const markUrl = db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'done', lease_until = NULL, last_error = NULL
    WHERE tender_id = ? AND url = ? AND status != 'done'
  `);
  const markDiscover = db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'done', lease_until = NULL, last_error = NULL
    WHERE tender_id = ? AND label = ? AND status != 'done'
  `);
  const tx = db.transaction(() => {
    for (const url of cleanUrls) {
      updated += markUrl.run(tenderId, url).changes;
    }
    if (options?.includeDetailDiscover) {
      updated += markDiscover.run(tenderId, DETAIL_DISCOVER_LABEL).changes;
    }
  });
  tx();
  return updated;
}

/**
 * Marks stale pending jobs as 'done' when their URL is already saved in `cached_dossiers`
 * (or detail-page discovery when cached_dossiers is already populated), and refreshes
 * `doc_fetch_status` for every affected tender. Returns how many jobs were pruned.
 */
export function pruneAlreadyCachedPendingJobs(): number {
  const rows = db.prepare(`
    SELECT j.id AS job_id, j.tender_id, j.url, j.label, t.cached_dossiers
    FROM document_ingest_jobs j
    JOIN tenders t ON t.id = j.tender_id
    WHERE j.status = 'pending'
      AND COALESCE(j.last_error, '') NOT LIKE '%Vision%'
      AND t.cached_dossiers IS NOT NULL
      AND t.cached_dossiers != '[]'
  `).all() as { job_id: string; tender_id: string; url: string; label: string | null; cached_dossiers: string }[];

  const markDone = db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'done', lease_until = NULL, last_error = NULL
    WHERE id = ? AND status = 'pending'
  `);

  const affectedTenders = new Set<string>();
  let pruned = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const dossiers = safeJsonParse<{ originalUrl?: string }[]>(row.cached_dossiers, []);
      if (dossiers.length === 0) continue;
      const alreadyCached =
        row.label === DETAIL_DISCOVER_LABEL ||
        dossiers.some(d => Boolean(d.originalUrl) && d.originalUrl === row.url);
      if (!alreadyCached) continue;
      const changed = markDone.run(row.job_id).changes;
      if (changed > 0) {
        pruned += changed;
        affectedTenders.add(row.tender_id);
      }
    }
  });
  tx();

  for (const tenderId of affectedTenders) {
    const nextStatus = refreshTenderDocFetchStatus(tenderId);
    if (nextStatus === 'none') {
      db.prepare(`UPDATE tenders SET doc_fetch_status = 'complete' WHERE id = ?`).run(tenderId);
    }
  }
  return pruned;
}

export interface DocumentQueueCounts {
  readyPending: number;
  readyTenders: number;
  awaitingScopePending: number;
  awaitingScopeTenders: number;
  totalPending: number;
  processing: number;
  processingTenders: number;
  activeTenderIds: string[];
}

export function getDocumentQueueCounts(): DocumentQueueCounts {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN j.status = 'pending' AND t.ingestion_status = 'ready' THEN 1 ELSE 0 END) AS readyPending,
      COUNT(DISTINCT CASE WHEN j.status = 'pending' AND t.ingestion_status = 'ready' THEN j.tender_id END) AS readyTenders,
      SUM(CASE WHEN j.status = 'pending' AND t.ingestion_status = 'awaiting_scope' THEN 1 ELSE 0 END) AS awaitingScopePending,
      COUNT(DISTINCT CASE WHEN j.status = 'pending' AND t.ingestion_status = 'awaiting_scope' THEN j.tender_id END) AS awaitingScopeTenders,
      SUM(CASE WHEN j.status = 'pending' THEN 1 ELSE 0 END) AS totalPending,
      SUM(CASE WHEN j.status = 'processing' THEN 1 ELSE 0 END) AS processing,
      COUNT(DISTINCT CASE WHEN j.status = 'processing' THEN j.tender_id END) AS processingTenders
    FROM document_ingest_jobs j
    LEFT JOIN tenders t ON t.id = j.tender_id
    WHERE j.status IN ('pending', 'processing')
  `).get() as {
    readyPending: number | null;
    readyTenders: number | null;
    awaitingScopePending: number | null;
    awaitingScopeTenders: number | null;
    totalPending: number | null;
    processing: number | null;
    processingTenders: number | null;
  } | undefined;

  const activeRows = db.prepare(`
    SELECT DISTINCT tender_id FROM document_ingest_jobs WHERE status = 'processing'
  `).all() as { tender_id: string }[];

  return {
    readyPending: row?.readyPending || 0,
    readyTenders: row?.readyTenders || 0,
    awaitingScopePending: row?.awaitingScopePending || 0,
    awaitingScopeTenders: row?.awaitingScopeTenders || 0,
    totalPending: row?.totalPending || 0,
    processing: row?.processing || 0,
    processingTenders: row?.processingTenders || 0,
    activeTenderIds: activeRows.map(r => r.tender_id)
  };
}

/**
 * Repairs tenders whose stored `doc_fetch_status` ('pending' or 'none') has drifted from
 * `document_ingest_jobs` and `cached_dossiers` (e.g. a tender left at 'pending' with 0 jobs, or
 * at 'none' despite already having cached dossiers). Returns how many rows were reconciled.
 */
export function reconcileStaleTenderDocFetchStatuses(): number {
  const candidates = db.prepare(`
    SELECT id, COALESCE(doc_fetch_status, 'none') AS doc_fetch_status, cached_dossiers
    FROM tenders
    WHERE COALESCE(doc_fetch_status, 'none') IN ('pending', 'none')
  `).all() as { id: string; doc_fetch_status: string; cached_dossiers: string }[];

  const setStatus = db.prepare(`UPDATE tenders SET doc_fetch_status = ? WHERE id = ?`);
  let reconciled = 0;

  const tx = db.transaction(() => {
    for (const row of candidates) {
      const summary = getJobSummaryForTender(row.id);
      const dossiers = safeJsonParse<unknown[]>(row.cached_dossiers, []);
      let expected: DocFetchStatus;
      if (summary.total === 0) {
        expected = dossiers.length > 0 ? 'complete' : 'none';
      } else {
        const derived = deriveDocFetchStatus(summary);
        expected = derived === 'none' && dossiers.length > 0 ? 'complete' : derived;
      }
      if (expected !== row.doc_fetch_status) {
        reconciled += setStatus.run(expected, row.id).changes;
      }
    }
  });
  tx();
  return reconciled;
}

export interface JobSummary {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
}

export function getJobSummaryForTender(tenderId: string): JobSummary {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM document_ingest_jobs WHERE tender_id = ? GROUP BY status
  `).all(tenderId) as { status: IngestJobStatus; n: number }[];
  const summary: JobSummary = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const r of rows) {
    if (r.status in summary) (summary as any)[r.status] = r.n;
    summary.total += r.n;
  }
  return summary;
}

export function countPendingDocumentJobs(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM document_ingest_jobs WHERE status = 'pending'`).get() as
    | { n: number }
    | undefined;
  return row?.n || 0;
}

export function getJobsForTender(tenderId: string): IngestJob[] {
  return db.prepare(`
    SELECT * FROM document_ingest_jobs WHERE tender_id = ? ORDER BY priority ASC, created_at ASC
  `).all(tenderId) as IngestJob[];
}

/**
 * Derives a tender's doc_fetch_status from its jobs: any job still queued/running → 'pending';
 * otherwise all done → 'complete', all failed → 'failed', a mix → 'partial', no jobs → 'none'.
 */
export function deriveDocFetchStatus(summary: JobSummary): DocFetchStatus {
  if (summary.total === 0) return 'none';
  if (summary.pending + summary.processing > 0) return 'pending';
  if (summary.failed === 0) return 'complete';
  if (summary.done === 0) return 'failed';
  return 'partial';
}

/** Recomputes and stores a tender's doc_fetch_status from its jobs. Returns the new status. */
export function refreshTenderDocFetchStatus(tenderId: string): DocFetchStatus {
  const status = deriveDocFetchStatus(getJobSummaryForTender(tenderId));
  db.prepare('UPDATE tenders SET doc_fetch_status = ? WHERE id = ?').run(status, tenderId);
  return status;
}
