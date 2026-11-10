import { db, safeJsonParse } from '../connection.js';
import { Tender } from '../../../types.js';
import { purgeTenderFiles } from '../../dossierStore.js';
import {
  buildTenderEmbeddingText,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding
} from '../../embeddingService.js';

function mapTenderRow(row: any): Tender {
  const { embedding, ...rest } = row;
  return {
    ...rest,
    secondary_sources: safeJsonParse(row.secondary_sources, []),
    domain_tracks: safeJsonParse(row.domain_tracks, []),
    matched_keywords: safeJsonParse(row.matched_keywords, []),
    cached_dossiers: safeJsonParse(row.cached_dossiers, [])
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
  let query = 'SELECT * FROM tenders WHERE 1=1';
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
    query += " AND ((closing_date IS NULL AND (publish_date IS NULL OR julianday('now') - julianday(publish_date) <= 60)) OR julianday(closing_date) >= julianday('now') OR is_bookmarked = 1)";
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
  reason: 'user' | 'auto-expired' | 'passed-aged-out' = 'user'
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
    if (reason === 'user' || reason === 'auto-expired') {
      for (const t of suppressedTenders) {
        recordTenderSuppression(t.id, t.canonical_id || t.id, t.closing_date);
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

  const slimTx = db.transaction(() => {
    db.prepare(`DELETE FROM corrigendum_logs WHERE tender_id IN (${placeholders})`).run(...tenderIds);
    db.prepare(`DELETE FROM pipeline_audit_logs WHERE tender_id IN (${placeholders})`).run(...tenderIds);

    db.prepare(`
      UPDATE tenders 
      SET cached_dossiers = '[]',
          description = '',
          status_notes = '',
          matched_keywords = '[]',
          estimated_value = NULL,
          location = NULL,
          slimmed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(...tenderIds);
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
      AND (
        (closing_date IS NOT NULL AND julianday(closing_date) <= julianday('now', '-' || ? || ' days'))
        OR
        (closing_date IS NULL AND publish_date IS NOT NULL AND julianday(publish_date) <= julianday('now', '-90 days'))
      )
    ORDER BY closing_date ASC
    LIMIT ?
  `).all(graceDays, limit) as { id: string }[];
  return rows.map(r => r.id);
}

export function getAgedOutPassedTenderIds(retentionDays: number = 10, limit: number = 200): string[] {
  const rows = db.prepare(`
    SELECT id FROM tenders
    WHERE pipeline_status = 'Passed'
      AND slimmed_at IS NOT NULL
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

export function recordTenderSuppression(id: string, canonicalId: string, closingDate: string | null): void {
  db.prepare(`
    INSERT INTO deleted_tenders (id, canonical_id, closing_date)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deleted_at = CURRENT_TIMESTAMP,
      closing_date = COALESCE(excluded.closing_date, deleted_tenders.closing_date)
  `).run(id, canonicalId, closingDate);
}

/**
 * Returns true if a tender (by id or canonical id) is on the active suppression list. A hit
 * refreshes deleted_at, so a record stays alive for as long as the portal keeps listing the
 * tender, rather than lapsing and forcing a fresh download + OCR that may fail and let it back in.
 */
export function isTenderSuppressed(id: string, canonicalId: string): boolean {
  const activeClause = `
    (closing_date IS NULL
      OR julianday('now') <= julianday(closing_date, '+${SUPPRESSION_CLOSING_GRACE_DAYS} days')
      OR julianday('now') <= julianday(deleted_at, '+${SUPPRESSION_MIN_RETENTION_DAYS} days'))
  `;
  const hits = db.prepare(`
    SELECT id FROM deleted_tenders
    WHERE (id = ? OR canonical_id = ?) AND ${activeClause}
  `).all(id, canonicalId) as { id: string }[];
  if (hits.length === 0) return false;

  const touch = db.prepare('UPDATE deleted_tenders SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?');
  for (const h of hits) touch.run(h.id);
  return true;
}

/**
 * Removes suppression records that are no longer active (see isTenderSuppressed). Undated records
 * are kept: previously they expired 7 days after deletion, after which a tender the operator had
 * deleted would be re-imported into the Inbox.
 */
export function cleanExpiredDeletedTenderRecords(
  closingGraceDays: number = SUPPRESSION_CLOSING_GRACE_DAYS,
  minRetentionDays: number = SUPPRESSION_MIN_RETENTION_DAYS
): number {
  const info = db.prepare(`
    DELETE FROM deleted_tenders
    WHERE closing_date IS NOT NULL
      AND julianday('now') > julianday(closing_date, '+' || ? || ' days')
      AND julianday('now') > julianday(deleted_at, '+' || ? || ' days')
  `).run(closingGraceDays, minRetentionDays);
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
  const embeddingBuf = serializeEmbedding(
    computeFastSemanticEmbedding(buildTenderEmbeddingText({ title: nextTitle, organization: nextOrg, description: nextDesc }))
  );

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

  return getTenderById(id);
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

  return getTenderById(id)!;
}
