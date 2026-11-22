import type Database from 'better-sqlite3';
import { db, safeJsonParse } from '../connection.js';
import { Tender, BidBrief } from '../../../shared/types.js';
import { normalizeReferenceNo } from '../../domain/referenceNo.js';
import {
  ACTIVE_UNEXPIRED_SQL,
  NOT_STAGING_SQL,
  type IngestionStatus
} from './tenderLifecycleRepo.js';
import {
  buildTenderEmbeddingText,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding,
  EMBEDDING_BLOB_BYTES,
  MINILM_BLOB_HEADER_HEX
} from '../../domain/embeddingService.js';

export function setTenderIngestionStatus(id: string, status: IngestionStatus): boolean {
  return db.prepare('UPDATE tenders SET ingestion_status = ? WHERE id = ?').run(status, id).changes > 0;
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
  const { rowid: _rowid, embedding, extracted_text: _extractedText, ...rest } = row;
  return {
    ...rest,
    secondary_sources: safeJsonParse(row.secondary_sources, []),
    domain_tracks: safeJsonParse(row.domain_tracks, []),
    matched_keywords: safeJsonParse(row.matched_keywords, []),
    cached_dossiers: safeJsonParse(row.cached_dossiers, []),
    attachment_urls: safeJsonParse(row.attachment_urls, []),
    bid_brief: safeJsonParse<BidBrief | null>(row.bid_brief, null)
  };
}

/**
 * Converts a raw operator search string into a safe FTS5 prefix query (`"tok1"* "tok2"*`).
 * Strips FTS5 syntax characters (`"`, `-`, `*`, `(`, `)`, `:`, `+`, etc.) so punctuation-heavy
 * inputs never trigger SQLite `fts5: syntax error`. Returns `null` when no alphanumeric tokens exist.
 */
export function buildFts5PrefixQuery(rawSearch: string): string | null {
  const tokens = rawSearch.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 16)
    .map(tok => `"${tok}"*`)
    .join(' ');
}

const MAX_EXTRACTED_TEXT_CHARS = 120_000;

/**
 * Stores or appends normalized extracted document text on `tenders.extracted_text` (automatically
 * indexed by `tenders_fts` triggers for full-text Inbox search). Skips duplicate chunks and caps
 * per-tender text at 120 KB so multi-document tenders stay compact.
 */
export function appendTenderExtractedText(id: string, text: string): boolean {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;

  const existingRow = db.prepare('SELECT extracted_text FROM tenders WHERE id = ?').get(id) as { extracted_text?: string | null } | undefined;
  if (!existingRow) return false;

  const existing = existingRow.extracted_text || '';
  const signature = cleaned.slice(0, 200);
  if (signature.length >= 20 && existing.includes(signature)) {
    return false;
  }

  const combined = existing
    ? `${existing}\n${cleaned}`.slice(0, MAX_EXTRACTED_TEXT_CHARS)
    : cleaned.slice(0, MAX_EXTRACTED_TEXT_CHARS);

  if (combined === existing) return false;
  return db.prepare('UPDATE tenders SET extracted_text = ? WHERE id = ?').run(combined, id).changes > 0;
}

