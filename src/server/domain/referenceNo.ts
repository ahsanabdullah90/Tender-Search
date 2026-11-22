/**
 * Procurement reference numbers: validation and normalisation. Pure functions with no imports,
 * shared by the scraper, the deduplicator and the database layer (docs/15 F3, docs/16 C1).
 */

const GENERIC_WORDS = new Set(['tender', 'notice', 'procurement', 'tenders', 'quotation', 'corrigendum', 'advertisement', 'bidding']);

/**
 * Letter prefixes that look like a reference ("Jun-2026", "FY-2026-27", "Lot-12", "COVID-19",
 * "uploads/2026/05/…") but are dates, programme names or path fragments.
 */
const NON_REFERENCE_PREFIXES = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july',
  'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
  'fy', 'cfy', 'lot', 'lots', 'covid', 'page', 'pages', 'uploads', 'upload', 'wp', 'content', 'phase', 'section',
  'sr', 'no', 'item', 'items', 'schedule', 'annex', 'annexure', 'vol', 'volume', 'part', 'year', 'session'
]);

/**
 * True when a string has the structure of a genuine procurement reference: 4-40 characters, at
 * least one digit, not a generic word, not a date, not a month/FY/lot/path fragment, and not a
 * bare document-type word with a short serial ("RFP-01").
 */
export function isValidReferenceNo(ref?: string | null): boolean {
  if (!ref) return false;
  const trimmed = ref.trim();
  if (trimmed.length < 4 || trimmed.length > 40) return false;

  const lower = trimmed.toLowerCase();
  if (GENERIC_WORDS.has(lower)) return false;
  if (!/\d/.test(trimmed)) return false;

  // Dates in any spelling are not references ("15-06-2026", "2026-06-15", "06/2026").
  if (/^\d{1,4}[-/.]\d{1,4}(?:[-/.]\d{2,4})?$/.test(trimmed)) return false;
  const prefix = (lower.match(/^[a-z]+/) || [''])[0];
  if (prefix && NON_REFERENCE_PREFIXES.has(prefix)) return false;
  // A bare document-type word with a short serial is not unique across portals.
  if (/^(?:rfp|rfq|nit|eoi|ifb|tender|bid|ref)[-/\s]?\d{1,3}$/.test(lower)) return false;
  // File names and URL paths ("uploads/2026/05/file", "notice.pdf").
  if (/\.(?:pdf|docx?|xlsx?|jpe?g|png)$/i.test(trimmed)) return false;
  if ((trimmed.match(/\//g) || []).length >= 2 && /[a-z]{4,}$/i.test(trimmed)) return false;

  return true;
}

/** One normalisation for stored and scanned references: lower case, letters and digits only. */
export function normalizeReferenceNo(ref?: string | null): string | null {
  if (!isValidReferenceNo(ref)) return null;
  const norm = ref!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return norm.length >= 4 ? norm : null;
}
