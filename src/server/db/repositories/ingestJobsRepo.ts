import crypto from 'crypto';
import { db } from '../connection.js';

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

/** Retry delays after the 1st, 2nd, 3rd... failed attempt (minutes). The last value repeats. */
export const JOB_BACKOFF_MINUTES = [2, 10, 30];

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
      const res = insert.run(
        `job-${crypto.randomUUID()}`,
        tenderId,
        job.url,
        job.label ?? null,
        job.priority ?? documentJobPriority(job.label || job.url),
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
 * cannot loop forever). Highest priority (lowest number) first, then oldest.
 */
export function claimDueJobs(limit: number = 5, leaseMinutes: number = 10): IngestJob[] {
  const select = db.prepare(`
    SELECT id FROM document_ingest_jobs
    WHERE status = 'pending' AND julianday(next_retry_at) <= julianday('now')
    ORDER BY priority ASC, created_at ASC
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

/** Puts a tender's failed jobs back in the queue with fresh attempts (operator "Retry" action). */
export function requeueFailedJobs(tenderId: string): number {
  return db.prepare(`
    UPDATE document_ingest_jobs
    SET status = 'pending', attempts = 0, lease_until = NULL, next_retry_at = CURRENT_TIMESTAMP
    WHERE tender_id = ? AND status = 'failed'
  `).run(tenderId).changes;
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
