import { db, safeJsonParse } from '../connection.js';
import { DomainTrack, CorrigendumLog } from '../../../shared/types.js';
import { containsKeyword, applyDocumentScopeToTracks } from '../../scrapers/trackMatcher.js';
import {
  buildTrackEmbeddingText,
  buildTenderEmbeddingText,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding,
  EMBEDDING_BLOB_BYTES,
  MINILM_BLOB_HEADER_HEX
} from '../../services/embeddingService.js';

export interface TrackEmbeddingBackfillRow {
  id: string;
  name: string;
  positive_keywords: string;
  embedding: Buffer | null;
}

/** Tracks whose stored embedding is missing, legacy-untagged, or not in the MiniLM space. */
export function getTracksNeedingModelEmbedding(): TrackEmbeddingBackfillRow[] {
  return db.prepare(`
    SELECT id, name, positive_keywords, embedding FROM domain_tracks
    WHERE embedding IS NULL
       OR length(embedding) <> ?
       OR hex(substr(embedding, 1, 4)) <> ?
  `).all(EMBEDDING_BLOB_BYTES, MINILM_BLOB_HEADER_HEX) as TrackEmbeddingBackfillRow[];
}

/** Stores a re-computed track embedding only if the track is unchanged since it was read. */
export function setTrackEmbeddingIfUnchanged(row: TrackEmbeddingBackfillRow, blob: Buffer): boolean {
  const res = db.prepare(`
    UPDATE domain_tracks SET embedding = ?
    WHERE id = ? AND name IS ? AND positive_keywords IS ? AND embedding IS ?
  `).run(blob, row.id, row.name, row.positive_keywords, row.embedding);
  return res.changes > 0;
}

export function getAllDomainTracks(): DomainTrack[] {
  const rows = db.prepare('SELECT * FROM domain_tracks ORDER BY name ASC').all() as any[];
  return rows.map(r => {
    const { embedding, ...rest } = r;
    return {
      ...rest,
      positive_keywords: safeJsonParse(r.positive_keywords, []),
      negative_keywords: safeJsonParse(r.negative_keywords, [])
    };
  });
}

export function saveDomainTrack(track: { id?: string; name: string; positive_keywords: string[]; negative_keywords: string[]; is_active?: number }) {
  const id = track.id || 'track-' + Date.now();
  const existingById = track.id
    ? (db.prepare('SELECT id, name, positive_keywords, embedding FROM domain_tracks WHERE id = ?').get(track.id) as TrackEmbeddingBackfillRow | undefined)
    : undefined;
  const existingForEmbedding = existingById || (
    db.prepare('SELECT id, name, positive_keywords, embedding FROM domain_tracks WHERE name = ?').get(track.name) as TrackEmbeddingBackfillRow | undefined
  );

  const posJson = JSON.stringify(track.positive_keywords);
  const preserveEmbedding =
    existingForEmbedding &&
    existingForEmbedding.embedding &&
    existingForEmbedding.name === track.name &&
    existingForEmbedding.positive_keywords === posJson;

  const trackText = buildTrackEmbeddingText({
    name: track.name,
    positive_keywords: track.positive_keywords || []
  });
  const embeddingBuf = preserveEmbedding
    ? existingForEmbedding.embedding!
    : serializeEmbedding(computeFastSemanticEmbedding(trackText));

  if (existingById) {
    db.prepare(`
      UPDATE domain_tracks
      SET name = ?, positive_keywords = ?, negative_keywords = ?, is_active = ?, embedding = ?
      WHERE id = ?
    `).run(track.name, posJson, JSON.stringify(track.negative_keywords), track.is_active ?? 1, embeddingBuf, id);
  } else {
    db.prepare(`
      INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        positive_keywords = excluded.positive_keywords,
        negative_keywords = excluded.negative_keywords,
        is_active = excluded.is_active,
        embedding = excluded.embedding
    `).run(id, track.name, posJson, JSON.stringify(track.negative_keywords), track.is_active ?? 1, embeddingBuf);
  }

  // Re-evaluate tenders against tracks when track rules change
  reScoreTendersAgainstTracks();
  return id;
}

export function deleteDomainTrack(id: string) {
  db.prepare('DELETE FROM domain_tracks WHERE id = ?').run(id);
  reScoreTendersAgainstTracks();
  return true;
}

