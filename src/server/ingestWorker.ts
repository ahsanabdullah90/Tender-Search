import {
  claimDueJobs,
  completeJob,
  failJob,
  deferJob,
  releaseExpiredLeases,
  refreshTenderDocFetchStatus,
  IngestJob
} from './db/repositories/ingestJobsRepo.js';
import {
  getTenderById,
  updateTenderFields,
  deleteTenders,
  setTenderProvenance,
  updateTenderTracks,
  recordDeadlineExtension
} from './db/repositories/tendersRepo.js';
import { getAllDomainTracks } from './db/repositories/tracksRepo.js';
import { deriveDossierLabel } from './dossierManager.js';
import { extractFromDocument, DocumentExtractionResult } from './documentExtractor.js';
import { maxFileBytes, tryConsumeDailyVision } from './ingestBudget.js';
import { resolveCanonicalDeadline, formatClosingDate, DeadlineSourceKind, DeadlineConfidence } from './scrapers/dateParser.js';
import { crawlerDeps, currentScanStatus, readCachedDossier, applyDocumentScopeToTracks } from './scrapers/crawlerEngine.js';
import { Tender } from '../types.js';

/**
 * Background document worker (docs/13-ingestion-pipeline-plan.md, §3.3). Runs every 2 minutes
 * from the scheduler: downloads queued tender documents, reads them, and applies what it finds,
 * following the same rules as ingest (later deadline wins; corrigenda that move a deadline
 * earlier are flagged, not deleted; only trustworthy document dates auto-expire; bookmarked and
 * triaged tenders are never auto-deleted).
 */

export interface WorkerReport {
  skipped?: 'scan_running' | 'already_running';
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
  expired: number;
}

let running = false;

export async function processDocumentQueue(limit: number = 5): Promise<WorkerReport> {
  const report: WorkerReport = { claimed: 0, completed: 0, failed: 0, deferred: 0, expired: 0 };
  if (running) return { ...report, skipped: 'already_running' };
  // Never fetch portals in parallel with a scan.
  if (currentScanStatus.isScanning) return { ...report, skipped: 'scan_running' };

  running = true;
  try {
    releaseExpiredLeases();
    const jobs = claimDueJobs(limit, 10);
    report.claimed = jobs.length;
    for (const job of jobs) {
      const outcome = await processJob(job);
      report[outcome]++;
    }
  } finally {
    running = false;
  }
  return report;
}

type JobOutcome = 'completed' | 'failed' | 'deferred' | 'expired';

async function processJob(job: IngestJob): Promise<JobOutcome> {
  const tender = getTenderById(job.tender_id);
  if (!tender) {
    completeJob(job.id); // tender gone; the cascade normally removes the job first
    return 'completed';
  }
  if (tender.pipeline_status === 'Passed') {
    completeJob(job.id);
    refreshTenderDocFetchStatus(tender.id);
    return 'completed';
  }

  try {
    const label = job.label || deriveDossierLabel(job.url, 'Tender Document');
    const doc = await crawlerDeps.downloadAndCacheDossier(tender.id, job.url, label);
    if (!doc) {
      failJob(job.id, 'Download failed');
      refreshTenderDocFetchStatus(tender.id);
      return 'failed';
    }

    // The tender may have been deleted or passed while the download was in flight.
    const current = getTenderById(tender.id);
    if (!current) return 'completed';
    if (current.pipeline_status === 'Passed') {
      completeJob(job.id);
      refreshTenderDocFetchStatus(current.id);
      return 'completed';
    }

    const dossiers = Array.isArray(current.cached_dossiers) ? [...current.cached_dossiers] : [];
    if (!dossiers.some(d => d.sha256 === doc.sha256 || d.localPath === doc.localPath)) {
      dossiers.push(doc);
      updateTenderFields(current.id, { cached_dossiers: dossiers });
    }

    const buf = (doc.sizeBytes || 0) <= maxFileBytes() ? readCachedDossier(current.id, doc) : null;
    if (!buf) {
      completeJob(job.id);
      refreshTenderDocFetchStatus(current.id);
      return 'completed';
    }

    let visionDenied = false;
    const result = await extractFromDocument(buf, doc.mimeType, doc.label || label, {
      title: current.title,
      organization: current.organization,
      allowVisionCall: () => {
        const ok = tryConsumeDailyVision();
        if (!ok) visionDenied = true;
        return ok;
      }
    });

    if (result.needsVision && visionDenied) {
      // Daily Vision budget spent: try again in an hour without using up an attempt.
      deferJob(job.id, 60, 'Waiting for daily Gemini Vision budget');
      refreshTenderDocFetchStatus(current.id);
      return 'deferred';
    }

    const applied = applyDocumentResultToTender(getTenderById(current.id) || current, result);
    if (applied === 'expired') return 'expired'; // tender (and its jobs) deleted

    completeJob(job.id);
    refreshTenderDocFetchStatus(current.id);
    return 'completed';
  } catch (err: any) {
    failJob(job.id, err?.message || String(err));
    if (getTenderById(job.tender_id)) refreshTenderDocFetchStatus(job.tender_id);
    return 'failed';
  }
}

