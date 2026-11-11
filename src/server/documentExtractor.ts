import { extractTenderFromImage, summarizeTenderTextWithAI, OcrExtractedData } from './ocrService.js';
import { getGeminiApiKey } from './db/repositories/systemRepo.js';
import { inferDocType, DocType } from './dossierStore.js';
import { DATE_CANDIDATE_PATTERN, parseDateString, normalizeExtractedDate, formatClosingDate } from './scrapers/dateParser.js';
import { isValidReferenceNo } from './deduplicator.js';

/**
 * Two-stage document extractor (docs/13-ingestion-pipeline-plan.md, Phase 2.2).
 *
 * Stage 1 reads the text layer of digital PDFs and Word files locally (no network, no Gemini)
 * and finds the submission deadline with phrase-anchored patterns. Stage 2 sends only documents
 * without a text layer (scans, newspaper clippings, images) to Gemini Vision.
 */

export const MIN_TEXT_CHARS = 200;
const MAX_PDF_PAGES = 5;

export type ExtractionMethod = 'local_text_regex' | 'local_text_ai' | 'gemini_vision' | 'none';
export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface DocumentExtractionResult extends OcrExtractedData {
  extractionMethod: ExtractionMethod;
  confidence: ExtractionConfidence;
  docType: DocType;
  /** Up to ~1,500 characters of the scope-of-work section, for track matching. */
  scopeText: string;
  /** A corrigendum that cancels or withdraws the tender. */
  isCancellation: boolean;
  /** Distinct submission deadlines found next to submission phrases (ISO, sorted). */
  anchoredDeadlines: string[];
  /** True when this result is strong enough to auto-expire a tender (rule I3). */
  canAutoExpire: boolean;
  /** Scanned/image document that still needs Vision (no key or budget exhausted). */
  needsVision: boolean;
  textChars: number;
}

export interface ExtractOptions {
  title?: string;
  organization?: string;
  /** Called before each Gemini Vision call; return false to skip Vision (budget exhausted). */
  allowVisionCall?: () => boolean;
  /** Allow a Gemini text cross-check when the local result is ambiguous. Default true. */
  allowAiCrossCheck?: boolean;
}

export interface DocumentText {
  text: string;
  pages: number;
  kind: 'pdf' | 'docx' | 'image' | 'other';
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function isPdf(buf: Buffer, mimeType: string): boolean {
  return mimeType === 'application/pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function isDocx(buf: Buffer, mimeType: string): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (buf[0] === 0x50 && buf[1] === 0x4b && /word|docx/i.test(mimeType))
  );
}

/**
 * Joins pdf.js text items by their position on the page. Naively joining items with spaces
 * splits words that the PDF stores as separate glyph runs ("SC HOOL", "202 6"), which breaks
 * date and reference matching.
 */
function joinPdfTextItems(items: any[]): string {
  let out = '';
  let prevEndX: number | null = null;
  let prevY: number | null = null;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const [a, b, c, d, x, y] = item.transform || [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    if (prevY !== null && Math.abs(y - prevY) > fontSize * 0.5) {
      out += '\n';
    } else if (prevEndX !== null) {
      const gap = x - prevEndX;
      if (gap > fontSize * 0.2 && !/\s$/.test(out) && !/^\s/.test(item.str)) out += ' ';
    }
    out += item.str;
    prevEndX = x + (item.width || 0);
    prevY = y;
    if (item.hasEOL) {
      out += '\n';
      prevEndX = null;
    }
  }
  return out;
}

export async function extractDocumentText(buf: Buffer, mimeType: string = ''): Promise<DocumentText> {
  if (mimeType.startsWith('image/')) return { text: '', pages: 0, kind: 'image' };

  if (isPdf(buf, mimeType)) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0
    }).promise;
    try {
      const pages: string[] = [];
      for (let p = 1; p <= Math.min(doc.numPages, MAX_PDF_PAGES); p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        pages.push(joinPdfTextItems(content.items as any[]));
      }
      return { text: pages.join('\n\n'), pages: doc.numPages, kind: 'pdf' };
    } finally {
      await doc.destroy().catch(() => {});
    }
  }

  if (isDocx(buf, mimeType)) {
    const mammoth = await import('mammoth');
    const res = await (mammoth as any).extractRawText({ buffer: buf });
    return { text: String(res?.value || ''), pages: 1, kind: 'docx' };
  }

  return { text: '', pages: 0, kind: 'other' };
}