export function hasTenderExtractedText(id: string): boolean {
  const row = db.prepare(`SELECT length(COALESCE(extracted_text, '')) AS len FROM tenders WHERE id = ?`).get(id) as
    | { len: number }
    | undefined;
  return Boolean(row && row.len > 0);
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
  let query = `SELECT rowid, * FROM tenders WHERE ${NOT_STAGING_SQL}`;
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
    query += ` AND ${ACTIVE_UNEXPIRED_SQL}`;
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

    const ftsQuery = buildFts5PrefixQuery(rawSearch);
    const ftsMatchedRowIds = new Set<number>();
    if (ftsQuery) {
      try {
        const hits = db.prepare('SELECT rowid FROM tenders_fts WHERE tenders_fts MATCH ?').all(ftsQuery) as { rowid: number }[];
        for (const h of hits) ftsMatchedRowIds.add(h.rowid);
      } catch {
        // Safe fallback to substring/semantic filters on exotic inputs
      }
    }

    rows = rows.filter(row => {
      if (typeof row.rowid === 'number' && ftsMatchedRowIds.has(row.rowid)) {
        return true;
      }

      const titleMatch = (row.title || '').toLowerCase().includes(lowerSearch);
      const orgMatch = (row.organization || '').toLowerCase().includes(lowerSearch);
      const refMatch = (row.reference_no || '').toLowerCase().includes(lowerSearch);
      const portalMatch = (row.portal_name || '').toLowerCase().includes(lowerSearch);
      const descMatch = (row.description || '').toLowerCase().includes(lowerSearch);
      const docMatch = (row.extracted_text || '').toLowerCase().includes(lowerSearch);

      if (titleMatch || orgMatch || refMatch || portalMatch || descMatch || docMatch) {
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

  return attachDocJobCounts(rows.map(mapTenderRow));
}

export function getTenderById(id: string): Tender | null {
  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id) as any;
  if (!row) return null;
  return attachDocJobCounts([mapTenderRow(row)])[0];
}

function attachDocJobCounts(tenders: Tender[]): Tender[] {
  if (tenders.length === 0) return tenders;
  const countsByTender = new Map<string, { pending: number; processing: number; done: number; failed: number }>();

  try {
    if (tenders.length === 1) {
      const rows = db.prepare(`
        SELECT status, COUNT(*) AS n FROM document_ingest_jobs WHERE tender_id = ? GROUP BY status
      `).all(tenders[0].id) as { status: string; n: number }[];
      if (rows.length > 0) {
        const c = { pending: 0, processing: 0, done: 0, failed: 0 };
        for (const r of rows) {
          if (r.status in c) (c as any)[r.status] = r.n;
        }
        countsByTender.set(tenders[0].id, c);
      }
    } else {
      const rows = db.prepare(`
        SELECT tender_id, status, COUNT(*) AS n FROM document_ingest_jobs GROUP BY tender_id, status
      `).all() as { tender_id: string; status: string; n: number }[];
      for (const r of rows) {
        let c = countsByTender.get(r.tender_id);
        if (!c) {
          c = { pending: 0, processing: 0, done: 0, failed: 0 };
          countsByTender.set(r.tender_id, c);
        }
        if (r.status in c) (c as any)[r.status] = r.n;
      }
    }
  } catch {
    return tenders;
  }

  return tenders.map(t => {
    const c = countsByTender.get(t.id);
    if (!c) return t;
    return {
      ...t,
      doc_jobs_pending: c.pending,
      doc_jobs_processing: c.processing,
      doc_jobs_done: c.done,
      doc_jobs_failed: c.failed
    };
  });
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
      AND ${ACTIVE_UNEXPIRED_SQL}
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
    deadline_source?: string | null;
    deadline_confidence?: string | null;
    bid_brief?: BidBrief | null;
  }>
): Tender | null {
  const existing = getTenderById(id);
  if (!existing) return null;

  const nextTitle = fields.title !== undefined ? fields.title : existing.title;
  const nextOrg = fields.organization !== undefined ? fields.organization : existing.organization;
  const nextDesc = fields.description !== undefined ? fields.description : existing.description;

  const nextDeadlineSource = fields.deadline_source !== undefined
    ? fields.deadline_source
    : (fields.closing_date !== undefined && fields.closing_date !== existing.closing_date)
      ? (fields.closing_date ? 'manual' : null)
      : existing.deadline_source;

  const nextDeadlineConfidence = fields.deadline_confidence !== undefined
    ? fields.deadline_confidence
    : (fields.closing_date !== undefined && fields.closing_date !== existing.closing_date)
      ? (fields.closing_date ? 'high' : null)
      : existing.deadline_confidence;

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
        deadline_source = ?,
        deadline_confidence = ?,
        estimated_value = ?,
        description = ?,
        direct_url = ?,
        location = ?,
        cached_dossiers = ?,
        has_corrigendum = ?,
        bid_brief = ?,
        embedding = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    nextTitle,
    nextOrg,
    fields.reference_no !== undefined ? fields.reference_no : existing.reference_no,
    fields.closing_date !== undefined ? fields.closing_date : existing.closing_date,
    fields.closing_date_formatted !== undefined ? fields.closing_date_formatted : existing.closing_date_formatted,
    nextDeadlineSource,
    nextDeadlineConfidence,
    fields.estimated_value !== undefined ? fields.estimated_value : existing.estimated_value,
    nextDesc,
    fields.direct_url !== undefined ? fields.direct_url : existing.direct_url,
    fields.location !== undefined ? fields.location : existing.location,
    fields.cached_dossiers !== undefined ? JSON.stringify(fields.cached_dossiers) : JSON.stringify(existing.cached_dossiers || []),
    fields.has_corrigendum !== undefined ? fields.has_corrigendum : existing.has_corrigendum,
    fields.bid_brief !== undefined
      ? (fields.bid_brief ? JSON.stringify(fields.bid_brief) : null)
      : (existing.bid_brief ? JSON.stringify(existing.bid_brief) : null),
    embeddingBuf,
    id
  );
  if (fields.reference_no !== undefined) syncReferenceNorm(id);

  return getTenderById(id);
}

/**
 * Lookup map of known tender links/titles for a portal (used by pagination early-stop in crawlerEngine).
 */
