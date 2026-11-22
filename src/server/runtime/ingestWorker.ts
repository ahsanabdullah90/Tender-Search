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
  getDocumentQueueCounts,
  reconcileStaleTenderDocFetchStatuses,
  DETAIL_DISCOVER_LABEL,
  IngestJob
} from '../db/repositories/ingestJobsRepo.js';
import {
  getTenderById,
  updateTenderFields,
  setTenderTracksAndRelease,
  setTenderProvenance,
  hasTenderExtractedText
} from '../db/repositories/tendersRepo.js';
import { deleteTenders } from '../db/repositories/tenderLifecycleRepo.js';
import { getAllDomainTracks } from '../db/repositories/tracksRepo.js';
import { deriveDossierLabel } from '../services/dossierManager.js';
import { readCachedDossier, upgradeDossierDocTypeIfNeeded } from '../services/dossierStore.js';
import { extractFromDocument, DocumentExtractionResult } from '../services/documentExtractor.js';
import { isDownloadableCandidateUrl } from '../../shared/documentUtils.js';
import { maxFileBytes, tryConsumeDailyVision, UPFRONT_MAX_DOCS } from '../services/ingestBudget.js';
import {
  getCrawlerPorts,
  scanState,
  fetchDocumentsForTender,
  type CrawlerPorts,
  type ScanStateStore
} from '../scrapers/crawlerEngine.js';
import { applyDocumentScopeToTracks, matchTracks } from '../domain/trackMatcher.js';
import { applyDocumentResultToTender } from '../services/documentApply.js';
import { Tender } from '../../shared/types.js';
import {
  defaultNetworkMonitor,
  isTransientNetworkError,
  type NetworkMonitor
} from '../services/networkMonitor.js';

/**
 * Background document worker (docs/13-ingestion-pipeline-plan.md, §3.3).
 * Downloads queued tender documents (and inspects dedicated detail pages), reads them, and
 * applies what it finds following the same rules as ingest. Prioritizes visible Inbox/Pipeline
 * ('ready') tenders ahead of hidden 'awaiting_scope' listings and drains Inbox documents
 * rapidly after every scan.
 */

export const DEFAULT_DOC_WORKER_CONCURRENCY = 3;
export const DEFAULT_DOC_BATCH_SIZE = 12;

export interface WorkerReport {
  skipped?: 'scan_running' | 'already_running' | 'network_unhealthy';
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
  expired: number;
}

export interface IngestWorkerContext {
  scanState?: ScanStateStore;
  networkMonitor?: NetworkMonitor;
  crawlerPorts?: Partial<CrawlerPorts>;
}

function resolveCrawlerPorts(overrides?: Partial<CrawlerPorts>): CrawlerPorts {
  const base = getCrawlerPorts();
  if (!overrides) return base;
  return {
    fetchHtml: overrides.fetchHtml ?? base.fetchHtml,
    postForm: overrides.postForm ?? base.postForm,
    sleep: overrides.sleep ?? base.sleep,
    downloadAndCacheDossier: overrides.downloadAndCacheDossier ?? base.downloadAndCacheDossier,
    fetchFileBuffer: overrides.fetchFileBuffer ?? base.fetchFileBuffer
  };
}

let running = false;
let draining = false;
let lastBatchVisibleChange = false;