export function printableLength(text: string): number {
  return text.replace(/[^\x21-\x7E -￿]/g, '').length;
}

// ---------------------------------------------------------------------------
// Phrase-anchored field extraction
// ---------------------------------------------------------------------------

/** Phrases that introduce the bid submission deadline. */
const SUBMISSION_ANCHOR = new RegExp(
  [
    'last\\s+date\\s+(?:and\\s+time\\s+)?(?:of|for)\\s+(?:the\\s+)?(?:submission|receipt|dropping)',
    'last\\s+date\\s+(?:and\\s+time\\s+)?(?:to|of)\\s+submit',
    '(?:closing|due|submission)\\s+date(?:\\s+and\\s+time)?',
    'deadline(?:\\s+for\\s+(?:the\\s+)?submission)?',
    '(?:bids?|tenders?|proposals?|quotations?|offers?|eois?|applications?)[^.\\n]{0,80}?\\b(?:shall|must|should|will|may|can)\\s+be\\s+(?:submitted|received|delivered|dropped|deposited|reach(?:ed)?)',
    '(?:should|must|shall)\\s+reach',
    '(?:submitted|received|delivered|dropped)\\s+(?:on\\s+or\\s+before|before|by|latest\\s+by|not\\s+later\\s+than|till|up\\s*to)',
    'on\\s+or\\s+before'
  ].join('|'),
  'gi'
);

/** Words that, appearing between an anchor and a date, mean the date is about something else. */
const NON_SUBMISSION_CONTEXT = /\b(issu(?:e|ance|ed)|pre[-\s]?bid|opening|opened|open\b|validity|valid|sale\s+of|purchase\s+of|published|dated|clarification)/i;

const DATE_RE = new RegExp(DATE_CANDIDATE_PATTERN, 'gi');
const TIME_RE = /(?:at\s+|by\s+|upto\s+|up\s+to\s+|till\s+|time\s*[:\-]?\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|hrs|hours)\b/i;

