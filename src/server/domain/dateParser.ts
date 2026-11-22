import { getPktDateKey, endOfPktDayMs } from '../../shared/pktDate.js';

export { endOfPktDayMs };

/**
 * Strict date string parsing for Pakistani tenders:
 * Checks DD/MM/YYYY and DD-MM-YYYY first with explicit PKT (+05:00) timezone,
 * preventing US-style day/month swaps on days 1-12.
 */
export function isValidCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const maxDays = new Date(year, month, 0).getDate();
  return day <= maxDays;
}

export const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};

function resolvePktDateTime(
  year: number,
  month: number,
  day: number,
  hourRaw?: string,
  minuteRaw?: string,
  secondRaw?: string,
  meridiem?: string
): string | null {
  let hour = hourRaw ? parseInt(hourRaw, 10) : 14;
  const minute = minuteRaw ? parseInt(minuteRaw, 10) : 0;
  const second = secondRaw ? parseInt(secondRaw, 10) : 0;

  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (hour < 1 || hour > 12) return null;
    if (upper === 'AM') {
      if (hour === 12) hour = 0;
    } else if (upper === 'PM') {
      if (hour !== 12) hour += 12;
    }
  }

  if (
    !isValidCalendarDay(year, month, day) ||
    !isPlausibleTenderYear(year) ||
    hour < 0 || hour >= 24 ||
    minute < 0 || minute >= 60 ||
    second < 0 || second >= 60
  ) {
    return null;
  }

  const hStr = String(hour).padStart(2, '0');
  const mStr = String(minute).padStart(2, '0');
  const sStr = String(second).padStart(2, '0');
  const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
  return !isNaN(d.getTime()) ? d.toISOString() : null;
}

export function parseDateString(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const str = raw.trim();

  // Exclude known non-date text noise
  if (/^(not available|n\/a|none|null|undefined|-+)$/i.test(str)) return null;

  // Strip optional leading weekday, ordinal suffixes (1st, 20 th, 2nd, 3rd, 4th..31st), normalize military time, and commas
  const cleanStr = str
    .replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b,?\s*/i, '')
    .replace(/(\d{1,2})\s*(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:hrs?|hours?)\b/gi, '$1:$2')
    .replace(/\b([01]?\d|2[0-3])([0-5]\d)\s*(?:hrs?|hours?)\b/gi, '$1:$2')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    // 1. Check numeric DD/MM/YYYY or DD-MM-YYYY with optional time (+ optional AM/PM)
    const dmyMatch = cleanStr.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      let year = parseInt(dmyMatch[3], 10);
      if (year < 100) year += 2000;
      return resolvePktDateTime(year, month, day, dmyMatch[4], dmyMatch[5], dmyMatch[6], dmyMatch[7]);
    }

    // 2. Named month format (Day first): e.g. 15 Nov 2026, 30 Oct, 2026, 15-November-2026 02:30 PM
    const namedMonthMatch = cleanStr.match(/^(\d{1,2})\s*[-/.\s]\s*([A-Za-z]{3,9})\.?\s*[-/.\s]\s*(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (namedMonthMatch) {
      const day = parseInt(namedMonthMatch[1], 10);
      const month = MONTH_NAMES[namedMonthMatch[2].toLowerCase()];
      let year = parseInt(namedMonthMatch[3], 10);
      if (year < 100) year += 2000;
      if (!month) return null;
      return resolvePktDateTime(year, month, day, namedMonthMatch[4], namedMonthMatch[5], namedMonthMatch[6], namedMonthMatch[7]);
    }

    // 2b. Named month format (Month first): e.g. Saturday, November 14, 2026 12:00 PM, Jun 30th 2026
    const monthFirstMatch = cleanStr.match(/^([A-Za-z]{3,9})\.?\s*[-/.\s]\s*(\d{1,2})\s*[-/.\s]\s*(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (monthFirstMatch) {
      const month = MONTH_NAMES[monthFirstMatch[1].toLowerCase()];
      const day = parseInt(monthFirstMatch[2], 10);
      let year = parseInt(monthFirstMatch[3], 10);
      if (year < 100) year += 2000;
      if (!month) return null;
      return resolvePktDateTime(year, month, day, monthFirstMatch[4], monthFirstMatch[5], monthFirstMatch[6], monthFirstMatch[7]);
    }

    // 3a. Full ISO timestamp with an explicit offset (e.g. "...Z" or "...+05:00") is already unambiguous.
    // Re-reading it as PKT wall-clock time would shift UTC timestamps by 5 hours on every round trip.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
      const d = new Date(str);
      if (isNaN(d.getTime()) || !isPlausibleTenderYear(d.getUTCFullYear())) return null;
      return d.toISOString();
    }

    // 3. ISO format YYYY-MM-DD with optional time
    const isoMatch = cleanStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      const hour = isoMatch[4] ? parseInt(isoMatch[4], 10) : 14;
      const minute = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
      const second = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;

      if (
        isValidCalendarDay(year, month, day) &&
        isPlausibleTenderYear(year) &&
        hour >= 0 && hour < 24 &&
        minute >= 0 && minute < 60 &&
        second >= 0 && second < 60
      ) {
        const hStr = String(hour).padStart(2, '0');
        const mStr = String(minute).padStart(2, '0');
        const sStr = String(second).padStart(2, '0');
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
      return null;
    }

    // 4. Fallback standard parse. V8 reads many short strings ("12", "Lot 3", "15 June") as dates
    // in 2001, so only accept it when the text carries an explicit 4-digit year and that year is
    // plausible for a tender (docs/16 A11).
    const yearMatch = str.match(/(?<!\d)(20\d{2})(?!\d)/);
    if (yearMatch) {
      const fallback = new Date(str);
      if (!isNaN(fallback.getTime()) && isPlausibleTenderYear(fallback.getUTCFullYear()) && fallback.getUTCFullYear() === parseInt(yearMatch[1], 10)) {
        return fallback.toISOString();
      }
    }
  } catch {}

  return null;
}

export function formatClosingDate(isoDate: string | null): string {
  if (!isoDate) return 'Not Available';
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return 'Not Available';
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Karachi'
    }) + ', ' + d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Karachi'
    }) + ' PKT';
  } catch {
    return 'Not Available';
  }
}

