import { db, safeJsonParse } from '../connection.js';
import { Tender } from '../../../types.js';
import { purgeTenderFiles } from '../../dossierStore.js';
import { normalizeReferenceNo } from '../../referenceNo.js';
import {
  buildTenderEmbeddingText,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding,
  EMBEDDING_BLOB_BYTES,
  MINILM_BLOB_HEADER_HEX
} from '../../embeddingService.js';

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
export type IngestionStatus = 'staging' | 'ready' | 'failed_verification' | 'awaiting_scope';

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

export function setTenderIngestionStatus(id: string, status: IngestionStatus): boolean {
  return db.prepare('UPDATE tenders SET ingestion_status = ? WHERE id = ?').run(status, id).changes > 0;
}

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

export interface TenderProvenanceUpdate {
  deadline_source?: string | null;
  deadline_confidence?: string | null;
  doc_fetch_status?: string;
  needs_review?: number;
  review_reason?: string | null;
}

/** Updates only the provenance/review columns given (Phase 3/4). */
export function setTenderProvenance(id: string, fields: TenderProvenanceUpdate): boolean {
  const allowed = ['deadline_source', 'deadline_confidence', 'doc_fetch_status', 'needs_review', 'review_reason'] as const;
  const keys = allowed.filter(k => fields[k] !== undefined);
  if (keys.length === 0) return false;
  const sql = `UPDATE tenders SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...keys.map(k => fields[k] as any), id).changes > 0;
}

/** Operator confirmed a flagged tender (e.g. a deadline moved earlier): clears the review flag. */
export function clearTenderReviewFlag(id: string): boolean {
  return db.prepare(`
    UPDATE tenders SET needs_review = 0, review_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(id).changes > 0;
}

/** Replaces a tender's matched tracks and keywords (document-scope re-scoring, Phase 2.5). */
export function updateTenderTracks(id: string, tracks: string[], keywords: string[]): boolean {
  return db.prepare('UPDATE tenders SET domain_tracks = ?, matched_keywords = ? WHERE id = ?')
    .run(JSON.stringify(tracks), JSON.stringify(Array.from(new Set(keywords))), id).changes > 0;
}

/** Logs a deadline extension as an unacknowledged corrigendum and marks the tender amended. */
export function recordDeadlineExtension(tenderId: string, previousFormatted: string, newFormatted: string): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
      VALUES (?, ?, 'deadline_extension', ?, ?, 0)
    `).run(`corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, tenderId, previousFormatted, newFormatted);
    db.prepare('UPDATE tenders SET has_corrigendum = 1 WHERE id = ?').run(tenderId);
  });
  tx();
}

export interface EmbeddingBackfillRow {
  id: string;
  title: string;
  organization: string | null;
  description: string | null;
  embedding: Buffer | null;
}

/** Tenders whose stored embedding is missing, legacy-untagged, or not in the MiniLM space. */
export function getTendersNeedingModelEmbedding(limit: number = 100): EmbeddingBackfillRow[] {
  return db.prepare(`
    SELECT id, title, organization, description, embedding FROM tenders
    WHERE embedding IS NULL
       OR length(embedding) <> ?
       OR hex(substr(embedding, 1, 4)) <> ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(EMBEDDING_BLOB_BYTES, MINILM_BLOB_HEADER_HEX, limit) as EmbeddingBackfillRow[];
}

/**
 * Stores a re-computed embedding only if the tender's text and embedding are unchanged since
 * `row` was read, so a concurrent edit is never overwritten with a vector of the old text.
 * Does not touch updated_at (Inbox ordering).
 */
export function setTenderEmbeddingIfUnchanged(row: EmbeddingBackfillRow, blob: Buffer): boolean {
  const res = db.prepare(`
    UPDATE tenders SET embedding = ?
    WHERE id = ? AND title IS ? AND organization IS ? AND description IS ? AND embedding IS ?
  `).run(blob, row.id, row.title, row.organization, row.description, row.embedding);
  return res.changes > 0;
}

export function countTenderEmbeddingsBySpace(): { totalTenders: number; indexedTenders: number; modelIndexedTenders: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS indexed,
      SUM(CASE WHEN length(embedding) = ? AND hex(substr(embedding, 1, 4)) = ? THEN 1 ELSE 0 END) AS model
    FROM tenders
  `).get(EMBEDDING_BLOB_BYTES, MINILM_BLOB_HEADER_HEX) as any;
  return { totalTenders: row?.total || 0, indexedTenders: row?.indexed || 0, modelIndexedTenders: row?.model || 0 };
}

