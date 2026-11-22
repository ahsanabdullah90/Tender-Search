import { findTendersByReferenceNorm, findDedupCandidates } from '../db/index.js';
import { computeTextSemanticSimilarity } from './embeddingService.js';

/**
 * Calculates Dice's coefficient (Bigram similarity) between two strings.
 * Returns a value between 0.0 and 1.0.
 */
export function calculateStringSimilarity(str1: string, str2: string): number {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);

  if (s1.length < 2 || s2.length < 2) return 0.0;
  if (s1 === s2) return 1.0;

  const getBigrams = (str: string) => {
    const bigrams = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);

  let intersection = 0;
  for (const [bigram, count1] of b1.entries()) {
    const count2 = b2.get(bigram);
    if (count2) {
      intersection += Math.min(count1, count2);
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return (2.0 * intersection) / total;
}

export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateMatchResult {
  isDuplicate: boolean;
  canonicalId?: string;
  matchedTenderId?: string;
  similarity: number;
  /** How the match was made; only a 'reference' match may change the stored deadline (docs/16 A4). */
  tier?: 'reference' | 'lexical' | 'semantic';
}

export { isValidReferenceNo, normalizeReferenceNo } from './referenceNo.js';
import { normalizeReferenceNo } from './referenceNo.js';

/** Words that never tell two tenders apart. */
const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'or', 'its', 'is',
  'tender', 'tenders', 'notice', 'nit', 'rfp', 'rfq', 'eoi', 'ifb', 'request', 'proposal', 'proposals',
  'invitation', 'bid', 'bids', 'bidding', 'procurement', 'supply', 'provision', 'hiring', 'purchase',
  'services', 'service', 'firm', 'firms', 'document', 'documents', 'advertisement', 'quotation', 'quotations',
  'corrigendum', 'addendum', 'extension', 'reg', 'regarding', 'govt', 'government', 'pakistan', 'pvt', 'ltd'
]);

function contentTokens(title: string): Set<string> {
  return new Set(normalizeText(title).split(' ').filter(t => t && !TITLE_STOP_WORDS.has(t)));
}

/**
 * True when two titles follow the same wording but each swaps in its own one or two content words
 * ("Supply of Laptops" / "Supply of Printers", "... Lahore Office" / "... Multan Office"): such
 * titles are different tenders however similar they score, lexically (0.86-0.93) or with the fast
 * vectors (0.93). A title whose words are all contained in the other ("Supply of Laptops" vs
 * "Supply of Laptops for PSDF") is not distinguished, nor is a full rewording, where each title has
 * three or more words of its own and only the semantic tier can judge (docs/16 A3).
 */
export function titlesAreDistinguishable(a: string, b: string): boolean {
  // Different lot, package, phase, or part identifiers are separate contracts and must stay distinct
  const lotPattern = /\b(?:lot|package|pkg|phase|part)\s*[-:]?\s*([0-9a-z]+)\b/gi;
  const lotsA = new Set([...a.matchAll(lotPattern)].map(m => m[1].toLowerCase()));
  const lotsB = new Set([...b.matchAll(lotPattern)].map(m => m[1].toLowerCase()));
  if (lotsA.size > 0 && lotsB.size > 0 && [...lotsA].some(l => !lotsB.has(l))) {
    return true;
  }

  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const onlyA = [...ta].filter(t => !tb.has(t)).length;
  const onlyB = [...tb].filter(t => !ta.has(t)).length;
  return onlyA > 0 && onlyB > 0 && Math.max(onlyA, onlyB) <= 2;
}

function closingWithin(a?: string | null, b?: string | null, days: number = 1.5): boolean {
  if (!a || !b) return false;
  const ma = new Date(a).getTime();
  const mb = new Date(b).getTime();
  return !isNaN(ma) && !isNaN(mb) && Math.abs(ma - mb) <= days * 86400000;
}