/**
 * Normalizes an AI/OCR-extracted (or otherwise untrusted) date string into a canonical UTC ISO
 * timestamp. Returns null when the value cannot be parsed, so malformed model output is never
 * persisted: SQLite's julianday() returns NULL for such strings, which would silently exempt the
 * tender from every expiry check and retention query.
 */
export function normalizeExtractedDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const iso = parseDateString(String(raw));
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return null;
  // AI/OCR output and other untrusted dates outside a plausible window are dropped, never stored.
  if (!isPlausibleTenderYear(new Date(ms).getUTCFullYear())) return null;
  return new Date(ms).toISOString();
}

/** Years a tender deadline or notice date can plausibly carry: 2010 to five years ahead. */
export function isPlausibleTenderYear(year: number, now: Date = new Date()): boolean {
  return year >= 2010 && year <= now.getUTCFullYear() + 5;
}

export type DeadlineSourceKind = 'corrigendum_doc' | 'primary_doc' | 'html_detail' | 'html_row' | 'manual';
export type DeadlineConfidence = 'high' | 'medium' | 'low';

/** Tie-break order (and badge priority) when two sources give the same deadline. */
const SOURCE_RANK: Record<DeadlineSourceKind, number> = {
  corrigendum_doc: 0,
  primary_doc: 1,
  html_detail: 2,
  html_row: 3,
  manual: 4
};

const isDocumentSource = (s: DeadlineSourceKind) => s === 'corrigendum_doc' || s === 'primary_doc';

export interface DeadlineSignal {
  date: string | null | undefined;
  source: DeadlineSourceKind;
  confidence?: DeadlineConfidence | null;
  /** Set by the document extractor: strong enough to delete a tender on (rule I3). */
  canAutoExpire?: boolean;
  /** A corrigendum that cancels the tender. */
  cancelled?: boolean;
}

export interface CanonicalDeadline {
  closingDate: string | null;
  source: DeadlineSourceKind | null;
  confidence: DeadlineConfidence | null;
  isExpired: boolean;
  /** The deadline moved later than the known one (log a corrigendum). */
  isExtension: boolean;
  /** Safe to auto-expire (delete) the tender: past, not under review, and well-sourced. */
  canAutoExpire: boolean;
  /** The operator must confirm (decision 1): a corrigendum moved the deadline earlier, or cancelled the tender. */
  needsReview: boolean;
  reviewReason: string | null;
  cancelled: boolean;
  /** Past its stated time but still on the deadline's PKT calendar day: never auto-expired yet. */
  withinDeadlineDay: boolean;
}

