import path from 'path';
import { db, DOSSIERS_DIR } from '../connection.js';
import { purgeTenderDirsOnDisk } from '../../services/fileUtils.js';

/**
 * Rows in 'staging' are mid-ingest (documents still being checked) and must not be visible as
 * opportunities: excluded from listing, portal summary, KPIs and retention sweeps. They remain
 * visible to duplicate detection and suppression checks, which query `tenders` directly.
 */
export const NOT_STAGING_SQL = "COALESCE(ingestion_status, 'ready') NOT IN ('staging', 'awaiting_scope')";

/**
 * 'awaiting_scope': the listing matched no track, so the tender is hidden until the worker has
 * read its documents and either releases it (a track matched) or removes it (docs/15 F2).
 */
export type IngestionStatus = 'staging' | 'ready' | 'awaiting_scope';

/**
 * Undated tenders are aged for this many days, in ingest (B6b), retention and the Inbox alike, so
 * the three never disagree (docs/16 A2).
 */
export const UNDATED_MAX_AGE_DAYS = 90;

/** Pipeline stages after triage; a tender that reached any of them is history worth keeping. */
const PIPELINE_STAGES_SQL = "'Under Review', 'Preparing Bid', 'Submitted', 'Won'";

/**
 * The date an undated tender is aged from: its publish date when the portal stated one, otherwise
 * when we first saw it. A publish date inferred from an upload folder is only an upper bound and
 * is never used for ageing (docs/16 A2).
 */
export const UNDATED_AGE_ANCHOR_SQL =
  "CASE WHEN publish_date IS NULL OR COALESCE(publish_date_source, 'listing') = 'upload_folder' THEN created_at ELSE publish_date END";

export const ACTIVE_UNEXPIRED_SQL = `((closing_date IS NULL AND ((${UNDATED_AGE_ANCHOR_SQL}) IS NULL OR julianday('now') - julianday(${UNDATED_AGE_ANCHOR_SQL}) <= ${UNDATED_MAX_AGE_DAYS})) OR julianday(closing_date) >= julianday('now') OR is_bookmarked = 1 OR COALESCE(needs_review, 0) = 1)`;

/**
 * Crash recovery: a tender left in 'staging' longer than `olderThanMinutes` (e.g. the process
 * died mid-ingest) is released to 'ready' so it is neither invisible nor exempt from retention.
 */
export function releaseStaleStagingTenders(olderThanMinutes: number = 60): number {
  return db.prepare(`
    UPDATE tenders SET ingestion_status = 'ready'
    WHERE ingestion_status = 'staging'
      AND julianday(COALESCE(updated_at, created_at)) <= julianday('now', '-' || ? || ' minutes')
  `).run(olderThanMinutes).changes;
}

/**
 * Controlled deletion of tenders and their physical dossier files
 */
export function deleteTenders(
  tenderIds: string[],
  reason: 'user' | 'auto-expired' | 'passed-aged-out' | 'no-track-match' = 'user'
): { deletedCount: number; purgedFiles: string[] } {
  if (!tenderIds || tenderIds.length === 0) {
    return { deletedCount: 0, purgedFiles: [] };
  }

  const placeholders = tenderIds.map(() => '?').join(',');

  // Record every user-deleted or auto-expired tender in the suppression list, whatever its pipeline
  // stage. Restricting this to 'New Opportunity' let tenders deleted from the Pipeline (e.g. 'Under
  // Review') be re-scraped straight back into the Inbox on the next scan.
  const suppressedTenders = db.prepare(`
    SELECT id, canonical_id, closing_date FROM tenders
    WHERE id IN (${placeholders})
  `).all(...tenderIds) as { id: string; canonical_id: string; closing_date: string | null }[];

  const deleteTx = db.transaction(() => {
    if (reason === 'user' || reason === 'auto-expired' || reason === 'no-track-match') {
      for (const t of suppressedTenders) {
        recordTenderSuppression(t.id, t.canonical_id || t.id, t.closing_date, reason);
      }
    }

    db.prepare(`DELETE FROM tenders WHERE id IN (${placeholders})`).run(...tenderIds);
  });

  deleteTx();

  const { purged } = purgeTenderDirectories(tenderIds);
  return { deletedCount: tenderIds.length, purgedFiles: purged };
}