/**
 * Applies one document's extraction to an existing tender. Returns 'expired' if the tender was
 * auto-expired (deleted), otherwise 'updated'.
 */
export function applyDocumentResultToTender(tender: Tender, result: DocumentExtractionResult): 'expired' | 'updated' {
  const resolved = resolveCanonicalDeadline(
    {
      date: tender.closing_date,
      source: (tender.deadline_source as DeadlineSourceKind) || 'html_row',
      confidence: (tender.deadline_confidence as DeadlineConfidence) || null
    },
    [{
      date: result.closingDateISO,
      source: result.docType === 'corrigendum' ? 'corrigendum_doc' : 'primary_doc',
      confidence: result.confidence,
      canAutoExpire: result.canAutoExpire,
      cancelled: result.isCancellation
    }]
  );

  const autoExpirable = tender.pipeline_status === 'New Opportunity' && !tender.is_bookmarked && !tender.needs_review;
  if (resolved.canAutoExpire && autoExpirable) {
    console.log(`[IngestWorker] Tender ${tender.id} document deadline has passed (${resolved.closingDate}). Auto-expiring.`);
    deleteTenders([tender.id], 'auto-expired');
    return 'expired';
  }

  const updates: Parameters<typeof updateTenderFields>[1] = {};
  let needsReview = resolved.needsReview;
  let reviewReason = resolved.reviewReason;

  if (resolved.closingDate && resolved.closingDate !== tender.closing_date) {
    const formatted = result.closingDateISO === resolved.closingDate && result.closingDateFormatted && result.closingDateFormatted !== 'Not Available'
      ? result.closingDateFormatted
      : formatClosingDate(resolved.closingDate);
    if (resolved.isExtension && tender.closing_date) {
      recordDeadlineExtension(tender.id, tender.closing_date_formatted || formatClosingDate(tender.closing_date), formatted);
    }
    updates.closing_date = resolved.closingDate;
    updates.closing_date_formatted = formatted;
    if (resolved.isExpired && !resolved.canAutoExpire && !needsReview) {
      needsReview = true;
      reviewReason = `uncertain_past_deadline: a document suggests ${formatted}, but it could not be confirmed`;
    }
  }

  if (result.referenceNo && !tender.reference_no) updates.reference_no = result.referenceNo;
  if (result.estimatedValue && !tender.estimated_value) updates.estimated_value = result.estimatedValue;
  if (result.summaryScope && (!tender.description || tender.description === tender.title)) updates.description = result.summaryScope;
  if (Object.keys(updates).length) updateTenderFields(tender.id, updates);

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
  if (updates.closing_date !== undefined || (!tender.deadline_source && resolved.closingDate)) {
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