function mapTenderRow(row: any): Tender {
  const { embedding, ...rest } = row;
  return {
    ...rest,
    secondary_sources: safeJsonParse(row.secondary_sources, []),
    domain_tracks: safeJsonParse(row.domain_tracks, []),
    matched_keywords: safeJsonParse(row.matched_keywords, []),
    cached_dossiers: safeJsonParse(row.cached_dossiers, []),
    attachment_urls: safeJsonParse(row.attachment_urls, [])
  };
}

export function getAllTenders(filters?: {
  track?: string;
  portalId?: string;
  status?: string;
  search?: string;
  bookmarkedOnly?: boolean;
  corrigendumOnly?: boolean;
  unreadOnly?: boolean;
  excludeExpired?: boolean;
}): Tender[] {
  let query = `SELECT * FROM tenders WHERE ${NOT_STAGING_SQL}`;
  const params: any[] = [];

  if (filters?.status && filters.status !== 'All') {
    query += ' AND pipeline_status = ?';
    params.push(filters.status);
  }

  if (filters?.portalId && filters.portalId !== 'All') {
    query += ' AND portal_id = ?';
    params.push(filters.portalId);
  }

  if (filters?.excludeExpired) {
    // Undated tenders age from their publish date, or from when we first saw them if the portal gave none.
    query += ` AND ((closing_date IS NULL AND ((${UNDATED_AGE_ANCHOR_SQL}) IS NULL OR julianday('now') - julianday(${UNDATED_AGE_ANCHOR_SQL}) <= ${UNDATED_MAX_AGE_DAYS})) OR julianday(closing_date) >= julianday('now') OR is_bookmarked = 1 OR COALESCE(needs_review, 0) = 1)`;
  }

  if (filters?.bookmarkedOnly) {
    query += ' AND is_bookmarked = 1';
  }

  if (filters?.corrigendumOnly) {
    query += ' AND has_corrigendum = 1';
  }

  if (filters?.unreadOnly) {
    query += ' AND viewed = 0';
  }

  if (filters?.track && filters.track !== 'All') {
    query += ' AND EXISTS (SELECT 1 FROM json_each(tenders.domain_tracks) WHERE value = ?)';
    params.push(filters.track);
  }

  query += ' ORDER BY CASE WHEN closing_date IS NULL THEN 1 ELSE 0 END, closing_date ASC, updated_at DESC';

  let rows = db.prepare(query).all(...params) as any[];

  if (filters?.search && filters.search.trim()) {
    const rawSearch = filters.search.trim();
    const lowerSearch = rawSearch.toLowerCase();

    rows = rows.filter(row => {
      const titleMatch = (row.title || '').toLowerCase().includes(lowerSearch);
      const orgMatch = (row.organization || '').toLowerCase().includes(lowerSearch);
      const refMatch = (row.reference_no || '').toLowerCase().includes(lowerSearch);
      const portalMatch = (row.portal_name || '').toLowerCase().includes(lowerSearch);

      if (titleMatch || orgMatch || refMatch || portalMatch) {
        return true;
      }

      // Hybrid Semantic Search fallback for natural-language queries (>= 4 chars)
      if (lowerSearch.length >= 4) {
        const candidateText = `${row.title || ''} ${row.organization || ''}`;
        const sim = computeTextSemanticSimilarity(lowerSearch, candidateText, null, row.embedding);
        if (sim >= 0.58) {
          return true;
        }
      }

      return false;
    });
  }

  return rows.map(mapTenderRow);
}

