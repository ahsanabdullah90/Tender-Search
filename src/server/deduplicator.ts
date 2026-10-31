import { db } from './db.js';

/**
 * Calculates Dice's coefficient (Bigram/Trigram similarity) between two strings.
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
 * Checks if a tender matches an existing active opportunity in the database.
 * Matches if:
 * 1. Normalized Reference Numbers match exactly (if present and > 4 chars)
 * OR
 * 2. Title + Organization similarity >= 0.85 AND closing dates within ±1 day (or both null)
 */
export function findCanonicalMatch(candidate: {
  referenceNo?: string | null;
  title: string;
  organization: string;
  closingDate?: string | null;
}): DuplicateMatchResult {
  // 1. Exact Reference Number check (if non-empty and non-trivial)
  if (candidate.referenceNo && candidate.referenceNo.trim().length > 4) {
    const normRef = normalizeText(candidate.referenceNo);
    const existingRef = db.prepare(`
      SELECT id, canonical_id FROM tenders 
      WHERE LOWER(REPLACE(REPLACE(reference_no, '-', ''), '/', '')) = LOWER(REPLACE(REPLACE(?, '-', ''), '/', ''))
    `).get(candidate.referenceNo) as any;

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
    // Within ±1.5 days
    candidates = db.prepare(`
      SELECT id, canonical_id, title, organization, closing_date 
      FROM tenders 
      WHERE closing_date IS NOT NULL 
      AND ABS(julianday(closing_date) - julianday(?)) <= 1.5
    `).all(candidate.closingDate);
  } else {
    // Both NULL closing dates
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
