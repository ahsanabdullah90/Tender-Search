import { db } from './db.js';

/**
 * Calculates Dice's coefficient (Bigram similarity) between two strings.
 * Returns a value between 0.0 and 1.0.
 */
export function calculateStringSimilarity(str1: string, str2: string): number {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);

  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

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
  return total > 0 ? (2.0 * intersection) / total : 0;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateMatchResult {
  isDuplicate: boolean;
  canonicalId?: string;
  matchedTenderId?: string;
  similarity: number;
}

/**
 * Validates whether a string has the structural characteristics of a genuine
 * procurement reference number (contains at least one digit and not generic dictionary words).
 */
export function isValidReferenceNo(ref?: string | null): boolean {
  if (!ref) return false;
  const trimmed = ref.trim();
  if (trimmed.length < 4 || trimmed.length > 40) return false;

  // Must contain at least one digit (genuine procurement references almost universally contain numbers)
  if (!/\d/.test(trimmed)) return false;

  // Blacklist common generic terms that accidentally match regex
  const lower = trimmed.toLowerCase();
  const genericWords = ['tender', 'notice', 'procurement', 'tenders', 'quotation', 'corrigendum', 'advertisement', 'bidding'];
  if (genericWords.includes(lower)) return false;

  return true;
}

/**
 * Checks if a tender matches an existing active opportunity in the database.
 * Matches if:
 * 1. Normalized Reference Numbers match exactly (if valid genuine ref with digits)
 * OR
 * 2. Title + Organization similarity >= 0.85 AND closing dates within ±1.5 days (or both null)
 */
export function findCanonicalMatch(candidate: {
  referenceNo?: string | null;
  title: string;
  organization: string;
  closingDate?: string | null;
}): DuplicateMatchResult {
  // 1. Exact Reference Number check (if valid genuine ref number with numbers)
  if (isValidReferenceNo(candidate.referenceNo)) {
    const rawRef = candidate.referenceNo!.trim();
    const cleanRef = rawRef.replace(/[-/_\s]/g, '').toLowerCase();

    const existingRef = db.prepare(`
      SELECT id, canonical_id FROM tenders 
      WHERE LOWER(REPLACE(REPLACE(REPLACE(reference_no, '-', ''), '/', ''), ' ', '')) = ?
    `).get(cleanRef) as any;

    if (existingRef) {
      return {
        isDuplicate: true,
        canonicalId: existingRef.canonical_id,
        matchedTenderId: existingRef.id,
        similarity: 1.0
      };
    }
  }

  // 2. Query candidates by closing date proximity
  let candidates: any[] = [];
  if (candidate.closingDate) {
    candidates = db.prepare(`
      SELECT id, canonical_id, title, organization, closing_date 
      FROM tenders 
      WHERE closing_date IS NOT NULL 
      AND ABS(julianday(closing_date) - julianday(?)) <= 1.5
    `).all(candidate.closingDate);
  } else {
    candidates = db.prepare(`
      SELECT id, canonical_id, title, organization, closing_date 
      FROM tenders 
      WHERE closing_date IS NULL
      AND created_at >= datetime('now', '-14 days')
    `).all();
  }

  const targetString = candidate.organization + ' ' + candidate.title;
  let bestMatch: DuplicateMatchResult = { isDuplicate: false, similarity: 0 };

  for (const existing of candidates) {
    const existingString = existing.organization + ' ' + existing.title;
    const similarity = calculateStringSimilarity(targetString, existingString);

    if (similarity >= 0.85 && similarity > bestMatch.similarity) {
      bestMatch = {
        isDuplicate: true,
        canonicalId: existing.canonical_id,
        matchedTenderId: existing.id,
        similarity
      };
    }
  }

  return bestMatch;
}
