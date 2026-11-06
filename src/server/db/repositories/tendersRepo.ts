import { db, safeJsonParse } from '../connection.js';
import { Tender } from '../../../types.js';
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
  status?: string;
  search?: string;
  bookmarkedOnly?: boolean;
  corrigendumOnly?: boolean;
  unreadOnly?: boolean;
}): Tender[] {
  let query = 'SELECT * FROM tenders WHERE 1=1';
  const params: any[] = [];

  if (filters?.status && filters.status !== 'All') {
    query += ' AND pipeline_status = ?';
    params.push(filters.status);
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
    db.prepare(`
      UPDATE tenders 
      SET pipeline_status = ?, status_notes = COALESCE(?, status_notes), updated_at = CURRENT_TIMESTAMP
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