/**
 * Resolves one deadline from the known value and all new signals (docs/13 §2.3):
 *  1. Invalid/unparseable dates are dropped.
 *  2. A corrigendum document's date wins, even if earlier. Earlier → flagged for review, never
 *     auto-expired on that basis; a cancelling corrigendum is also flagged.
 *  3. Otherwise the latest valid date wins (I2). Exception: on the same PKT calendar day a
 *     document's time beats a listing's, because listing dates carry no real time (they default
 *     to 14:00).
 *  4. Ties go to the higher-ranked source (corrigendum > primary doc > detail page > row > manual).
 *  5. Auto-expire only when the winning date is past and came from a document the extractor
 *     marked trustworthy, or when there are no document signals at all (existing Rule B6).
 */
export function resolveCanonicalDeadline(
  known: { date: string | null | undefined; source?: DeadlineSourceKind | null; confidence?: DeadlineConfidence | null } | null,
  signals: DeadlineSignal[],
  nowMs: number = Date.now()
): CanonicalDeadline {
  type Valid = { date: string; ms: number; source: DeadlineSourceKind; confidence: DeadlineConfidence | null; canAutoExpire: boolean; cancelled: boolean };
  const toValid = (s: DeadlineSignal): Valid | null => {
    const date = normalizeExtractedDate(s.date ?? null);
    return date
      ? { date, ms: new Date(date).getTime(), source: s.source, confidence: s.confidence ?? null, canAutoExpire: Boolean(s.canAutoExpire), cancelled: Boolean(s.cancelled) }
      : null;
  };

  const knownValid = known?.date
    ? toValid({ date: known.date, source: known.source || 'html_row', confidence: known.confidence ?? null, canAutoExpire: false })
    : null;
  const valid = signals.map(toValid).filter((v): v is Valid => v !== null);
  const cancelled = signals.some(s => s.source === 'corrigendum_doc' && s.cancelled);
  const hasDocSignal = signals.some(s => isDocumentSource(s.source));

  const result: CanonicalDeadline = {
    closingDate: knownValid ? known!.date! : null,
    source: knownValid ? knownValid.source : null,
    confidence: knownValid ? knownValid.confidence : null,
    isExpired: false,
    isExtension: false,
    canAutoExpire: false,
    needsReview: false,
    reviewReason: null,
    cancelled,
    withinDeadlineDay: false
  };

  const corrigenda = valid.filter(v => v.source === 'corrigendum_doc').sort((a, b) => b.ms - a.ms);
  let winner: Valid | null = knownValid;

  if (!corrigenda.length && knownValid?.source === 'corrigendum_doc') {
    // A deadline already set by a corrigendum supersedes the original documents: reading the
    // original RFP afterwards must not restore its (now outdated) date. Only a newer corrigendum
    // can change it.
  } else if (corrigenda.length) {
    winner = corrigenda[0];
    if (knownValid && winner.ms < knownValid.ms && getPktDateKey(winner.date) !== getPktDateKey(knownValid.date)) {
      result.needsReview = true;
      result.reviewReason = `deadline_moved_earlier: ${formatClosingDate(knownValid.date)} → ${formatClosingDate(winner.date)}`;
    }
  } else {
    for (const cand of valid) {
      if (!winner) { winner = cand; continue; }
      const sameDay = getPktDateKey(cand.date) === getPktDateKey(winner.date);
      if (sameDay && isDocumentSource(cand.source) !== isDocumentSource(winner.source)) {
        if (isDocumentSource(cand.source)) winner = cand; // document time beats listing time
        continue;
      }
      if (cand.ms > winner.ms || (cand.ms === winner.ms && SOURCE_RANK[cand.source] < SOURCE_RANK[winner.source])) {
        winner = cand;
      }
    }
  }

  if (cancelled) {
    result.needsReview = true;
    result.reviewReason = 'corrigendum_cancelled: a corrigendum says this tender was cancelled or withdrawn';
  }

  if (winner) {
    result.closingDate = winner === knownValid ? known!.date! : winner.date;
    result.source = winner.source;
    result.confidence = winner.confidence;
    result.isExpired = winner.ms < nowMs;
    result.isExtension = Boolean(knownValid && winner !== knownValid && winner.ms > knownValid.ms && getPktDateKey(winner.date) !== getPktDateKey(knownValid.date));
    const wellSourced = isDocumentSource(winner.source) ? winner.canAutoExpire : !hasDocSignal;
    // Never auto-expire during the deadline's own PKT day: deadline times read from text are the
    // least reliable part ("1100 hrs" was once read as midnight), so wait until the day is over
    // (docs/16 A8). The tender is still shown as closed once its stated time has passed.
    result.withinDeadlineDay = result.isExpired && nowMs <= endOfPktDayMs(winner.date);
    result.canAutoExpire = result.isExpired && !result.withinDeadlineDay && !result.needsReview && wellSourced;
  }
  return result;
}