/**
 * Checks if a tender matches an existing opportunity from ANOTHER source. Within one portal a
 * tender's identity is its id (portal + reference + title + link), checked by the caller before
 * this function, so similarity is never used to merge two rows of the same portal (docs/16 A3).
 *
 * 1. Reference number: same normalised reference, plus one corroborating signal (organisation or
 *    title similarity >= 0.5, or deadlines within 1.5 days), so a shared pseudo-reference alone
 *    never merges (docs/15 F3).
 * 2. Lexical: title Dice similarity >= 0.85, deadlines within 1.5 days (or both undated and recent),
 *    and the titles are not distinguishable.
 * 3. Semantic: title similarity >= 0.88 with related organisations, same date rule, not distinguishable.
 */
export function findCanonicalMatch(candidate: {
  referenceNo?: string | null;
  title: string;
  organization: string;
  closingDate?: string | null;
  embedding?: Buffer | Uint8Array | null;
  portalId?: string | null;
  includeAwaitingScope?: boolean;
}): DuplicateMatchResult {
  const portalId = candidate.portalId ?? null;

  // Tier 1: reference number, corroborated
  const norm = normalizeReferenceNo(candidate.referenceNo);
  if (norm) {
    // A long structured reference ("NUST/IT-2026/01", "TSE-2627111220673") identifies a tender on
    // its own; a short one ("VR-4345S") needs a second signal before it may merge two tenders.
    const strongReference = norm.length >= 8 && (norm.match(/\d/g) || []).length >= 2 && (norm.match(/\p{L}/gu) || []).length >= 2;
    for (const existing of findTendersByReferenceNorm(norm, portalId)) {
      const corroborated = strongReference ||
        calculateStringSimilarity(candidate.organization, existing.organization) >= 0.5 ||
        calculateStringSimilarity(candidate.title, existing.title) >= 0.5 ||
        closingWithin(candidate.closingDate, existing.closing_date);
      if (corroborated) {
        return { isDuplicate: true, canonicalId: existing.canonical_id, matchedTenderId: existing.id, similarity: 1.0, tier: 'reference' };
      }
    }
  }

  // Tiers 2-3: candidates from other portals with a nearby deadline, undated-recent, or undated-vs-dated
  const candidates = findDedupCandidates(candidate.closingDate, portalId, {
    includeAwaitingScope: candidate.includeAwaitingScope
  });
  let bestMatch: DuplicateMatchResult = { isDuplicate: false, similarity: 0 };

  for (const existing of candidates) {
    if (titlesAreDistinguishable(candidate.title, existing.title)) continue;

    const mixedDateStatus = Boolean(candidate.closingDate) !== Boolean(existing.closing_date);
    const lexicalSim = calculateStringSimilarity(candidate.title, existing.title);
    const orgSim = calculateStringSimilarity(candidate.organization, existing.organization);

    if (mixedDateStatus) {
      const meetsMixedDateThreshold =
        (lexicalSim >= 0.90 && orgSim >= 0.50) ||
        lexicalSim >= 0.94;
      if (meetsMixedDateThreshold && lexicalSim > bestMatch.similarity) {
        bestMatch = {
          isDuplicate: true,
          canonicalId: existing.canonical_id,
          matchedTenderId: existing.id,
          similarity: lexicalSim,
          tier: 'lexical'
        };
      }
      continue;
    }

    if (lexicalSim >= 0.85 && lexicalSim > bestMatch.similarity) {
      bestMatch = { isDuplicate: true, canonicalId: existing.canonical_id, matchedTenderId: existing.id, similarity: lexicalSim, tier: 'lexical' };
      continue;
    }

    if (orgSim >= 0.50) {
      const semanticSim = computeTextSemanticSimilarity(candidate.title, existing.title, candidate.embedding, existing.embedding);
      if (semanticSim >= 0.88 && semanticSim > bestMatch.similarity) {
        bestMatch = { isDuplicate: true, canonicalId: existing.canonical_id, matchedTenderId: existing.id, similarity: semanticSim, tier: 'semantic' };
      }
    }
  }

  return bestMatch;
}
