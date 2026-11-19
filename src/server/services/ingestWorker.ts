import {
  claimDueJobs,
  completeJob,
  failJob,
  deferJob,
  releaseExpiredLeases,
  refreshTenderDocFetchStatus,
  getJobSummaryForTender,
  enqueueDocumentJobs,
  getJobsForTender,
  IngestJob
} from '../db/repositories/ingestJobsRepo.js';
import {
  getTenderById,
  updateTenderFields,
  deleteTenders,
  setTenderTracksAndRelease
} from '../db/repositories/tendersRepo.js';
import { getAllDomainTracks } from '../db/repositories/tracksRepo.js';
import { deriveDossierLabel } from './dossierManager.js';
import { extractFromDocument, DocumentExtractionResult } from './documentExtractor.js';
import { maxFileBytes, tryConsumeDailyVision } from './ingestBudget.js';
import { crawlerDeps, currentScanStatus, readCachedDossier } from '../scrapers/crawlerEngine.js';
import { isDownloadableCandidateUrl, UPFRONT_MAX_DOCS } from '../scrapers/ingestPipeline.js';
import { applyDocumentScopeToTracks, matchTracks } from '../scrapers/trackMatcher.js';
import { applyDocumentResultToTender } from './documentApply.js';
import { Tender } from '../../shared/types.js';
import { checkNetworkHealth, canRunHeavyNetworkTask, isTransientNetworkError } from './networkMonitor.js';

/**
 * Background document worker (docs/13-ingestion-pipeline-plan.md, §3.3). Runs every 2 minutes
 * from the scheduler: downloads queued tender documents, reads them, and applies what it finds,
 * following the same rules as ingest (later deadline wins; corrigenda that move a deadline
 * earlier are flagged, not deleted; only trustworthy document dates auto-expire; bookmarked and
 * triaged tenders are never auto-deleted).
 */

export interface WorkerReport {
  skipped?: 'scan_running' | 'already_running' | 'network_unhealthy';
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
  // Hold heavy background PDF downloads until network connectivity is healthy (online).
  const network = await checkNetworkHealth();
  if (!canRunHeavyNetworkTask(network)) {
    return { ...report, skipped: 'network_unhealthy' };
  }

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
    let downloadErr: Error | null = null;
    let downloadTransient = false;
    const doc = await crawlerDeps.downloadAndCacheDossier(tender.id, job.url, label, {
      onError: (err, meta) => {
        downloadErr = err;
        downloadTransient = meta.isTransientNetwork;
      }
    });
    if (!doc) {
      if (downloadTransient || !canRunHeavyNetworkTask()) {
        deferJob(job.id, 10, (downloadErr as Error | null)?.message || 'Deferred due to slow/offline network');
        refreshTenderDocFetchStatus(tender.id);
        return 'deferred';
      }
      const status = failJob(job.id, (downloadErr as Error | null)?.message || 'Download failed');
      refreshTenderDocFetchStatus(tender.id);
      if (status === 'failed') {
        finalizeAwaitingScopeAfterJobFailure(tender.id);
      }
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

    // A tender held because its listing matched no track (docs/15 F2): decide from the document.
    if (current.ingestion_status === 'awaiting_scope') {
      const decision = decideAwaitingScope(current, result, job.id);
      if (decision === 'removed') return 'completed';
      if (decision === 'waiting') {
        completeJob(job.id);
        refreshTenderDocFetchStatus(current.id);
        return 'completed';
      }
    }

    const applied = applyDocumentResultToTender(getTenderById(current.id) || current, result);
    if (applied === 'expired') return 'expired'; // tender (and its jobs) deleted

    completeJob(job.id);
    refreshTenderDocFetchStatus(current.id);
    return 'completed';
  } catch (err: any) {
    if (isTransientNetworkError(err) || !canRunHeavyNetworkTask()) {
      deferJob(job.id, 10, err?.message || 'Deferred due to transient network error');
      if (getTenderById(job.tender_id)) {
        refreshTenderDocFetchStatus(job.tender_id);
      }
      return 'deferred';
    }
    const status = failJob(job.id, err?.message || String(err));
    if (getTenderById(job.tender_id)) {
      refreshTenderDocFetchStatus(job.tender_id);
      if (status === 'failed') {
        finalizeAwaitingScopeAfterJobFailure(job.tender_id);
      }
    }
    return 'failed';
  }
}

/**
 * When a document job for an 'awaiting_scope' tender permanently fails and no active jobs
 * remain, either enqueue any unqueued downloadable attachments or (if at least one document was
 * already read with no track match) delete and suppress the tender as 'no-track-match'.
 * If no document has ever succeeded (summary.done === 0), keep the tender per DOC-9.
 */
function finalizeAwaitingScopeAfterJobFailure(tenderId: string): void {
  const current = getTenderById(tenderId);
  if (!current || current.ingestion_status !== 'awaiting_scope') return;

  const summary = getJobSummaryForTender(tenderId);
  if (summary.pending + summary.processing > 0) return;

  const existingUrls = new Set(getJobsForTender(tenderId).map(j => j.url));
  const remainingUrls = (current.attachment_urls || []).filter(
    u => u && isDownloadableCandidateUrl(u) && !existingUrls.has(u)
  );
  if (remainingUrls.length > 0) {
    const added = enqueueDocumentJobs(
      tenderId,
      remainingUrls.slice(0, UPFRONT_MAX_DOCS).map(url => ({
        url,
        label: deriveDossierLabel(url, `${current.title.slice(0, 30)}_Doc`)
      }))
    );
    if (added > 0) {
      refreshTenderDocFetchStatus(tenderId);
      return;
    }
  }

  if (summary.done > 0) {
    deleteTenders([tenderId], 'no-track-match');
  }
}

/**
 * Decides a tender held as 'awaiting_scope' (its listing matched no track) from one document:
 *  - 'released': the document text matches a track; the tender becomes visible ('ready') and the
 *    rest of the result is applied as for any tender;
 *  - 'waiting': no match in this document, but other documents of the tender are still queued;
 *  - 'removed': no match and no documents left; the row is deleted and suppressed so the next
 *    scan does not download it again.
 */
function decideAwaitingScope(tender: Tender, result: DocumentExtractionResult, jobId: string): 'released' | 'waiting' | 'removed' {
  const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
  const scope = [result.scopeText, result.summaryScope].filter(Boolean).join(' ');
  const listing = {
    title: tender.title,
    organization: tender.organization,
    description: tender.description,
    referenceNo: tender.reference_no || undefined,
    directUrl: tender.direct_url
  };
  if (scope.trim()) {
    const rescored = applyDocumentScopeToTracks({ matchedTracks: [], matchedKeywords: [] }, listing, scope, activeTracks);
    if (rescored.tracks.length > 0) {
      const { matchScore } = matchTracks({ ...listing, description: `${tender.description || ''} ${scope}` }, activeTracks);
      setTenderTracksAndRelease(tender.id, rescored.tracks, rescored.keywords, matchScore);
      return 'released';
    }
  }
  completeJob(jobId);
  const summary = getJobSummaryForTender(tender.id);
  if (summary.pending + summary.processing > 0) return 'waiting';
  deleteTenders([tender.id], 'no-track-match');
  return 'removed';
}

export { applyDocumentResultToTender };
