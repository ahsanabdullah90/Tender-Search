import {
  updateTenderFields,
  setTenderProvenance,
  updateTenderTracks,
  recordDeadlineExtension,
  appendTenderExtractedText
} from '../db/repositories/tendersRepo.js';
import { deleteTenders } from '../db/repositories/tenderLifecycleRepo.js';
import { getAllDomainTracks } from '../db/repositories/tracksRepo.js';
import { DocumentExtractionResult } from './documentExtractor.js';
import { resolveCanonicalDeadline, formatClosingDate, DeadlineSourceKind, DeadlineConfidence } from '../scrapers/dateParser.js';
import { applyDocumentScopeToTracks } from '../scrapers/trackMatcher.js';
import { Tender } from '../../shared/types.js';

/**
 * The one place a document reading is applied to a stored tender (docs/16 B3). Used by the
 * background worker, the "Fetch documents" action and the "Analyze"/"Refresh" actions, so all
 * of them follow the same rules:
 *  - later deadline wins; a corrigendum may move it earlier but the tender is then flagged;
 *  - only a trustworthy document date auto-expires a tender, never on the deadline day itself,
 *    and never a bookmarked, flagged or triaged tender;
 *  - deadline provenance (source, confidence) is updated with every deadline change;
 *  - reference and value are only filled in when empty.
 */

export interface ApplyDocumentOptions {
  /**
   * Where the result came from. Defaults to the document type (corrigendum_doc / primary_doc).
   * 'html_detail' is used for a summary of a detail page's text (Analyze without documents).
   */
  source?: DeadlineSourceKind;
  /** Replace the description even when one exists (an explicit operator "Analyze"). */
  replaceDescription?: boolean;
  /** Allow auto-expiry (deletion) on this result. Default true; detail-page text never expires. */
  allowAutoExpire?: boolean;
}

export function applyDocumentResultToTender(
  tender: Tender,
  result: DocumentExtractionResult,
  options: ApplyDocumentOptions = {}
): 'expired' | 'updated' {
  const source: DeadlineSourceKind = options.source ?? (result.docType === 'corrigendum' ? 'corrigendum_doc' : 'primary_doc');
  const fromDocument = source === 'corrigendum_doc' || source === 'primary_doc';
  const allowAutoExpire = options.allowAutoExpire ?? fromDocument;

  const resolved = resolveCanonicalDeadline(
    {
      date: tender.closing_date,
      source: (tender.deadline_source as DeadlineSourceKind) || 'html_row',
      confidence: (tender.deadline_confidence as DeadlineConfidence) || null
    },
    [{
      date: result.closingDateISO,
      source,
      confidence: result.confidence,
      canAutoExpire: fromDocument ? result.canAutoExpire : false,
      cancelled: result.isCancellation
    }]
  );

  const autoExpirable = tender.pipeline_status === 'New Opportunity' && !tender.is_bookmarked && !tender.needs_review;
  if (allowAutoExpire && resolved.canAutoExpire && autoExpirable) {
    console.log(`[DocumentApply] Tender ${tender.id} document deadline has passed (${resolved.closingDate}). Auto-expiring.`);
    deleteTenders([tender.id], 'auto-expired');
    return 'expired';
  }

  const updates: Parameters<typeof updateTenderFields>[1] = {};
  let needsReview = resolved.needsReview;
  let reviewReason = resolved.reviewReason;
  let deadlineChanged = false;

  if (resolved.closingDate && resolved.closingDate !== tender.closing_date) {
    // A date read from page text (not a document) may fill in or extend a deadline, but never
    // set an already-past one.
    const acceptable = fromDocument || !resolved.isExpired;
    if (acceptable) {
      const formatted = result.closingDateISO === resolved.closingDate && result.closingDateFormatted && result.closingDateFormatted !== 'Not Available'
        ? result.closingDateFormatted
        : formatClosingDate(resolved.closingDate);
      if (resolved.isExtension && tender.closing_date) {
        recordDeadlineExtension(tender.id, tender.closing_date_formatted || formatClosingDate(tender.closing_date), formatted);
      }
      updates.closing_date = resolved.closingDate;
      updates.closing_date_formatted = formatted;
      deadlineChanged = true;
      if (resolved.isExpired && !resolved.canAutoExpire && !resolved.withinDeadlineDay && !needsReview) {
        needsReview = true;
        reviewReason = `uncertain_past_deadline: a document suggests ${formatted}, but it could not be confirmed`;
      }
    }
  }

  if (result.referenceNo && !tender.reference_no) updates.reference_no = result.referenceNo;
  if (result.estimatedValue && !tender.estimated_value) updates.estimated_value = result.estimatedValue;
  if (result.summaryScope && (options.replaceDescription || !tender.description || tender.description === tender.title)) {
    updates.description = result.summaryScope;
  }
  if (result.bidBrief && (options.replaceDescription || !tender.bid_brief)) {
    updates.bid_brief = result.bidBrief;
  }
  if (Object.keys(updates).length) updateTenderFields(tender.id, updates);
  if (result.extractedText) {
    appendTenderExtractedText(tender.id, result.extractedText);
  }

  // Re-score tracks with the document's scope of work (Phase 2.5) for tenders not yet triaged.
  if (result.scopeText && tender.pipeline_status === 'New Opportunity') {
    const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
    const rescored = applyDocumentScopeToTracks(
      { matchedTracks: tender.domain_tracks || [], matchedKeywords: tender.matched_keywords || [] },
      {
        title: tender.title,
        organization: tender.organization,
        description: tender.description,
        referenceNo: tender.reference_no || undefined,
        directUrl: tender.direct_url
      },
      result.scopeText,
      activeTracks
    );
    if (rescored.changed) updateTenderTracks(tender.id, rescored.tracks, rescored.keywords);
    if (rescored.excludedBy.length && !rescored.changed && !needsReview) {
      needsReview = true;
      reviewReason = `excluded_terms_in_documents: ${rescored.excludedBy.join(', ')}`;
    }
  }

  const provenance: Parameters<typeof setTenderProvenance>[1] = {};
  if (deadlineChanged || (!tender.deadline_source && resolved.closingDate)) {
    provenance.deadline_source = resolved.source;
    provenance.deadline_confidence = resolved.confidence;
  }
  if (needsReview && !tender.needs_review) {
    provenance.needs_review = 1;
    provenance.review_reason = reviewReason;
  }
  setTenderProvenance(tender.id, provenance);
  return 'updated';
}