export function getTenderById(id: string): Tender | null {
  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id) as any;
  if (!row) return null;
  return mapTenderRow(row);
}

export function updateTenderStatus(id: string, newStatus: string, notes?: string) {
  const tender = getTenderById(id);
  if (!tender) return false;

  const previousStatus = tender.pipeline_status;

  const updateTx = db.transaction(() => {
    let passedClause = '';
    if (newStatus === 'Passed') {
      passedClause = ', passed_at = CURRENT_TIMESTAMP';
    } else {
      passedClause = ', passed_at = NULL, slimmed_at = NULL';
    }

    db.prepare(`
      UPDATE tenders 
      SET pipeline_status = ?, status_notes = COALESCE(?, status_notes), updated_at = CURRENT_TIMESTAMP${passedClause}
      WHERE id = ?
    `).run(newStatus, notes, id);

    db.prepare(`
      INSERT INTO pipeline_audit_logs (id, tender_id, previous_status, new_status, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run('log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6), id, previousStatus, newStatus, notes || null);
  });

  updateTx();
  return true;
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

    db.prepare(`DELETE FROM corrigendum_logs WHERE tender_id IN (${placeholders})`).run(...tenderIds);
    db.prepare(`DELETE FROM pipeline_audit_logs WHERE tender_id IN (${placeholders})`).run(...tenderIds);
    db.prepare(`DELETE FROM tenders WHERE id IN (${placeholders})`).run(...tenderIds);
  });

  deleteTx();

  const { purged } = purgeTenderFiles(tenderIds);
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

  const { purged } = purgeTenderFiles(tenderIds);
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

/**
 * Calculates per-portal total and unread tender counts for active opportunities
 */
export function getPortalTenderSummary(): {
  portal_id: string;
  portal_name: string;
  total_count: number;
  unread_count: number;
}[] {
  return db.prepare(`
    SELECT 
      portal_id,
      portal_name,
      COUNT(*) as total_count,
      SUM(CASE WHEN viewed = 0 THEN 1 ELSE 0 END) as unread_count
    FROM tenders
    WHERE pipeline_status = 'New Opportunity'
      AND ${NOT_STAGING_SQL}
      AND (closing_date IS NULL OR julianday(closing_date) >= julianday('now') OR is_bookmarked = 1)
    GROUP BY portal_id, portal_name
    ORDER BY unread_count DESC, total_count DESC
  `).all() as any[];
}

export function toggleTenderBookmark(id: string): { success: boolean; is_bookmarked: number } {
  const tender = getTenderById(id);
  if (!tender) return { success: false, is_bookmarked: 0 };

  const nextState = tender.is_bookmarked === 1 ? 0 : 1;
  db.prepare(`
    UPDATE tenders 
    SET is_bookmarked = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextState, id);

  return { success: true, is_bookmarked: nextState };
}

export function updateTenderNotes(id: string, notes: string): boolean {
  const res = db.prepare(`
    UPDATE tenders SET status_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(notes, id);
  return res.changes > 0;
}

export function markTenderViewed(id: string, viewed: boolean = true): boolean {
  const res = db.prepare(`
    UPDATE tenders SET viewed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(viewed ? 1 : 0, id);
  return res.changes > 0;
}

/** Pass null or an empty string to clear the date. */
export function updateTenderResultDate(id: string, date: string | null): boolean {
  const res = db.prepare(`
    UPDATE tenders SET result_expected_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(date || null, id);
  return res.changes > 0;
}

export function updateTenderFields(
  id: string,
  fields: Partial<{
    title: string;
    organization: string;
    reference_no: string | null;
    closing_date: string | null;
    closing_date_formatted: string;
    estimated_value: string | null;
    description: string;
    direct_url: string;
    location: string | null;
    cached_dossiers: any[];
    has_corrigendum: number;
  }>
): Tender | null {
  const existing = getTenderById(id);
  if (!existing) return null;

  const nextTitle = fields.title !== undefined ? fields.title : existing.title;
  const nextOrg = fields.organization !== undefined ? fields.organization : existing.organization;
  const nextDesc = fields.description !== undefined ? fields.description : existing.description;

  // Only re-embed when the embedded text actually changed. Previously every update (including
  // fetch-documents and analyze, which only touch dossiers/dates) overwrote a MiniLM vector with
  // a fast-space one. When the text did change, a fast-tagged vector is stored now and the
  // background backfill upgrades it to MiniLM.
  const textChanged =
    nextTitle !== existing.title || nextOrg !== existing.organization || (nextDesc || '') !== (existing.description || '');
  const existingEmbedding = (db.prepare('SELECT embedding FROM tenders WHERE id = ?').get(id) as any)?.embedding ?? null;
  const embeddingBuf = textChanged || !existingEmbedding
    ? serializeEmbedding(
        computeFastSemanticEmbedding(buildTenderEmbeddingText({ title: nextTitle, organization: nextOrg, description: nextDesc })),
        'fast'
      )
    : existingEmbedding;

  db.prepare(`
    UPDATE tenders
    SET title = ?,
        organization = ?,
        reference_no = ?,
        closing_date = ?,
        closing_date_formatted = ?,
        estimated_value = ?,
        description = ?,
        direct_url = ?,
        location = ?,
        cached_dossiers = ?,
        has_corrigendum = ?,
        embedding = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    nextTitle,
    nextOrg,
    fields.reference_no !== undefined ? fields.reference_no : existing.reference_no,
    fields.closing_date !== undefined ? fields.closing_date : existing.closing_date,
    fields.closing_date_formatted !== undefined ? fields.closing_date_formatted : existing.closing_date_formatted,
    fields.estimated_value !== undefined ? fields.estimated_value : existing.estimated_value,
    nextDesc,
    fields.direct_url !== undefined ? fields.direct_url : existing.direct_url,
    fields.location !== undefined ? fields.location : existing.location,
    fields.cached_dossiers !== undefined ? JSON.stringify(fields.cached_dossiers) : JSON.stringify(existing.cached_dossiers || []),
    fields.has_corrigendum !== undefined ? fields.has_corrigendum : existing.has_corrigendum,
    embeddingBuf,
    id
  );
  if (fields.reference_no !== undefined) syncReferenceNorm(id);

  return getTenderById(id);
}

/** Recomputes `reference_norm` from `reference_no` (one normalisation for every write path). */
export function syncReferenceNorm(id: string): void {
  const row = db.prepare('SELECT reference_no FROM tenders WHERE id = ?').get(id) as { reference_no: string | null } | undefined;
  if (!row) return;
  db.prepare('UPDATE tenders SET reference_norm = ? WHERE id = ?').run(normalizeReferenceNo(row.reference_no), id);
}

/**
 * Backfills `reference_norm` for every row and clears stored references that fail validation
 * (date fragments such as "Jun-2026", "FY-2026-27"; docs/15 F3). Returns how many references were
 * cleared.
 */
export function backfillReferenceNorms(): { normalized: number; cleared: number } {
  const rows = db.prepare('SELECT id, reference_no FROM tenders WHERE reference_no IS NOT NULL').all() as { id: string; reference_no: string }[];
  let normalized = 0;
  let cleared = 0;
  const setNorm = db.prepare('UPDATE tenders SET reference_norm = ? WHERE id = ?');
  const clear = db.prepare('UPDATE tenders SET reference_no = NULL, reference_norm = NULL WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const norm = normalizeReferenceNo(r.reference_no);
      if (norm) { setNorm.run(norm, r.id); normalized++; } else { clear.run(r.id); cleared++; }
    }
  })();
  return { normalized, cleared };
}

export function createManualTender(input: {
  title: string;
  organization: string;
  reference_no?: string | null;
  portal_name?: string;
  direct_url?: string;
  closing_date?: string | null;
  closing_date_formatted?: string;
  estimated_value?: string | null;
  location?: string | null;
  description?: string;
  domain_tracks?: string[];
  matched_keywords?: string[];
  match_score?: number;
  cached_dossiers?: any[];
}): Tender {
  const id = `tender-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const today = new Date().toISOString().slice(0, 10);
  const embeddingBuf = serializeEmbedding(
    computeFastSemanticEmbedding(
      buildTenderEmbeddingText({
        title: input.title,
        organization: input.organization,
        description: input.description
      })
    )
  );

  db.prepare(`
    INSERT INTO tenders (
      id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
      domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
      estimated_value, location, description, cached_dossiers, has_corrigendum, pipeline_status, embedding
    ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'New Opportunity', ?)
  `).run(
    id,
    id,
    input.reference_no || null,
    input.title.trim(),
    input.organization.trim(),
    input.portal_name?.trim() || 'Manual Entry',
    input.direct_url?.trim() || '#',
    JSON.stringify(input.domain_tracks || []),
    JSON.stringify(input.matched_keywords || []),
    input.match_score ?? 80,
    today,
    input.closing_date || null,
    input.closing_date_formatted || 'Not Available',
    input.estimated_value || null,
    input.location || 'Pakistan',
    input.description ?? '',
    JSON.stringify(input.cached_dossiers || []),
    embeddingBuf
  );
  syncReferenceNorm(id);

  return getTenderById(id)!;
}

export interface DedupCandidateRow {
  id: string;
  canonical_id: string;
  title: string;
  organization: string;
  closing_date: string | null;
  embedding: Buffer | null;
  portal_id: string;
}

/**
 * Tenders with the same normalised reference (stored in `reference_norm`, computed by
 * normalizeReferenceNo). Tenders held for their documents ('awaiting_scope') are not considered;
 * staging rows are, so a tender being verified is not inserted twice.
 */
export function findTendersByReferenceNorm(referenceNorm: string, _portalId?: string | null): DedupCandidateRow[] {
  return db.prepare(`
    SELECT id, canonical_id, title, organization, closing_date, embedding, portal_id
    FROM tenders
    WHERE (reference_norm = ?
        -- Rows written before reference_norm existed (or by direct SQL) are matched on the fly.
        OR (reference_norm IS NULL AND reference_no IS NOT NULL
            AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(reference_no, '-', ''), '/', ''), ' ', ''), '_', ''), '.', ''), char(9), '')) = ?))
      AND COALESCE(ingestion_status, 'ready') != 'awaiting_scope'
  `).all(referenceNorm, referenceNorm) as DedupCandidateRow[];
}

/**
 * Similarity-dedup candidates: tenders (not 'awaiting_scope') from OTHER portals whose deadline is within
 * ±1.5 days, or (for an undated candidate) undated tenders first seen in the last 14 days.
 * Rows of the same portal are never similarity candidates (docs/16 A3).
 */
export function findDedupCandidates(closingDate?: string | null, excludePortalId?: string | null): DedupCandidateRow[] {
  const portalClause = excludePortalId ? 'AND portal_id != ?' : '';
  const portalParams = excludePortalId ? [excludePortalId] : [];
  if (closingDate) {
    return db.prepare(`
      SELECT id, canonical_id, title, organization, closing_date, embedding, portal_id
      FROM tenders
      WHERE closing_date IS NOT NULL
      AND ABS(julianday(closing_date) - julianday(?)) <= 1.5
      AND COALESCE(ingestion_status, 'ready') != 'awaiting_scope'
      ${portalClause}
    `).all(closingDate, ...portalParams) as DedupCandidateRow[];
  }
  return db.prepare(`
    SELECT id, canonical_id, title, organization, closing_date, embedding, portal_id
    FROM tenders
    WHERE closing_date IS NULL
    AND created_at >= datetime('now', '-14 days')
    AND COALESCE(ingestion_status, 'ready') != 'awaiting_scope'
    ${portalClause}
  `).all(...portalParams) as DedupCandidateRow[];
}

export function getAllTenderDossierRows(): { id: string; cached_dossiers: string }[] {
  return db.prepare('SELECT id, cached_dossiers FROM tenders').all() as { id: string; cached_dossiers: string }[];
}

export function setTenderCachedDossiersRaw(id: string, cachedDossiersJson: string): void {
  db.prepare('UPDATE tenders SET cached_dossiers = ? WHERE id = ?').run(cachedDossiersJson, id);
}

export interface SecondarySourceInput {
  portalName: string;
  directUrl: string;
  discoveredAt: string;
  /** The deadline that source showed, kept for the operator (it never changes the tender's own; docs/16 A4). */
  closingDate?: string | null;
}

/**
 * Records another portal that lists the same tender ("Also listed on"). The tender's own portal is
 * never recorded (docs/16 B1), and entries are unique by link, so two different notices on the
 * same secondary portal are both kept.
 */
export function appendSecondarySource(id: string, source: SecondarySourceInput): boolean {
  const row = db.prepare('SELECT secondary_sources, portal_name FROM tenders WHERE id = ?').get(id) as { secondary_sources?: string; portal_name?: string } | undefined;
  if (!row) return false;
  if (source.portalName === row.portal_name) return false;
  const sources = safeJsonParse<SecondarySourceInput[]>(row.secondary_sources, []);
  if (sources.some(s => s.directUrl === source.directUrl)) return false;
  sources.push(source.closingDate ? source : { portalName: source.portalName, directUrl: source.directUrl, discoveredAt: source.discoveredAt });
  db.prepare('UPDATE tenders SET secondary_sources = ? WHERE id = ?').run(JSON.stringify(sources), id);
  return true;
}

/** One-time cleanup: removes "Also listed on" entries that name the tender's own portal (B1). */
export function removeSelfSecondarySources(): number {
  const rows = db.prepare(`SELECT id, portal_name, secondary_sources FROM tenders WHERE secondary_sources IS NOT NULL AND secondary_sources != '[]'`).all() as { id: string; portal_name: string; secondary_sources: string }[];
  let changed = 0;
  const update = db.prepare('UPDATE tenders SET secondary_sources = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const sources = safeJsonParse<SecondarySourceInput[]>(r.secondary_sources, []);
      const kept = sources.filter(s => s.portalName !== r.portal_name);
      if (kept.length !== sources.length) {
        update.run(JSON.stringify(kept), r.id);
        changed++;
      }
    }
  })();
  return changed;
}

export function updateTenderAttachmentUrlsIfEmpty(id: string, attachmentUrls: string[]): boolean {
  if (!attachmentUrls || attachmentUrls.length === 0) return false;
  const row = db.prepare('SELECT attachment_urls FROM tenders WHERE id = ?').get(id) as { attachment_urls?: string } | undefined;
  if (!row) return false;
  const existing = safeJsonParse<string[]>(row.attachment_urls, []);
  if (existing.length > 0) return false;
  return db.prepare('UPDATE tenders SET attachment_urls = ? WHERE id = ?').run(JSON.stringify(attachmentUrls), id).changes > 0;
}

/** Adds document links seen on a re-scan to the stored list (union, order kept). */
export function mergeTenderAttachmentUrls(id: string, attachmentUrls: string[]): boolean {
  if (!attachmentUrls || attachmentUrls.length === 0) return false;
  const row = db.prepare('SELECT attachment_urls FROM tenders WHERE id = ?').get(id) as { attachment_urls?: string } | undefined;
  if (!row) return false;
  const existing = safeJsonParse<string[]>(row.attachment_urls, []);
  const merged = [...existing];
  for (const u of attachmentUrls) if (u && !merged.includes(u)) merged.push(u);
  if (merged.length === existing.length) return false;
  return db.prepare('UPDATE tenders SET attachment_urls = ? WHERE id = ?').run(JSON.stringify(merged), id).changes > 0;
}

/**
 * Logs a deadline extension seen on a re-scan: updates the deadline (relabelled as a listing date),
 * marks the tender amended and writes an unacknowledged corrigendum log.
 */
export function applyDuplicateDeadlineExtension(
  id: string,
  closingDate: string,
  formattedDate: string,
  previousFormatted: string
): void {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE tenders SET closing_date = ?, closing_date_formatted = ?, has_corrigendum = 1,
        deadline_source = 'html_row', deadline_confidence = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(closingDate, formattedDate, id);

    db.prepare(`
      INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
      VALUES (?, ?, 'deadline_extension', ?, ?, 0)
    `).run(
      'corr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      id,
      previousFormatted,
      formattedDate
    );
  });
  tx();
}

/** Sets a tender's deadline and its provenance together (never one without the other). */
export function setTenderDeadline(id: string, closingDate: string | null, formatted: string, source: string | null, confidence: string | null): boolean {
  return db.prepare(`
    UPDATE tenders SET closing_date = ?, closing_date_formatted = ?, deadline_source = ?, deadline_confidence = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(closingDate, formatted, source, confidence, id).changes > 0;
}

