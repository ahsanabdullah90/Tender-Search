import { PORTAL_DEFINITIONS } from './portalList.js';
import { buildTrackEmbeddingText, computeTextSemanticSimilarity } from '../services/embeddingService.js';

/**
 * Track matching: decides which domain tracks a tender belongs to (keywords first, then semantic
 * similarity) and re-scores tracks once a tender's documents have been read. Kept separate from
 * the crawler so the document worker and on-demand actions can use it without import cycles.
 */

export interface MatchableItem {
  title: string;
  organization: string;
  description?: string;
  referenceNo?: string;
  directUrl?: string;
}

const DEFAULT_PORTAL_NAMES = new Set(PORTAL_DEFINITIONS.map(p => p.name.toLowerCase()));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const keywordCache = new Map<string, RegExp>();

/**
 * True when `keyword` occurs in `text` as whole words: "car" does not match "care", "it" does not
 * match "audit", but "solar" matches "Solar-powered" and "civil works" matches "civil  works".
 * A trailing plural "s"/"es" is accepted (docs/15 F7).
 */
export function containsKeyword(text: string, keyword: string): boolean {
  const kw = String(keyword || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!kw) return false;
  let re = keywordCache.get(kw);
  if (!re) {
    const body = kw.split(' ').map(escapeRegExp).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu');
    keywordCache.set(kw, re);
  }
  return re.test(text);
}

/**
 * Matches scraped tender against active domain tracks using the Hybrid Keyword + Semantic Engine
 */
export function matchTracks(
  item: MatchableItem,
  activeTracks: any[]
): { matchedTracks: string[]; matchedKeywords: string[]; matchScore: number; semanticScore?: number } {
  // Exclude generic portal name from keyword matching to prevent 100% false-positive matches on education/skills portals
  const orgLower = (item.organization || '').toLowerCase();
  const orgForMatching = DEFAULT_PORTAL_NAMES.has(orgLower) ? '' : orgLower;
  const combinedText = `${item.title} ${item.description || ''} ${orgForMatching} ${item.referenceNo || ''}`.toLowerCase();
  const tenderSemanticText = `${item.title} ${item.description || ''} ${orgForMatching}`.trim();

  const matchedTracks: string[] = [];
  const exactKeywords: string[] = [];
  const semanticTags: string[] = [];
  const semanticDiscoveryScores: number[] = [];
  let maxSemanticSim = 0;

  for (const track of activeTracks) {
    // Stage 1: Hard Negative Keyword Gate (AI never overrides negative keywords)
    const hasNegative = track.negative_keywords?.some((neg: string) => containsKeyword(combinedText, neg));
    if (hasNegative) continue;

    const posKeywords: string[] = track.positive_keywords || [];
    if (posKeywords.length === 0) continue;

    // Stage 2: Exact Positive Keyword Check (whole words)
    const hitKeywords: string[] = [];
    for (const pos of posKeywords) {
      if (containsKeyword(combinedText, pos)) {
        hitKeywords.push(pos);
      }
    }

    // Stage 3: Semantic Vector Similarity
    const trackText = buildTrackEmbeddingText({ name: track.name, positive_keywords: posKeywords });
    const sim = computeTextSemanticSimilarity(tenderSemanticText, trackText);
    if (sim > maxSemanticSim) maxSemanticSim = sim;

    if (hitKeywords.length > 0) {
      matchedTracks.push(track.name);
      exactKeywords.push(...hitKeywords);
    } else if (sim >= 0.58) {
      matchedTracks.push(track.name);
      const pct = Math.round(sim * 100);
      semanticTags.push(`✨ Semantic (${pct}%)`);
      semanticDiscoveryScores.push(Math.min(85, Math.max(35, pct)));
    }
  }

  const matchedKeywords = exactKeywords.length > 0 ? exactKeywords : semanticTags;
  let matchScore = 0;
  if (matchedTracks.length > 0) {
    if (exactKeywords.length > 0) {
      matchScore = Math.min(100, Math.max(30, exactKeywords.length * 20));
    } else if (semanticDiscoveryScores.length > 0) {
      matchScore = Math.max(...semanticDiscoveryScores);
    }
  }

  return {
    matchedTracks,
    matchedKeywords,
    matchScore,
    semanticScore: Math.round(maxSemanticSim * 1000) / 1000
  };
}

/**
 * Re-scores a tender's tracks using the scope of work read from its documents (docs/13 §2.5).
 *  - A tender may GAIN tracks the document text matches.
 *  - It never loses a track matched by an exact keyword in the listing; a semantic-only track is
 *    dropped if it no longer matches once the document text is included.
 *  - A track's negative keyword found in the document text removes that track.
 * If every track would be removed, the original tracks are kept and `excludedBy` explains why,
 * so the caller can flag the tender for review instead of silently dropping it.
 */
export function applyDocumentScopeToTracks(
  base: { matchedTracks: string[]; matchedKeywords: string[] },
  item: MatchableItem,
  scopeText: string,
  activeTracks: any[]
): { tracks: string[]; keywords: string[]; excludedBy: string[]; changed: boolean } {
  const unchanged = { tracks: base.matchedTracks, keywords: base.matchedKeywords, excludedBy: [] as string[], changed: false };
  if (!scopeText || !scopeText.trim()) return unchanged;

  const withScope = matchTracks({ ...item, description: `${item.description || ''} ${scopeText}` }, activeTracks);
  const scopeLower = scopeText.toLowerCase();
  const listingText = `${item.title} ${item.description || ''} ${item.organization || ''} ${item.referenceNo || ''}`.toLowerCase();

  const tracks: string[] = [];
  const excludedBy: string[] = [];
  for (const track of activeTracks) {
    const inBase = base.matchedTracks.includes(track.name);
    const inScope = withScope.matchedTracks.includes(track.name);
    if (!inBase && !inScope) continue;
    const negative = (track.negative_keywords || []).find((n: string) => containsKeyword(scopeLower, String(n)));
    if (negative) {
      excludedBy.push(`${track.name} ("${negative}")`);
      continue;
    }
    const keywordMatchedInListing = inBase && (track.positive_keywords || []).some((k: string) => containsKeyword(listingText, String(k)));
    if (keywordMatchedInListing || inScope) tracks.push(track.name);
  }
  // Tracks from the listing that are no longer active are left as they were.
  for (const name of base.matchedTracks) {
    if (!activeTracks.some(t => t.name === name) && !tracks.includes(name)) tracks.push(name);
  }

  if (tracks.length === 0) return { ...unchanged, excludedBy };
  const keywords = Array.from(new Set([...base.matchedKeywords, ...withScope.matchedKeywords]));
  const changed = tracks.length !== base.matchedTracks.length || tracks.some(t => !base.matchedTracks.includes(t));
  return { tracks, keywords, excludedBy, changed };
}
