import { db, safeJsonParse } from '../connection.js';
import { DomainTrack, CorrigendumLog } from '../../../types.js';
import {
  buildTrackEmbeddingText,
  buildTenderEmbeddingText,
  computeFastSemanticEmbedding,
  computeTextSemanticSimilarity,
  serializeEmbedding
} from '../../embeddingService.js';

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
  const existing = track.id ? db.prepare('SELECT id FROM domain_tracks WHERE id = ?').get(track.id) : null;

  const trackText = buildTrackEmbeddingText({
    name: track.name,
    positive_keywords: track.positive_keywords || []
  });
  const embeddingBuf = serializeEmbedding(computeFastSemanticEmbedding(trackText));

  if (existing) {
    db.prepare(`
      UPDATE domain_tracks
      SET name = ?, positive_keywords = ?, negative_keywords = ?, is_active = ?, embedding = ?
      WHERE id = ?
    `).run(track.name, JSON.stringify(track.positive_keywords), JSON.stringify(track.negative_keywords), track.is_active ?? 1, embeddingBuf, id);
  } else {
    db.prepare(`
      INSERT INTO domain_tracks (id, name, positive_keywords, negative_keywords, is_active, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        positive_keywords = excluded.positive_keywords,
        negative_keywords = excluded.negative_keywords,
        is_active = excluded.is_active,
        embedding = excluded.embedding
    `).run(id, track.name, JSON.stringify(track.positive_keywords), JSON.stringify(track.negative_keywords), track.is_active ?? 1, embeddingBuf);
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

  const tenders = db.prepare('SELECT id, title, description, organization, reference_no, embedding FROM tenders').all() as any[];

  const updateStmt = db.prepare(`
    UPDATE tenders SET domain_tracks = ?, matched_keywords = ?, match_score = ?, semantic_score = ?, embedding = COALESCE(embedding, ?) WHERE id = ?
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
        const hasNegative = track.negative_keywords.some((neg: string) => combinedText.includes(neg.toLowerCase()));
        if (hasNegative) continue;

        // Stage 2: Exact Positive Keyword Check
        const hitKeywords = track.positive_keywords.filter((pos: string) => combinedText.includes(pos.toLowerCase()));

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

      const allMatchedKeywords = exactKeywords.length > 0
        ? Array.from(new Set(exactKeywords))
        : Array.from(new Set(semanticTags));

      let matchScore = 30;
      if (exactKeywords.length > 0) {
        matchScore = Math.min(100, Math.max(30, exactKeywords.length * 20));
      } else if (semanticDiscoveryScores.length > 0) {
        matchScore = Math.max(...semanticDiscoveryScores);
      }

      updateStmt.run(
        JSON.stringify(matchedTracks),
        JSON.stringify(allMatchedKeywords),
        matchScore,
        Math.round(maxSemanticSim * 1000) / 1000,
        tenderEmbedBuf,
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