/**
 * Upper-bound publish date from a CMS upload path (docs/13 §2.4): `/wp-content/uploads/2025/10/x.pdf`
 * → `2025-10-31`. Year-only paths and Download-Manager links (`?wpdmdl=`) give no date. Used only
 * as a publish-date fallback, never as a deadline.
 */
export function inferPublishDateFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/uploads\/(20\d{2})\/(0[1-9]|1[0-2])\//);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`;
}

export const DATE_CANDIDATE_PATTERN = `(?:\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}(?:\\s*(?:st|nd|rd|th))?[-/.\\s]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?,?[-/.\\s]+\\d{4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?[-/.\\s]+\\d{1,2}(?:\\s*(?:st|nd|rd|th))?(?:\\s*,|\\s*,\\s*|[-/.\\s]+)\\d{4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{4}-\\d{2}-\\d{2}(?:[\\sT]\\d{1,2}:\\d{2}(?::\\d{2})?)?)`;

/**
 * Extracts and disambiguates publish dates vs closing dates using labels and chronological sorting (Bug B7)
 */
/**
 * Words that, inside a closing-type label, mean the date is about something else:
 * "Submission of queries", "Last date of sale", "Last updated", "Due date for pre-bid…" (docs/16 A7).
 */
const NON_CLOSING_LABEL = /quer(?:y|ies)|clarif|pre[-\s]?bid|\bsale\b|purchas|issu|opening|validity|meeting|updated|modified|posted|published/i;

export interface ExtractDatesOptions {
  /**
   * What a lone date with no label means. 'auto' (default): a future date is the closing date and
   * a past/today date is the publish date, because a publication date is never in the future and
   * an open tender's deadline always is (docs/16 A6).
   */
  singleDate?: 'auto' | 'closing' | 'publish';
  nowMs?: number;
}

export function extractDatesFromText(
  rowText: string,
  options: ExtractDatesOptions = {}
): { publishDate: string | null; closingDate: string | null } {
  const nowMs = options.nowMs ?? Date.now();
  // 1. Look for explicit labels (including "Dead Line" with space used on BPPRA ePPS). Every
  // labelled match is considered; labels about queries, sale, pre-bid etc. are ignored and the
  // latest remaining closing-type date wins.
  const closingLabelRegex = new RegExp(`\\b(closing|submission|dead\\s*line|due|last)((?:[\\s\\w]{0,20}?)(?:[:\\s-]))\\s*(${DATE_CANDIDATE_PATTERN})`, 'gi');
  const publishLabelRegex = new RegExp(`(?:publish(?:ed)?|posted|advertised|issue(?:d)?|opening|create(?:d)?|creation)(?:[\\s\\w]{0,20}?)(?:[:\\s-])\\s*(${DATE_CANDIDATE_PATTERN})`, 'i');

  const publishMatch = rowText.match(publishLabelRegex);
  let publishDate: string | null = publishMatch ? parseDateString(publishMatch[1]) : null;

  let closingDate: string | null = null;
  for (const m of rowText.matchAll(closingLabelRegex)) {
    const labelText = `${m[1]}${m[2]}`;
    if (NON_CLOSING_LABEL.test(labelText)) continue;
    const parsed = parseDateString(m[3]);
    if (parsed && (!closingDate || new Date(parsed).getTime() > new Date(closingDate).getTime())) {
      closingDate = parsed;
    }
  }

  if (closingDate) {
    return { publishDate, closingDate };
  }

  // 2. If no explicit closing label found, extract all candidate dates
  const globalDateRegex = new RegExp(DATE_CANDIDATE_PATTERN, 'gi');
  const matches = rowText.match(globalDateRegex) || [];
  const parsedDates: string[] = [];
  for (const m of matches) {
    const p = parseDateString(m);
    if (p && !parsedDates.includes(p)) {
      parsedDates.push(p);
    }
  }

  if (parsedDates.length === 1) {
    if (publishMatch && publishDate === parsedDates[0]) {
      return { publishDate, closingDate: null };
    }
    const mode = options.singleDate ?? 'auto';
    const isFuture = new Date(parsedDates[0]).getTime() > nowMs;
    if (mode === 'closing' || (mode === 'auto' && isFuture)) {
      return { publishDate: null, closingDate: parsedDates[0] };
    }
    return { publishDate: parsedDates[0], closingDate: null };
  }

  if (parsedDates.length >= 2) {
    parsedDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return {
      publishDate: publishDate || parsedDates[0],
      closingDate: parsedDates[parsedDates.length - 1]
    };
  }

  return { publishDate: null, closingDate: null };
}