export function getKnownTenderMapForPortal(portalId: string): Map<string, { closing_date: string | null; has_corrigendum: number }> {
  const rows = db.prepare(`
    SELECT direct_url, title, closing_date, has_corrigendum
    FROM tenders
    WHERE portal_id = ?
  `).all(portalId) as { direct_url: string | null; title: string; closing_date: string | null; has_corrigendum: number }[];

  const map = new Map<string, { closing_date: string | null; has_corrigendum: number }>();
  for (const r of rows) {
    const key = (r.direct_url || r.title || '').toLowerCase();
    if (key) {
      map.set(key, { closing_date: r.closing_date ?? null, has_corrigendum: Number(r.has_corrigendum || 0) });
    }
  }
  return map;
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
export function backfillReferenceNorms(database: Database.Database = db): { normalized: number; cleared: number } {
  const rows = database.prepare('SELECT id, reference_no FROM tenders WHERE reference_no IS NOT NULL').all() as { id: string; reference_no: string }[];
  let normalized = 0;
  let cleared = 0;
  const setNorm = database.prepare('UPDATE tenders SET reference_norm = ? WHERE id = ?');
  const clear = database.prepare('UPDATE tenders SET reference_no = NULL, reference_norm = NULL WHERE id = ?');
  database.transaction(() => {
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
      deadline_source, deadline_confidence,
      estimated_value, location, description, cached_dossiers, has_corrigendum, pipeline_status, embedding
    ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'New Opportunity', ?)
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
    input.closing_date ? 'manual' : null,
    input.closing_date ? 'high' : null,
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
export function findTendersByReferenceNorm(referenceNorm: string): DedupCandidateRow[] {
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
 * Similarity-dedup candidates from OTHER portals:
 * - Dated incoming candidate: other-portal dated tenders within ±1.5 days OR recent undated tenders (last 30 days).
 * - Undated incoming candidate: other-portal undated tenders (last 14 days) OR recent dated open tenders (last 30 days).
 * Rows of the same portal are never similarity candidates (docs/16 A3, DED-3).
 */
export function findDedupCandidates(
  closingDate?: string | null,
  excludePortalId?: string | null,
  options?: { includeAwaitingScope?: boolean }
): DedupCandidateRow[] {
  const portalClause = excludePortalId ? 'AND portal_id != ?' : '';
  const portalParams = excludePortalId ? [excludePortalId] : [];
  const scopeClause = options?.includeAwaitingScope
    ? ''
    : "AND COALESCE(ingestion_status, 'ready') != 'awaiting_scope'";

  if (closingDate) {
    return db.prepare(`
      SELECT id, canonical_id, title, organization, closing_date, embedding, portal_id
      FROM tenders
      WHERE (
        (closing_date IS NOT NULL AND ABS(julianday(closing_date) - julianday(?)) <= 1.5)
        OR (closing_date IS NULL AND created_at >= datetime('now', '-30 days'))
      )
      ${scopeClause}
      ${portalClause}
    `).all(closingDate, ...portalParams) as DedupCandidateRow[];
  }
  return db.prepare(`
    SELECT id, canonical_id, title, organization, closing_date, embedding, portal_id
    FROM tenders
    WHERE (
      (closing_date IS NULL AND created_at >= datetime('now', '-14 days'))
      OR (closing_date IS NOT NULL AND created_at >= datetime('now', '-30 days') AND julianday(closing_date) >= julianday('now', '-2 days'))
    )
    ${scopeClause}
    ${portalClause}
  `).all(...portalParams) as DedupCandidateRow[];
}

export function getAllTenderDossierRows(): { id: string; cached_dossiers: string }[] {
  return db.prepare('SELECT id, cached_dossiers FROM tenders').all() as { id: string; cached_dossiers: string }[];
}

export interface TenderDossierMigrationRow {
  id: string;
  portal_id: string;
  reference_no: string | null;
  title: string;
  cached_dossiers: string;
}

export function getAllTendersWithDossiers(): TenderDossierMigrationRow[] {
  return db.prepare(`
    SELECT id, portal_id, reference_no, title, cached_dossiers
    FROM tenders
    WHERE cached_dossiers IS NOT NULL AND cached_dossiers != '[]'
  `).all() as TenderDossierMigrationRow[];
}

export interface EarlierDeadlineReviewRow {
  id: string;
  closing_date: string | null;
  deadline_source: string | null;
  deadline_confidence: string | null;
  review_reason: string | null;
  extracted_text: string;
}

export function getEarlierDeadlineReviewTenders(): EarlierDeadlineReviewRow[] {
  return db.prepare(`
    SELECT id, closing_date, deadline_source, deadline_confidence, review_reason, extracted_text
    FROM tenders
    WHERE needs_review = 1
      AND review_reason LIKE 'deadline_moved_earlier:%'
      AND extracted_text IS NOT NULL
      AND extracted_text != ''
  `).all() as EarlierDeadlineReviewRow[];
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
export function removeSelfSecondarySources(database: Database.Database = db): number {
  const rows = database.prepare(`SELECT id, portal_name, secondary_sources FROM tenders WHERE secondary_sources IS NOT NULL AND secondary_sources != '[]'`).all() as { id: string; portal_name: string; secondary_sources: string }[];
  let changed = 0;
  const update = database.prepare('UPDATE tenders SET secondary_sources = ? WHERE id = ?');
  database.transaction(() => {
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