export async function processDocumentQueue(
  limit: number = 5,
  concurrency: number = DEFAULT_DOC_WORKER_CONCURRENCY,
  ctx?: IngestWorkerContext
): Promise<WorkerReport> {
  const activeScanState = ctx?.scanState ?? scanState;
  const activeNetworkMonitor = ctx?.networkMonitor ?? defaultNetworkMonitor;
  const activeCrawlerPorts = resolveCrawlerPorts(ctx?.crawlerPorts);

  const report: WorkerReport = { claimed: 0, completed: 0, failed: 0, deferred: 0, expired: 0 };
  if (running) return { ...report, skipped: 'already_running' };
  // Never fetch portals in parallel with a scan.
  if (activeScanState.isScanning()) return { ...report, skipped: 'scan_running' };
  // Hold heavy background PDF downloads until network connectivity is healthy (online).
  const network = await activeNetworkMonitor.checkHealth();
  if (!activeNetworkMonitor.canRunHeavyTask(network)) {
    return { ...report, skipped: 'network_unhealthy' };
  }

  running = true;
  lastBatchVisibleChange = false;
  let batchVisibleChange = false;
  try {
    releaseExpiredLeases();
    const jobs = claimDueJobs(limit, 10);
    report.claimed = jobs.length;

    if (jobs.length > 0) {
      try {
        const liveCounts = getDocumentQueueCounts();
        const prevDocQueue = activeScanState.getDocQueue();
        activeScanState.updateDocQueueStatus({
          isFetching: true,
          ...liveCounts,
          completedInRun: prevDocQueue?.completedInRun ?? 0,
          lastUpdatedAt: prevDocQueue?.lastUpdatedAt ?? null
        });
      } catch {}
    }

    // Group jobs by tender_id (preserving claim order across tenders and strict priority order within a tender)
    const bucketsMap = new Map<string, IngestJob[]>();
    for (const job of jobs) {
      const bucket = bucketsMap.get(job.tender_id);
      if (bucket) bucket.push(job);
      else bucketsMap.set(job.tender_id, [job]);
    }
    const tenderBuckets = Array.from(bucketsMap.values());
    const poolSize = Math.max(1, Math.min(concurrency, tenderBuckets.length));
    let nextIdx = 0;

    await Promise.all(
      Array.from({ length: poolSize }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= tenderBuckets.length) break;
          for (const job of tenderBuckets[idx]) {
            const { outcome, visibleChange } = await processJob(job, {
              activeScanState,
              activeNetworkMonitor,
              activeCrawlerPorts
            });
            report[outcome]++;
            if (visibleChange) batchVisibleChange = true;
          }
        }
      })
    );
    lastBatchVisibleChange = batchVisibleChange;

    if (!draining && jobs.length > 0) {
      try {
        const afterCounts = getDocumentQueueCounts();
        const prevDocQueue = activeScanState.getDocQueue();
        const prevCompleted = prevDocQueue?.completedInRun ?? 0;
        activeScanState.updateDocQueueStatus(
          {
            isFetching: afterCounts.processing > 0,
            ...afterCounts,
            completedInRun: prevCompleted + report.completed,
            lastUpdatedAt: batchVisibleChange ? new Date().toISOString() : (prevDocQueue?.lastUpdatedAt ?? null)
          },
          batchVisibleChange ? { documentsUpdated: true } : undefined
        );
      } catch {}
    }
  } finally {
    running = false;
  }
  return report;
}

/**
 * Drains due Inbox ('ready') document jobs continuously in fast bounded-concurrency batches
 * while leaving unmatched 'awaiting_scope' jobs to trickle gently one batch per tick.
 */
export async function drainDocumentQueue(
  options?: {
    maxBatches?: number;
    batchSize?: number;
    concurrency?: number;
  },
  ctx?: IngestWorkerContext
): Promise<WorkerReport> {
  const activeScanState = ctx?.scanState ?? scanState;
  const activeNetworkMonitor = ctx?.networkMonitor ?? defaultNetworkMonitor;
  const activeCrawlerPorts = resolveCrawlerPorts(ctx?.crawlerPorts);

  const totalReport: WorkerReport = { claimed: 0, completed: 0, failed: 0, deferred: 0, expired: 0 };
  if (draining) return { ...totalReport, skipped: 'already_running' };
  if (activeScanState.isScanning()) return { ...totalReport, skipped: 'scan_running' };
  const initialNet = await activeNetworkMonitor.checkHealth();
  if (!activeNetworkMonitor.canRunHeavyTask(initialNet)) {
    return { ...totalReport, skipped: 'network_unhealthy' };
  }

  const maxBatches = options?.maxBatches ?? 25;
  const batchSize = options?.batchSize ?? DEFAULT_DOC_BATCH_SIZE;
  const concurrency = options?.concurrency ?? DEFAULT_DOC_WORKER_CONCURRENCY;

  draining = true;
  let lastUpdatedAt: string | null = activeScanState.getDocQueue()?.lastUpdatedAt ?? null;
  try {
    for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
      if (activeScanState.isScanning()) break;
      const net = await activeNetworkMonitor.checkHealth();
      if (!activeNetworkMonitor.canRunHeavyTask(net)) break;

      const countsBefore = getDocumentQueueCounts();
      if (countsBefore.totalPending === 0) break;

      activeScanState.updateDocQueueStatus({
        isFetching: true,
        ...countsBefore,
        completedInRun: totalReport.completed,
        lastUpdatedAt
      });

      const batch = await processDocumentQueue(batchSize, concurrency, ctx);
      totalReport.claimed += batch.claimed;
      totalReport.completed += batch.completed;
      totalReport.failed += batch.failed;
      totalReport.deferred += batch.deferred;
      totalReport.expired += batch.expired;

      if (batch.skipped || batch.claimed === 0) break;

      const countsAfter = getDocumentQueueCounts();
      const hadVisibleUpdate = lastBatchVisibleChange;
      if (hadVisibleUpdate) {
        lastUpdatedAt = new Date().toISOString();
      }
      activeScanState.updateDocQueueStatus(
        {
          isFetching: countsAfter.readyPending > 0,
          ...countsAfter,
          completedInRun: totalReport.completed,
          lastUpdatedAt
        },
        hadVisibleUpdate ? { documentsUpdated: true } : undefined
      );

      if (countsAfter.readyPending === 0) break;
      if (!process.env.VITEST) {
        await activeCrawlerPorts.sleep(200);
      }
    }
  } finally {
    draining = false;
    try {
      reconcileStaleTenderDocFetchStatuses();
      const finalCounts = getDocumentQueueCounts();
      activeScanState.updateDocQueueStatus({
        isFetching: false,
        ...finalCounts,
        completedInRun: totalReport.completed,
        lastUpdatedAt
      });
    } catch {}
  }

  return totalReport;
}