/**
 * Slims Passed tenders: removes files, notes, description, keywords, while retaining slim record for dedup
 */
export function slimPassedTenders(tenderIds: string[]): { slimmedCount: number; purgedFiles: string[] } {
  if (!tenderIds || tenderIds.length === 0) {
    return { slimmedCount: 0, purgedFiles: [] };
  }

  const placeholders = tenderIds.map(() => '?').join(',');
  const fromPipeline = new Set(
    (db.prepare(`
      SELECT DISTINCT tender_id FROM pipeline_audit_logs
      WHERE tender_id IN (${placeholders}) AND new_status IN (${PIPELINE_STAGES_SQL})
    `).all(...tenderIds) as { tender_id: string }[]).map(r => r.tender_id)
  );
  const inboxOnly = tenderIds.filter(id => !fromPipeline.has(id));
  const pipelineIds = tenderIds.filter(id => fromPipeline.has(id));

  // Operator notes are never erased. A tender passed straight from the Inbox keeps a slim record
  // (for dedup and undo); one that was ever in the Pipeline keeps its notes, description, history
  // and corrigenda, and only its downloaded files are removed (docs/16 B2).
  const slimTx = db.transaction(() => {
    if (inboxOnly.length) {
      const ph = inboxOnly.map(() => '?').join(',');
      db.prepare(`DELETE FROM corrigendum_logs WHERE tender_id IN (${ph})`).run(...inboxOnly);
      db.prepare(`
        UPDATE tenders
        SET cached_dossiers = '[]',
            description = '',
            extracted_text = '',
            matched_keywords = '[]',
            estimated_value = NULL,
            location = NULL,
            slimmed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${ph})
      `).run(...inboxOnly);
    }
    if (pipelineIds.length) {
      const ph = pipelineIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE tenders SET cached_dossiers = '[]', slimmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${ph})
      `).run(...pipelineIds);
    }
  });

  slimTx();

  const { purged } = purgeTenderDirectories(tenderIds);
  return { slimmedCount: tenderIds.length, purgedFiles: purged };
}

/**
 * Retention queries for automated lifecycle daemon
 */
export function getPassedTendersPendingSlim(olderThanMinutes: number = 2, limit: number = 200): string[] {
  const rows = db.prepare(`
    SELECT id FROM tenders
    WHERE pipeline_status = 'Passed'
      AND slimmed_at IS NULL
      AND passed_at IS NOT NULL
      AND julianday('now') >= julianday(passed_at, '+' || ? || ' minutes')
    ORDER BY passed_at ASC
    LIMIT ?
  `).all(olderThanMinutes, limit) as { id: string }[];
  return rows.map(r => r.id);
}

export function getExpiredUnreviewedTenderIds(graceDays: number = 2, limit: number = 200): string[] {
  const rows = db.prepare(`
    SELECT id FROM tenders
    WHERE pipeline_status = 'New Opportunity'
      AND is_bookmarked = 0
      AND ${NOT_STAGING_SQL}
      -- Tenders flagged for operator review (e.g. a corrigendum moved the deadline earlier)
      -- stay until the operator confirms or passes them.
      AND COALESCE(needs_review, 0) = 0
      AND (
        (closing_date IS NOT NULL AND julianday(closing_date) <= julianday('now', '-' || ? || ' days'))
        OR
        -- Undated: age from the stated publish date, else first-seen time (never from an
        -- upload-folder guess). Same limit as ingest and the Inbox (docs/16 A2).
        (closing_date IS NULL AND (${UNDATED_AGE_ANCHOR_SQL}) IS NOT NULL
          AND julianday(${UNDATED_AGE_ANCHOR_SQL}) <= julianday('now', '-' || ? || ' days'))
      )
    ORDER BY closing_date ASC
    LIMIT ?
  `).all(graceDays, UNDATED_MAX_AGE_DAYS, limit) as { id: string }[];
  return rows.map(r => r.id);
}

export function getAgedOutPassedTenderIds(retentionDays: number = 10, limit: number = 200): string[] {
  const rows = db.prepare(`
    SELECT id FROM tenders
    WHERE pipeline_status = 'Passed'
      AND slimmed_at IS NOT NULL
      -- Tenders that were ever in the Pipeline are kept as history with their notes (docs/16 B2).
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_audit_logs l
        WHERE l.tender_id = tenders.id AND l.new_status IN (${PIPELINE_STAGES_SQL})
      )
      AND julianday('now') >= julianday(COALESCE(closing_date, passed_at, slimmed_at), '+' || ? || ' days')
    ORDER BY COALESCE(closing_date, passed_at, slimmed_at) ASC
    LIMIT ?
  `).all(retentionDays, limit) as { id: string }[];
  return rows.map(r => r.id);
}

/**
 * Suppression-list lifecycle (deleted_tenders). A record suppresses re-import while ANY of:
 *   - it has no closing date (undated deletions are remembered indefinitely), or
 *   - its closing date + SUPPRESSION_CLOSING_GRACE_DAYS has not passed, or
 *   - it was deleted (or last re-sighted) less than SUPPRESSION_MIN_RETENTION_DAYS ago.
 * The ingest check and the retention cleanup share these constants so they can never disagree.
 */
export const SUPPRESSION_CLOSING_GRACE_DAYS = 7;
export const SUPPRESSION_MIN_RETENTION_DAYS = 90;
/**
 * An undated suppression lapses this many days after the portal last listed the tender. Each
 * sighting refreshes it, so a stale notice the portal keeps listing stays suppressed, but no
 * record is permanent (docs/16 A2, B8).
 */
export const SUPPRESSION_UNDATED_RETENTION_DAYS = 120;

export type SuppressionReason = 'user' | 'auto-expired' | 'stale' | 'no-track-match' | 'legacy';

export function recordTenderSuppression(
  id: string,
  canonicalId: string,
  closingDate: string | null,
  reason: SuppressionReason = 'auto-expired'
): void {
  db.prepare(`
    INSERT INTO deleted_tenders (id, canonical_id, closing_date, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deleted_at = CURRENT_TIMESTAMP,
      closing_date = COALESCE(excluded.closing_date, deleted_tenders.closing_date),
      -- An operator deletion is never downgraded to an automatic one.
      reason = CASE WHEN deleted_tenders.reason = 'user' THEN 'user' ELSE excluded.reason END
  `).run(id, canonicalId, closingDate, reason);
}

const SUPPRESSION_ACTIVE_SQL = `
  (CASE
     WHEN closing_date IS NULL THEN julianday('now') <= julianday(deleted_at, '+${SUPPRESSION_UNDATED_RETENTION_DAYS} days')
     ELSE (julianday('now') <= julianday(closing_date, '+${SUPPRESSION_CLOSING_GRACE_DAYS} days')
           OR julianday('now') <= julianday(deleted_at, '+${SUPPRESSION_MIN_RETENTION_DAYS} days'))
   END)
`;

/**
 * Returns true if a tender (by id or canonical id) is on the active suppression list. A hit
 * refreshes deleted_at, so a record stays alive for as long as the portal keeps listing the
 * tender, rather than lapsing and forcing a fresh download + OCR that may fail and let it back in.
 *
 * An automatic suppression (auto-expired, stale, no track match) is lifted when the tender
 * reappears with a deadline that is in the future and later than the one it was suppressed with:
 * the deadline was extended after it expired (docs/15 F4). An operator deletion is never lifted.
 */
export function isTenderSuppressed(id: string, canonicalId: string, scannedClosingDate?: string | null): boolean {
  const hits = db.prepare(`
    SELECT id, closing_date, COALESCE(reason, 'legacy') AS reason FROM deleted_tenders
    WHERE (id = ? OR canonical_id = ?) AND ${SUPPRESSION_ACTIVE_SQL}
  `).all(id, canonicalId) as { id: string; closing_date: string | null; reason: SuppressionReason }[];
  if (hits.length === 0) return false;

  const scannedMs = scannedClosingDate ? new Date(scannedClosingDate).getTime() : NaN;
  if (!isNaN(scannedMs) && scannedMs > Date.now()) {
    const liftable = hits.filter(h => h.reason !== 'user' && (!h.closing_date || scannedMs > new Date(h.closing_date).getTime()));
    if (liftable.length === hits.length) {
      const del = db.prepare('DELETE FROM deleted_tenders WHERE id = ?');
      for (const h of liftable) del.run(h.id);
      return false;
    }
  }

  const touch = db.prepare('UPDATE deleted_tenders SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?');
  for (const h of hits) touch.run(h.id);
  return true;
}

/** Removes suppression records that are no longer active (see isTenderSuppressed). */
export function cleanExpiredDeletedTenderRecords(
  closingGraceDays: number = SUPPRESSION_CLOSING_GRACE_DAYS,
  minRetentionDays: number = SUPPRESSION_MIN_RETENTION_DAYS,
  undatedRetentionDays: number = SUPPRESSION_UNDATED_RETENTION_DAYS
): number {
  const info = db.prepare(`
    DELETE FROM deleted_tenders
    WHERE (closing_date IS NOT NULL
        AND julianday('now') > julianday(closing_date, '+' || ? || ' days')
        AND julianday('now') > julianday(deleted_at, '+' || ? || ' days'))
       OR (closing_date IS NULL
        AND julianday('now') > julianday(deleted_at, '+' || ? || ' days'))
  `).run(closingGraceDays, minRetentionDays, undatedRetentionDays);
  return info.changes;
}

/** Total count of tenders currently held awaiting document scope analysis (Phase 4 / docs/15 F2). */
export function countAwaitingScopeTenders(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tenders WHERE ingestion_status = 'awaiting_scope'`).get() as { n: number };
  return row ? row.n : 0;
}

/** Tenders held for their documents longer than `olderThanDays` (their documents never arrived). */
export function getStaleAwaitingScopeTenderIds(olderThanDays: number = 3, limit: number = 200): string[] {
  return (db.prepare(`
    SELECT id FROM tenders
    WHERE ingestion_status = 'awaiting_scope'
      AND julianday(COALESCE(updated_at, created_at)) <= julianday('now', '-' || ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM document_ingest_jobs j
        WHERE j.tender_id = tenders.id AND j.status = 'pending' AND j.attempts = 0
      )
    LIMIT ?
  `).all(olderThanDays, limit) as { id: string }[]).map(r => r.id);
}

export interface PendingFilePurgeRow {
  id: string;
  folder_path: string;
  attempts: number;
}

export function enqueuePendingFilePurge(id: string, folderPath: string, errorMessage: string): void {
  db.prepare(`
    INSERT INTO pending_file_purges (id, folder_path, attempts, last_error)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error
  `).run(id, folderPath, errorMessage);
}

export function getPendingFilePurges(maxAttempts: number = 10): PendingFilePurgeRow[] {
  return db.prepare('SELECT id, folder_path, attempts FROM pending_file_purges WHERE attempts < ?').all(maxAttempts) as PendingFilePurgeRow[];
}

export function deletePendingFilePurge(id: string): void {
  db.prepare('DELETE FROM pending_file_purges WHERE id = ?').run(id);
}

export function incrementPendingFilePurgeAttempt(id: string, errorMessage: string): void {
  db.prepare('UPDATE pending_file_purges SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(errorMessage, id);
}

export function countPendingFilePurges(maxAttempts: number = 10): number {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM pending_file_purges WHERE attempts < ?').get(maxAttempts) as { c: number } | undefined;
    return row?.c || 0;
  } catch {
    return 0;
  }
}

function purgeTenderDirectories(tenderIds: string[]): { purged: string[]; queued: string[] } {
  return purgeTenderDirsOnDisk(
    DOSSIERS_DIR,
    path.resolve(DOSSIERS_DIR, '.trash'),
    tenderIds,
    (id, folderPath, message) => enqueuePendingFilePurge(`purge-${id}-${Date.now()}`, folderPath, message)
  );
}