export function reScoreTendersAgainstTracks() {
  const rawTracks = db.prepare('SELECT * FROM domain_tracks WHERE is_active = 1 ORDER BY name ASC').all() as any[];
  const tracks = rawTracks.map(r => ({
    ...r,
    positive_keywords: safeJsonParse<string[]>(r.positive_keywords, []),
    negative_keywords: safeJsonParse<string[]>(r.negative_keywords, []),
    trackText: buildTrackEmbeddingText({
      name: r.name,
      positive_keywords: safeJsonParse<string[]>(r.positive_keywords, [])
    })
  }));

  const tenders = db.prepare('SELECT id, title, description, organization, reference_no, extracted_text, embedding, portal_id, pipeline_status, is_bookmarked, ingestion_status FROM tenders').all() as any[];

  const updateStmt = db.prepare(`
    UPDATE tenders SET domain_tracks = ?, matched_keywords = ?, match_score = ?, semantic_score = ?, embedding = COALESCE(embedding, ?), ingestion_status = ? WHERE id = ?
  `);

  const updateTx = db.transaction(() => {
    for (const tender of tenders) {
      const combinedText = `${tender.title} ${tender.description || ''} ${tender.organization} ${tender.reference_no || ''}`.toLowerCase();
      const tenderSemanticText = buildTenderEmbeddingText(tender);
      const tenderEmbedBuf = tender.embedding || serializeEmbedding(computeFastSemanticEmbedding(tenderSemanticText));

      const matchedTracks: string[] = [];
      const exactKeywords: string[] = [];
      const semanticTags: string[] = [];
      const semanticDiscoveryScores: number[] = [];
      let maxSemanticSim = 0;

      for (const track of tracks) {
        // Stage 1: Hard Negative Keyword Gate (AI never overrides negative keywords)
        const hasNegative = track.negative_keywords.some((neg: string) => containsKeyword(combinedText, neg));
        if (hasNegative) continue;

        // Stage 2: Exact Positive Keyword Check
        const hitKeywords = track.positive_keywords.filter((pos: string) => containsKeyword(combinedText, pos));

        // Stage 3: Semantic Vector Similarity
        const sim = track.positive_keywords.length > 0
          ? computeTextSemanticSimilarity(tenderSemanticText, track.trackText, tenderEmbedBuf, track.embedding)
          : 0;
        if (sim > maxSemanticSim) maxSemanticSim = sim;

        if (hitKeywords.length > 0) {
          matchedTracks.push(track.name);
          exactKeywords.push(...hitKeywords);
        } else if (track.positive_keywords.length > 0 && sim >= 0.58) {
          matchedTracks.push(track.name);
          const pct = Math.round(sim * 100);
          semanticTags.push(`✨ Semantic (${pct}%)`);
          semanticDiscoveryScores.push(Math.min(85, Math.max(35, pct)));
        }
      }

      let allMatchedKeywords = exactKeywords.length > 0
        ? Array.from(new Set(exactKeywords))
        : Array.from(new Set(semanticTags));

      let matchScore = 30;
      if (exactKeywords.length > 0) {
        matchScore = Math.min(100, Math.max(30, exactKeywords.length * 20));
      } else if (semanticDiscoveryScores.length > 0) {
        matchScore = Math.max(...semanticDiscoveryScores);
      }

      if (tender.extracted_text && tender.extracted_text.trim()) {
        const rescored = applyDocumentScopeToTracks(
          { matchedTracks, matchedKeywords: allMatchedKeywords },
          { title: tender.title, organization: tender.organization, description: tender.description, referenceNo: tender.reference_no },
          tender.extracted_text,
          tracks
        );
        if (rescored.tracks.length > 0) {
          matchedTracks.splice(0, matchedTracks.length, ...rescored.tracks);
          allMatchedKeywords = rescored.keywords;
          if (matchScore < 30) matchScore = 30;
        }
      }

      let nextIngestionStatus = tender.ingestion_status;
      if (tender.ingestion_status === 'awaiting_scope' && matchedTracks.length > 0) {
        nextIngestionStatus = 'ready';
      } else if (
        (tender.ingestion_status ?? 'ready') === 'ready' &&
        matchedTracks.length === 0 &&
        tender.pipeline_status === 'New Opportunity' &&
        !tender.is_bookmarked &&
        tender.portal_id !== 'manual'
      ) {
        nextIngestionStatus = 'awaiting_scope';
      }

      updateStmt.run(
        JSON.stringify(matchedTracks),
        JSON.stringify(allMatchedKeywords),
        matchScore,
        Math.round(maxSemanticSim * 1000) / 1000,
        tenderEmbedBuf,
        nextIngestionStatus,
        tender.id
      );
    }
  });

  updateTx();
}

export function getUnacknowledgedCorrigenda(): (CorrigendumLog & { tender_title: string; portal_name: string })[] {
  return db.prepare(`
    SELECT c.*, t.title as tender_title, t.portal_name
    FROM corrigendum_logs c
    JOIN tenders t ON c.tender_id = t.id
    WHERE c.is_acknowledged = 0
    ORDER BY c.detected_at DESC
  `).all() as any[];
}

export function acknowledgeCorrigendum(id: string) {
  const log = db.prepare('SELECT tender_id FROM corrigendum_logs WHERE id = ?').get(id) as { tender_id: string } | undefined;
  if (!log) return false;

  const updateTx = db.transaction(() => {
    db.prepare('UPDATE corrigendum_logs SET is_acknowledged = 1 WHERE id = ?').run(id);

    // If no other unacknowledged corrigenda remain for this tender, clear tender flag
    const remaining = (db.prepare('SELECT COUNT(*) as c FROM corrigendum_logs WHERE tender_id = ? AND is_acknowledged = 0').get(log.tender_id) as any).c;
    if (remaining === 0) {
      db.prepare('UPDATE tenders SET has_corrigendum = 0 WHERE id = ?').run(log.tender_id);
    }
  });

  updateTx();
  return true;
}