type JobOutcome = 'completed' | 'failed' | 'deferred' | 'expired';
interface ProcessJobResult {
  outcome: JobOutcome;
  visibleChange: boolean;
}

function isLegacyOrEmptyJobLabel(label?: string | null): boolean {
  return !label || !label.trim() || /_Doc(\s+\d+)?$/i.test(label.trim());
}

async function processJob(
  job: IngestJob,
  deps: {
    activeScanState: ScanStateStore;
    activeNetworkMonitor: NetworkMonitor;
    activeCrawlerPorts: CrawlerPorts;
  }
): Promise<ProcessJobResult> {
  const { activeScanState, activeNetworkMonitor, activeCrawlerPorts } = deps;
  const tender = getTenderById(job.tender_id);
  if (!tender) {
    completeJob(job.id); // tender gone; the cascade normally removes the job first
    return { outcome: 'completed', visibleChange: false };
  }
  const wasReady = tender.ingestion_status === 'ready';
  if (tender.pipeline_status === 'Passed') {
    completeJob(job.id);
    refreshTenderDocFetchStatus(tender.id);
    return { outcome: 'completed', visibleChange: false };
  }

  try {
    if (job.label === DETAIL_DISCOVER_LABEL) {
      const res = await fetchDocumentsForTender(tender.id, {
        forceRefresh: false,
        throwOnDetailError: true,
        scanState: activeScanState,
        ports: activeCrawlerPorts
      });
      if (res.expired) return { outcome: 'expired', visibleChange: true };
      completeJob(job.id);
      const nextStatus = refreshTenderDocFetchStatus(tender.id);
      if (nextStatus === 'none' && res.dossiers.length > 0) {
        setTenderProvenance(tender.id, { doc_fetch_status: 'complete' });
      }
      return { outcome: 'completed', visibleChange: wasReady };
    }

    const label = isLegacyOrEmptyJobLabel(job.label) ? deriveDossierLabel(job.url) : job.label!;
    const existingDossiers = Array.isArray(tender.cached_dossiers) ? tender.cached_dossiers : [];
    const alreadyCached = existingDossiers.find(d => d.originalUrl === job.url);
    const cachedBuf = alreadyCached ? readCachedDossier(tender.id, alreadyCached) : null;
    const isVisionDeferred = Boolean(job.last_error && /vision/i.test(job.last_error));

    if (
      alreadyCached &&
      cachedBuf &&
      tender.ingestion_status === 'ready' &&
      Boolean(tender.closing_date) &&
      hasTenderExtractedText(tender.id) &&
      !isVisionDeferred
    ) {
      completeJob(job.id);
      refreshTenderDocFetchStatus(tender.id);
      return { outcome: 'completed', visibleChange: true };
    }

    let doc = alreadyCached && cachedBuf ? alreadyCached : null;
    if (!doc) {
      let downloadErr: Error | null = null;
      let downloadTransient = false;
      doc = await activeCrawlerPorts.downloadAndCacheDossier(tender.id, job.url, label, {
        onError: (err, meta) => {
          downloadErr = err;
          downloadTransient = meta.isTransientNetwork;
        }
      });
      if (!doc) {
        if (downloadTransient || !activeNetworkMonitor.canRunHeavyTask()) {
          deferJob(job.id, 10, (downloadErr as Error | null)?.message || 'Deferred due to slow/offline network');
          refreshTenderDocFetchStatus(tender.id);
          return { outcome: 'deferred', visibleChange: false };
        }
        const status = failJob(job.id, (downloadErr as Error | null)?.message || 'Download failed');
        refreshTenderDocFetchStatus(tender.id);
        if (status === 'failed') {
          finalizeAwaitingScopeAfterJobFailure(tender.id);
        }
        return { outcome: 'failed', visibleChange: wasReady && status === 'failed' };
      }
    }

    // The tender may have been deleted or passed while the download was in flight.
    const current = getTenderById(tender.id);
    if (!current) return { outcome: 'completed', visibleChange: wasReady };
    if (current.pipeline_status === 'Passed') {
      completeJob(job.id);
      refreshTenderDocFetchStatus(current.id);
      return { outcome: 'completed', visibleChange: false };
    }

    const dossiers = Array.isArray(current.cached_dossiers) ? [...current.cached_dossiers] : [];
    if (!dossiers.some(d => d.sha256 === doc.sha256 || d.localPath === doc.localPath)) {
      dossiers.push(doc);
      updateTenderFields(current.id, { cached_dossiers: dossiers });
    }

    const buf = (doc.sizeBytes || 0) <= maxFileBytes() ? (cachedBuf ?? readCachedDossier(current.id, doc)) : null;
    if (!buf) {
      completeJob(job.id);
      refreshTenderDocFetchStatus(current.id);
      return { outcome: 'completed', visibleChange: current.ingestion_status === 'ready' };
    }

    let visionDenied = false;
    const result = await extractFromDocument(buf, doc.mimeType, doc.label || label, {
      title: current.title,
      organization: current.organization,
      allowAiCrossCheck: false,
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
      return { outcome: 'deferred', visibleChange: false };
    }

    const applyDocUpgradeIfNeeded = () => {
      const latest = getTenderById(current.id) || current;
      const latestDossiers = Array.isArray(latest.cached_dossiers) ? latest.cached_dossiers : dossiers;
      const upgraded = upgradeDossierDocTypeIfNeeded(latest, doc!, result.docType, latestDossiers);
      if (upgraded.upgraded) {
        updateTenderFields(latest.id, { cached_dossiers: upgraded.dossiers });
      }
    };

    // A tender held because its listing matched no track (docs/15 F2): decide from the document.
    let becameVisible = current.ingestion_status === 'ready';
    if (current.ingestion_status === 'awaiting_scope') {
      const decision = decideAwaitingScope(current, result, job.id);
      if (decision === 'removed') return { outcome: 'completed', visibleChange: false };
      if (decision === 'released') becameVisible = true;
      if (decision === 'waiting') {
        applyDocUpgradeIfNeeded();
        completeJob(job.id);
        refreshTenderDocFetchStatus(current.id);
        return { outcome: 'completed', visibleChange: false };
      }
    }

    applyDocUpgradeIfNeeded();

    const applied = applyDocumentResultToTender(getTenderById(current.id) || current, result);
    if (applied === 'expired') return { outcome: 'expired', visibleChange: true }; // tender (and its jobs) deleted

    completeJob(job.id);
    refreshTenderDocFetchStatus(current.id);
    return { outcome: 'completed', visibleChange: becameVisible };
  } catch (err: any) {
    if (isTransientNetworkError(err) || !activeNetworkMonitor.canRunHeavyTask()) {
      deferJob(job.id, 10, err?.message || 'Deferred due to transient network error');
      if (getTenderById(job.tender_id)) {
        refreshTenderDocFetchStatus(job.tender_id);
      }
      return { outcome: 'deferred', visibleChange: false };
    }
    const status = failJob(job.id, err?.message || String(err));
    if (getTenderById(job.tender_id)) {
      refreshTenderDocFetchStatus(job.tender_id);
      if (status === 'failed') {
        finalizeAwaitingScopeAfterJobFailure(job.tender_id);
      }
    }
    return { outcome: 'failed', visibleChange: wasReady && status === 'failed' };
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
        label: deriveDossierLabel(url)
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