/** Releases a tender held for its documents (awaiting_scope) once a track matches (docs/15 F2). */
export function setTenderTracksAndRelease(id: string, tracks: string[], keywords: string[], matchScore: number): boolean {
  return db.prepare(`
    UPDATE tenders SET domain_tracks = ?, matched_keywords = ?, match_score = ?, ingestion_status = 'ready',
      created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ingestion_status = 'awaiting_scope'
  `).run(JSON.stringify(tracks), JSON.stringify(Array.from(new Set(keywords))), matchScore, id).changes > 0;
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
    LIMIT ?
  `).all(olderThanDays, limit) as { id: string }[]).map(r => r.id);
}

export interface UpsertScrapedTenderInput {
  id: string;
  canonical_id: string;
  reference_no: string | null;
  title: string;
  organization: string;
  portal_id: string;
  portal_name: string;
  direct_url: string;
  domain_tracks: string[];
  matched_keywords: string[];
  match_score: number;
  semantic_score: number;
  embedding: Buffer | null;
  publish_date: string | null;
  /** 'listing' (stated by the portal) or 'upload_folder' (inferred upper bound; never used for ageing). */
  publish_date_source?: 'listing' | 'upload_folder' | null;
  closing_date: string | null;
  closing_date_formatted: string;
  estimated_value: string | null;
  location: string;
  description: string;
  cached_dossiers: any[];
  attachment_urls: string[];
  has_corrigendum: number;
  ingestion_status: IngestionStatus;
  deadline_source: string | null;
  deadline_confidence: string | null;
  doc_fetch_status: string;
  needs_review: number;
  review_reason: string | null;
}

/**
 * Inserts a newly scraped tender, or completes a row this ingest itself created ('staging' or
 * 'awaiting_scope'). A row that is already 'ready' is NEVER overwritten: re-scans of stored
 * tenders go through the crawler's re-scan path, which changes deadlines only with a corrigendum
 * log or a review flag (docs/16 A1, A5). Returns true when the row was written.
 */
export function upsertScrapedTender(input: UpsertScrapedTenderInput): boolean {
  const values = [
    input.canonical_id,
    input.reference_no,
    normalizeReferenceNo(input.reference_no),
    input.title,
    input.organization,
    input.portal_id,
    input.portal_name,
    input.direct_url,
    JSON.stringify(input.domain_tracks),
    JSON.stringify(Array.from(new Set(input.matched_keywords))),
    input.match_score,
    input.semantic_score,
    input.embedding,
    input.publish_date,
    input.publish_date_source ?? null,
    input.closing_date,
    input.closing_date_formatted,
    input.estimated_value,
    input.location,
    input.description,
    JSON.stringify(input.cached_dossiers),
    JSON.stringify(input.attachment_urls),
    input.has_corrigendum,
    input.ingestion_status,
    input.deadline_source,
    input.deadline_confidence,
    input.doc_fetch_status,
    input.needs_review,
    input.review_reason
  ];

  const tx = db.transaction((): boolean => {
    const existing = db.prepare('SELECT ingestion_status FROM tenders WHERE id = ?').get(input.id) as { ingestion_status: string | null } | undefined;
    if (!existing) {
      db.prepare(`
        INSERT INTO tenders (
          canonical_id, reference_no, reference_norm, title, organization, portal_id, portal_name, direct_url,
          domain_tracks, matched_keywords, match_score, semantic_score, embedding, publish_date, publish_date_source,
          closing_date, closing_date_formatted, estimated_value, location, description, cached_dossiers, attachment_urls,
          has_corrigendum, ingestion_status, deadline_source, deadline_confidence, doc_fetch_status, needs_review, review_reason,
          pipeline_status, id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Opportunity', ?)
      `).run(...values, input.id);
      return true;
    }
    if (existing.ingestion_status !== 'staging' && existing.ingestion_status !== 'awaiting_scope') return false;
    db.prepare(`
      UPDATE tenders SET
        canonical_id = ?, reference_no = ?, reference_norm = ?, title = ?, organization = ?, portal_id = ?, portal_name = ?, direct_url = ?,
        domain_tracks = ?, matched_keywords = ?, match_score = ?, semantic_score = ?, embedding = COALESCE(?, embedding),
        publish_date = ?, publish_date_source = ?, closing_date = ?, closing_date_formatted = ?, estimated_value = ?, location = ?,
        description = ?, cached_dossiers = ?, attachment_urls = ?, has_corrigendum = ?, ingestion_status = ?, deadline_source = ?,
        deadline_confidence = ?, doc_fetch_status = ?, needs_review = ?, review_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND ingestion_status IN ('staging', 'awaiting_scope')
    `).run(...values, input.id);
    return true;
  });
  return tx();
}

/**
 * Removes a row this ingest staged and then rejected. Only a 'staging' row still in the Inbox
 * stage can be removed, so a stored tender can never be deleted here (docs/16 A1).
 */
export function deleteStagedTender(id: string): void {
  db.prepare(`DELETE FROM tenders WHERE id = ? AND ingestion_status = 'staging' AND pipeline_status = 'New Opportunity'`).run(id);
}

export function seedSampleTendersIfEmpty(
  sampleTenders: {
    referenceNo: string;
    title: string;
    organization: string;
    portalId: string;
    portalName: string;
    directUrl: string;
    closingDate: string;
    estimatedValue: string;
    location: string;
    description: string;
    tracks: string[];
    keywords: string[];
    score: number;
  }[],
  formatClosingDateFn: (iso: string | null) => string
): boolean {
  const count = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as { c: number }).c;
  if (count > 0) return false;

  const insertStmt = db.prepare(`
    INSERT INTO tenders (
      id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
      domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
      estimated_value, location, description, has_corrigendum, pipeline_status, status_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((tendersList: typeof sampleTenders) => {
    for (let i = 0; i < tendersList.length; i++) {
      const t = tendersList[i];
      const tenderId = `tender-${t.portalId}-${i + 1}`;
      const formattedDate = formatClosingDateFn(t.closingDate);

      let initialStatus = 'New Opportunity';
      let notes = '';
      if (i === 0) {
        initialStatus = 'Preparing Bid';
        notes = 'BOQ evaluated. Vendor quotes for solar inverters requested from Multan suppliers.';
      } else if (i === 1) {
        initialStatus = 'Under Review';
        notes = 'Evaluating NCC site access and building structural engineering clearance.';
      }

      insertStmt.run(
        tenderId,
        tenderId,
        t.referenceNo,
        t.title,
        t.organization,
        t.portalId,
        t.portalName,
        t.directUrl,
        JSON.stringify(t.tracks),
        JSON.stringify(t.keywords),
        t.score,
        new Date(Date.now() - (i * 2 + 1) * 24 * 3600 * 1000).toISOString().slice(0, 10),
        t.closingDate,
        formattedDate,
        t.estimatedValue,
        t.location,
        t.description,
        i === 0 ? 1 : 0,
        initialStatus,
        notes
      );

      if (i === 0) {
        db.prepare(`
          INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
          VALUES (?, ?, 'deadline_extension', '10 Nov 2026, 02:00 PM PKT', ?, 0)
        `).run('corr-seed-01', tenderId, formattedDate);
      }
    }
  });

  insertMany(sampleTenders);
  return true;
}