function combineDateAndTime(dateStr: string, after: string): string | null {
  const iso = parseDateString(dateStr);
  if (!iso) return null;
  // If the date already carried a time, keep it.
  if (/\d{1,2}:\d{2}/.test(dateStr)) return iso;
  const tm = after.slice(0, 40).match(TIME_RE);
  if (!tm) return iso; // date-only: parseDateString defaults to 14:00 PKT
  let hour = parseInt(tm[1], 10);
  const minute = tm[2] ? parseInt(tm[2], 10) : 0;
  const suffix = tm[3].toLowerCase().replace(/[\s.]/g, '');
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return iso;
  const day = new Date(new Date(iso).getTime() + 5 * 3600000).toISOString().slice(0, 10); // PKT calendar day
  const withTime = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`);
  return isNaN(withTime.getTime()) ? iso : withTime.toISOString();
}

/**
 * Finds submission deadlines: the first date within ~180 characters after a submission
 * phrase, provided nothing between the phrase and the date says it is an issue, pre-bid,
 * opening or validity date. Returns distinct instants, sorted ascending.
 */
export function findSubmissionDeadlines(rawText: string): string[] {
  const text = rawText.replace(/[ \t]+/g, ' ');
  const found = new Set<string>();
  SUBMISSION_ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUBMISSION_ANCHOR.exec(text))) {
    const windowStart = m.index + m[0].length;
    const window = text.slice(windowStart, windowStart + 180);
    DATE_RE.lastIndex = 0;
    const dm = DATE_RE.exec(window);
    if (!dm) continue;
    const between = window.slice(0, dm.index);
    if (NON_SUBMISSION_CONTEXT.test(between)) continue;
    // Generic anchors ("on or before", "deadline", "should reach") carry no submission word of
    // their own, so also check what precedes them on the same line: "Sale of bidding documents
    // on or before 05-11-2026" is not a submission deadline.
    if (!/submi|receipt|reach|receiv|deliver|drop|deposit/i.test(m[0])) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(Math.max(lineStart, m.index - 80), m.index);
      if (NON_SUBMISSION_CONTEXT.test(before) && !/submi|receipt|bids?\b|tenders?\b|proposals?|quotations?|offers?/i.test(before.replace(/bidding\s+documents?/gi, ''))) continue;
    }
    const iso = combineDateAndTime(dm[0], window.slice(dm.index + dm[0].length));
    if (iso) found.add(iso);
  }
  return Array.from(found).sort();
}

export function findReferenceNumber(text: string): string | null {
  const re = /\b(?:tender|bid|ifb|nit|rfp|rfq|eoi|ref(?:erence)?|inquiry|enquiry)\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-_.()]{2,40})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const candidate = m[1].replace(/[.)\-]+$/, '');
    if (/\d/.test(candidate) && isValidReferenceNo(candidate)) return candidate;
  }
  return null;
}

export function findEstimatedValue(text: string): string | null {
  const m = text.match(
    /\b(?:estimated\s+(?:cost|value|amount|price)|cost\s+estimate|tender\s+cost)\b[^0-9\n]{0,30}?(?:rs\.?|pkr|rupees)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(million|m\b|lac|lakh|crore)?/i
  );
  if (!m) return null;
  const digits = m[1].replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits) || parseFloat(digits) < 1000 && !m[2]) return null;
  return `PKR ${m[1]}${m[2] ? ' ' + m[2] : ''}`.trim();
}

export function findScopeText(text: string, maxChars: number = 1500): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = clean.match(/\b(scope\s+of\s+(?:work|services|supply)|schedule\s+of\s+requirements?|description\s+of\s+(?:works?|goods|services)|subject\s*:|name\s+of\s+work)/i);
  const start = m ? m.index! : 0;
  return clean.slice(start, start + maxChars);
}

function detectCorrigendum(text: string): boolean {
  return /\b(corrigendum|addendum|amendment|errat(?:um|a)|extension\s+(?:in|of)\s+(?:the\s+)?(?:closing|due|last)\s+date)\b/i.test(
    text.slice(0, 800)
  );
}

function detectCancellation(text: string): boolean {
  return /\b(?:tender|bid|procurement|notice|nit|rfp|process)\b[^.\n]{0,80}\b(?:is|has\s+been|stands|are|have\s+been)\s+(?:hereby\s+)?(?:cancel+ed|withdrawn|scrapped|annulled)\b/i.test(text);
}

function sameInstant(a: string, b: string, toleranceMs: number = 60 * 60 * 1000): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= toleranceMs;
}

function emptyResult(docType: DocType, method: ExtractionMethod, textChars: number): DocumentExtractionResult {
  return {
    referenceNo: null,
    organization: '',
    title: '',
    closingDateISO: null,
    closingDateFormatted: 'Not Available',
    estimatedValue: null,
    summaryScope: '',
    isCorrigendum: docType === 'corrigendum',
    extractionMethod: method,
    confidence: 'low',
    docType,
    scopeText: '',
    isCancellation: false,
    anchoredDeadlines: [],
    canAutoExpire: false,
    needsVision: false,
    textChars
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Reads one tender document and returns its deadline, reference, value and scope, with how it
 * was read and how far to trust it. Never throws for unreadable documents; returns a result
 * with no deadline instead.
 */
export async function extractFromDocument(
  buf: Buffer,
  mimeType: string,
  label: string = '',
  opts: ExtractOptions = {}
): Promise<DocumentExtractionResult> {
  let docText: DocumentText = { text: '', pages: 0, kind: 'other' };
  try {
    docText = await extractDocumentText(buf, mimeType);
  } catch (err: any) {
    console.warn('[DocExtractor] Local text extraction failed:', err?.message);
  }
  const chars = printableLength(docText.text);
  const labelType = inferDocType(label);

  // ---- Stage 2: no usable text layer → Gemini Vision (scans, clippings, images) ----
  if (chars < MIN_TEXT_CHARS) {
    const visual = docText.kind === 'image' || docText.kind === 'pdf' || mimeType.startsWith('image/') || mimeType === 'application/pdf';
    const result = emptyResult(labelType, 'none', chars);
    if (!visual) return result;
    // extractTenderFromImage itself returns null when no Gemini key is configured, so only the
    // Vision budget is checked here.
    const canCall = opts.allowVisionCall ? opts.allowVisionCall() : true;
    if (!canCall) return { ...result, needsVision: true };

    let ocr: OcrExtractedData | null = null;
    try {
      ocr = await extractTenderFromImage(buf, mimeType.startsWith('image/') ? mimeType : 'application/pdf');
    } catch (err: any) {
      console.warn('[DocExtractor] Vision extraction failed:', err?.message);
    }
    // No result (no key configured, quota, or API error): keep the document, deadline not read.
    if (!ocr) return { ...result, extractionMethod: 'gemini_vision', needsVision: true };
    const closing = normalizeExtractedDate(ocr.closingDateISO);
    const docType: DocType = ocr.isCorrigendum ? 'corrigendum' : labelType;
    return {
      ...ocr,
      closingDateISO: closing,
      closingDateFormatted: closing ? ocr.closingDateFormatted || formatClosingDate(closing) : 'Not Available',
      extractionMethod: 'gemini_vision',
      confidence: 'medium',
      docType,
      scopeText: (ocr.summaryScope || '').slice(0, 1500),
      isCancellation: docType === 'corrigendum' && detectCancellation(ocr.summaryScope || ''),
      anchoredDeadlines: closing ? [closing] : [],
      // Vision reads the official document itself, so its deadline may expire a tender (I3).
      canAutoExpire: Boolean(closing),
      needsVision: false,
      textChars: chars
    };
  }

  // ---- Stage 1: local text ----
  const text = docText.text;
  const anchored = findSubmissionDeadlines(text);
  const docType: DocType = detectCorrigendum(text) ? 'corrigendum' : labelType;
  const scopeText = findScopeText(text);

  let closing: string | null = anchored.length ? anchored[anchored.length - 1] : null; // latest wins
  let confidence: ExtractionConfidence = anchored.length === 1 ? 'high' : anchored.length > 1 ? 'medium' : 'low';
  let method: ExtractionMethod = 'local_text_regex';
  let referenceNo = findReferenceNumber(text);
  let estimatedValue = findEstimatedValue(text);
  let summaryScope = scopeText.slice(0, 400);

  // Optional Gemini text cross-check, only when the local reading is ambiguous or empty.
  if (confidence !== 'high' && opts.allowAiCrossCheck !== false && getGeminiApiKey()) {
    try {
      const digest = `${findScopeText(text, 2500)}\n\n${text.slice(0, 3500)}`.slice(0, 6000);
      const ai = await summarizeTenderTextWithAI({
        title: opts.title || label || 'Tender document',
        organization: opts.organization || '',
        rawText: digest
      });
      if (ai) {
        method = 'local_text_ai';
        const aiDate = normalizeExtractedDate(ai.closingDateISO);
        if (aiDate && anchored.some(d => sameInstant(d, aiDate, 24 * 3600000))) {
          closing = anchored.find(d => sameInstant(d, aiDate, 24 * 3600000))!;
          confidence = 'high';
        } else if (aiDate && anchored.length === 0) {
          closing = aiDate;
          confidence = 'medium';
        } else if (aiDate) {
          // Disagreement: keep the later date, flag low.
          closing = new Date(aiDate) > new Date(closing!) ? aiDate : closing;
          confidence = 'low';
        }
        referenceNo = referenceNo || ai.referenceNo;
        estimatedValue = estimatedValue || ai.estimatedValue;
        if (ai.summaryScope) summaryScope = ai.summaryScope;
      }
    } catch (err: any) {
      console.warn('[DocExtractor] AI cross-check failed:', err?.message);
    }
  }

  return {
    referenceNo,
    organization: opts.organization || '',
    title: opts.title || '',
    closingDateISO: closing,
    closingDateFormatted: closing ? formatClosingDate(closing) : 'Not Available',
    estimatedValue,
    summaryScope,
    isCorrigendum: docType === 'corrigendum',
    extractionMethod: method,
    confidence,
    docType,
    scopeText,
    isCancellation: docType === 'corrigendum' && detectCancellation(text),
    anchoredDeadlines: anchored,
    // Only an unambiguous reading may delete a tender: one anchored date, or AI agreement.
    canAutoExpire: Boolean(closing) && confidence === 'high',
    needsVision: false,
    textChars: chars
  };
}
