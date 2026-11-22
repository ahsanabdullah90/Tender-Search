import crypto from 'crypto';
import { getPktDateKey } from '../../shared/pktDate.js';
import { isDirectDocumentUrl, isDownloadableCandidateUrl } from '../../shared/documentUtils.js';
import { Tender, CachedDossier } from '../../shared/types.js';

export { isDirectDocumentUrl, isDownloadableCandidateUrl };
import { RawScrapedItem } from './portalParsers.js';
import { PortalDefinition } from './portalList.js';
import { normalizeText, findCanonicalMatch } from '../services/deduplicator.js';
import {
  formatClosingDate,
  normalizeExtractedDate,
  resolveCanonicalDeadline,
  inferPublishDateFromUrl,
  type DeadlineSignal
} from './dateParser.js';
import {
  getTenderById,
  setTenderDeadline,
  applyDuplicateDeadlineExtension,
  setTenderProvenance,
  appendSecondarySource,
  mergeTenderAttachmentUrls,
  setTenderTracksAndRelease,
  isTenderSuppressed,
  upsertScrapedTender,
  deleteStagedTender,
  recordTenderSuppression,
  getGeminiApiKey,
  UNDATED_MAX_AGE_DAYS
} from '../db/index.js';
import {
  enqueueDocumentJobs,
  refreshTenderDocFetchStatus,
  documentJobPriority,
  DETAIL_DISCOVER_LABEL,
  isDetailPageDiscoveryUrl,
  JOB_PRIORITY
} from '../db/repositories/ingestJobsRepo.js';
import { matchTracks, applyDocumentScopeToTracks } from './trackMatcher.js';
import { embedTextToBlobAsync, buildTenderEmbeddingText } from '../services/embeddingService.js';
import { purgeTenderFiles, readCachedDossier, shouldUpgradeDocType, renameDossierToCanonical } from '../services/dossierStore.js';
import { canRunHeavyNetworkTask, type NetworkMonitor } from '../services/networkMonitor.js';
import { deriveDossierLabel } from '../services/dossierManager.js';
import { extractFromDocument, DocumentExtractionResult } from '../services/documentExtractor.js';
import {
  INGEST_DEFAULTS,
  UPFRONT_MAX_DOCS,
  getActiveScanBudget,
  hasUpfrontTime,
  maxFileBytes,
  noteDeferredDocuments,
  tryConsumeScanVision
} from '../services/ingestBudget.js';
import { getCrawlerPorts, type CrawlerPorts } from './crawlerDeps.js';

export { UPFRONT_MAX_DOCS };
export const MAX_DOCUMENTS_PER_TENDER = 5;

export interface ProcessTenderResult {
  isNew: boolean;
  hasCorrigendum: boolean;
  matched: boolean;
  /** Held (hidden) until its documents are read, because the listing matched no track (docs/15 F2). */
  awaitingScope?: boolean;
}

export interface UpfrontExtraction {
  dossier: CachedDossier;
  result: DocumentExtractionResult;
}

const NOT_MATCHED: ProcessTenderResult = { isNew: false, hasCorrigendum: false, matched: false };

/**
 * Rule B6c helper: true when the text mentions at least one year from 2010 up to last calendar
 * year and no current or future year. The window moves with the clock (it used to be hard-coded
 * to 2010-2025, so prior-year 2026 notices would have slipped through from January 2027).
 */
export function referencesOnlyPriorYears(text: string, now: Date = new Date()): boolean {
  const currentYear = now.getFullYear();
  const years = Array.from(text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g), m => parseInt(m[1], 10));
  // Fiscal-year spans such as "FY 2025-26" run July-June, so they count as current until 30 June
  // of their end year (2026), and as a prior year from July onwards.
  for (const m of text.matchAll(/(?<!\d)20\d{2}\s*[-/–]\s*(\d{2})(?!\d)/g)) {
    const fyEndYear = 2000 + parseInt(m[1], 10);
    const fyStillOpen = fyEndYear > currentYear || (fyEndYear === currentYear && now.getMonth() < 6);
    years.push(fyStillOpen ? currentYear : currentYear - 1);
  }
  const inRange = years.filter(y => y >= 2010 && y <= currentYear + 5);
  if (inRange.length === 0) return false;
  return inRange.some(y => y < currentYear) && !inRange.some(y => y >= currentYear);
}

/** Deterministic tender id: portal + listing reference + normalised title + link. */
export function computeTenderId(portalId: string, item: Pick<RawScrapedItem, 'referenceNo' | 'title' | 'directUrl'>): string {
  const idMaterial = `${portalId}:${item.referenceNo || ''}:${normalizeText(item.title)}:${item.directUrl}`;
  const tenderHash = crypto.createHash('sha256').update(idMaterial).digest('hex').slice(0, 16);
  return `tender-${portalId}-${tenderHash}`;
}

/**
 * Deduplicates a tender's document links (direct document first), filters out non-downloadable
 * HTML/server-page links, sorts them so corrigenda are read before primary documents and those
 * before everything else, and caps them at 5.
 */
export function orderDocumentCandidates(item: Pick<RawScrapedItem, 'directUrl' | 'attachmentUrls'>): string[] {
  const urls: string[] = [];
  if (isDirectDocumentUrl(item.directUrl)) urls.push(item.directUrl);
  for (const u of item.attachmentUrls || []) {
    if (u && isDownloadableCandidateUrl(u) && !urls.includes(u)) urls.push(u);
  }
  return urls
    .map((u, i) => ({ u, i, p: documentJobPriority(u) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .slice(0, MAX_DOCUMENTS_PER_TENDER)
    .map(x => x.u);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  if (ms <= 0) {
    onTimeout?.();
    return Promise.reject(new Error(`${label}: time budget exhausted`));
  }
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Downloads and reads up to UPFRONT_MAX_DOCS documents in parallel within a 20-second budget
 * per tender. Downloads that fail or time out are aborted and returned for the queue; scanned
 * documents the scan's Vision budget could not cover are returned so the worker reads them later.
 */
export async function fetchAndReadDocumentsUpfront(
  tenderId: string,
  item: RawScrapedItem,
  urls: string[],
  portalId?: string,
  ports?: CrawlerPorts
): Promise<{ dossiers: CachedDossier[]; extractions: UpfrontExtraction[]; failedUrls: string[]; visionPendingUrls: string[] }> {
  const activePorts = ports ?? getCrawlerPorts();
  const budgetEnd = Date.now() + INGEST_DEFAULTS.perTenderBudgetMs;
  const maxBytes = getActiveScanBudget()?.maxFileBytes ?? maxFileBytes();
  const dossiers: CachedDossier[] = [];
  const extractions: UpfrontExtraction[] = [];
  const failedUrls: string[] = [];
  const visionPendingUrls: string[] = [];

  await Promise.all(urls.map(async url => {
    const isImage = /\.(jpe?g|png|webp)(\?|$)/i.test(url);
    const label = isImage ? 'Tender Notice Image' : deriveDossierLabel(url);
    const controller = new AbortController();
    try {
      const doc = await withTimeout(
        activePorts.downloadAndCacheDossier(tenderId, url, label, {
          signal: controller.signal,
          maxBytes,
          tenderMeta: { portalId: portalId || null, referenceNo: item.referenceNo || null, title: item.title }
        }),
        budgetEnd - Date.now(),
        'download',
        () => controller.abort()
      );
      if (!doc) {
        failedUrls.push(url);
        return;
      }
      dossiers.push(doc);
      if ((doc.sizeBytes || 0) > maxBytes) return; // kept for the operator, too large to read
      const buf = readCachedDossier(tenderId, doc);
      if (!buf) return;
      const result = await withTimeout(
        extractFromDocument(buf, doc.mimeType, doc.label || label, {
          title: item.title,
          organization: item.organization,
          allowVisionCall: tryConsumeScanVision
        }),
        budgetEnd - Date.now(),
        'extract'
      );
      let finalDoc = doc;
      if (shouldUpgradeDocType(doc.docType, result.docType)) {
        const renamed = renameDossierToCanonical(
          { id: tenderId, portal_id: portalId, reference_no: item.referenceNo || null, title: item.title },
          doc,
          result.docType,
          dossiers
        );
        finalDoc = renamed.dossier;
        const idx = dossiers.indexOf(doc);
        if (idx >= 0) dossiers[idx] = finalDoc;
      }
      if (result.needsVision) visionPendingUrls.push(url);
      extractions.push({ dossier: finalDoc, result });
    } catch (err: any) {
      controller.abort();
      console.warn(`[CrawlIngest] Upfront document fetch for ${tenderId} deferred (${url}):`, err.message);
      failedUrls.push(url);
    }
  }));

  return { dossiers, extractions, failedUrls, visionPendingUrls };
}

/**
 * Applies a deadline seen on a re-scan of a tender already stored (docs/16 A4, A5, docs/15 F4).
 * One rule for every re-scan path:
 *  - no stored deadline → the listing date is stored;
 *  - same PKT calendar day → no change (listing times are defaults);
 *  - later day → the deadline is extended, a corrigendum is logged, the tender is marked amended;
 *  - earlier day → the stored deadline is kept and the tender is flagged for review.
 * Returns true when an extension was logged.
 */
export function applyRescannedDeadline(existing: Tender, scannedRaw: string | null | undefined): boolean {
  const scanned = normalizeExtractedDate(scannedRaw ?? null);
  if (!scanned) return false;
  const scannedFormatted = formatClosingDate(scanned);
  if (!existing.closing_date || isNaN(new Date(existing.closing_date).getTime())) {
    setTenderDeadline(existing.id, scanned, scannedFormatted, 'html_row', null);
    return false;
  }
  const scannedMs = new Date(scanned).getTime();
  const existingMs = new Date(existing.closing_date).getTime();
  if (getPktDateKey(scannedMs) === getPktDateKey(existingMs)) return false;

  const previousFormatted = existing.closing_date_formatted || formatClosingDate(existing.closing_date);
  if (scannedMs > existingMs) {
    applyDuplicateDeadlineExtension(existing.id, scanned, scannedFormatted, previousFormatted);
    return true;
  }
  if (!existing.needs_review) {
    setTenderProvenance(existing.id, {
      needs_review: 1,
      review_reason: `deadline_moved_earlier: ${previousFormatted} → ${scannedFormatted}`
    });
  }
  return false;
}

/**
 * A re-scan of a tender that is already stored: whatever its pipeline stage, the row is never
 * re-staged, re-downloaded upfront or deleted here (docs/16 A1). Only these change:
 *  - another portal is recorded under "Also listed on" (never the tender's own portal, B1);
 *  - new document links are queued for the background worker (already-queued links are ignored);
 *  - the deadline, through applyRescannedDeadline, when the listing is known to describe this
 *    tender (same source, or a reference-number match). A similarity match from another portal
 *    only records its date on the secondary source (A4).
 */
export function applyRescanToExistingTender(
  existing: Tender,
  item: RawScrapedItem,
  portal: PortalDefinition,
  candidates: string[],
  opts: { trustListingDeadline: boolean; matchedTracks?: string[]; matchedKeywords?: string[]; matchScore?: number }
): ProcessTenderResult {
  // A tender held for its documents (F2) that now matches a track from its listing is released.
  if (existing.ingestion_status === 'awaiting_scope') {
    if (opts.matchedTracks && opts.matchedTracks.length) {
      setTenderTracksAndRelease(existing.id, opts.matchedTracks, opts.matchedKeywords || [], opts.matchScore || 0);
      return { isNew: true, hasCorrigendum: false, matched: true };
    }
    if (existing.portal_name !== portal.name) {
      appendSecondarySource(existing.id, {
        portalName: portal.name,
        directUrl: item.directUrl,
        discoveredAt: new Date().toISOString(),
        closingDate: item.closingDate || null
      });
    }
    if (candidates.length > 0) {
      const cachedUrls = new Set(
        (Array.isArray(existing.cached_dossiers) ? existing.cached_dossiers : [])
          .map(d => d.originalUrl)
          .filter(Boolean)
      );
      mergeTenderAttachmentUrls(existing.id, candidates);
      const uncachedCandidates = candidates.filter(url => !cachedUrls.has(url)).slice(0, UPFRONT_MAX_DOCS);
      if (uncachedCandidates.length > 0) {
        try {
          const added = enqueueDocumentJobs(
            existing.id,
            uncachedCandidates.map(url => ({ url, label: deriveDossierLabel(url) }))
          );
          if (added > 0) refreshTenderDocFetchStatus(existing.id);
        } catch (err: any) {
          console.warn(`[CrawlIngest] Could not queue scope documents for ${existing.id}:`, err.message);
        }
      }
    }
    return { isNew: false, hasCorrigendum: false, matched: false, awaitingScope: true };
  }

  if (existing.portal_name !== portal.name) {
    appendSecondarySource(existing.id, {
      portalName: portal.name,
      directUrl: item.directUrl,
      discoveredAt: new Date().toISOString(),
      closingDate: item.closingDate || null
    });
  }

  if (existing.pipeline_status !== 'Passed') {
    const cachedUrls = new Set(
      (Array.isArray(existing.cached_dossiers) ? existing.cached_dossiers : [])
        .map(d => d.originalUrl)
        .filter(Boolean)
    );
    if (candidates.length > 0) {
      mergeTenderAttachmentUrls(existing.id, candidates);
      const uncachedCandidates = candidates.filter(url => !cachedUrls.has(url));
      if (uncachedCandidates.length > 0) {
        try {
          const added = enqueueDocumentJobs(
            existing.id,
            uncachedCandidates.map(url => ({ url, label: deriveDossierLabel(url) }))
          );
          if (added > 0) refreshTenderDocFetchStatus(existing.id);
        } catch (err: any) {
          console.warn(`[CrawlIngest] Could not queue re-scan documents for ${existing.id}:`, err.message);
        }
      }
    } else if (cachedUrls.size === 0 && isDetailPageDiscoveryUrl(item.directUrl, portal.id)) {
      try {
        const added = enqueueDocumentJobs(existing.id, [
          { url: item.directUrl, label: DETAIL_DISCOVER_LABEL, priority: JOB_PRIORITY.primary }
        ]);
        if (added > 0) refreshTenderDocFetchStatus(existing.id);
      } catch (err: any) {
        console.warn(`[CrawlIngest] Could not queue detail discovery for ${existing.id}:`, err.message);
      }
    }
  }

  const corrigendumDetected = opts.trustListingDeadline ? applyRescannedDeadline(existing, item.closingDate) : false;
  return { isNew: false, hasCorrigendum: corrigendumDetected, matched: true };
}

function buildScrapedTenderPayload(
  base: {
    tenderId: string;
    canonicalId?: string;
    item: RawScrapedItem;
    portal: PortalDefinition;
    candidates: string[];
    publishDate: string | null;
    publishDateSource: 'listing' | 'upload_folder' | null;
  },
  overrides: {
    domain_tracks?: string[];
    matched_keywords?: string[];
    match_score?: number;
    semantic_score?: number | null;
    embedding?: Buffer | null;
    closing_date?: string | null;
    closing_date_formatted: string;
    cached_dossiers?: CachedDossier[];
    has_corrigendum: number;
    ingestion_status: 'awaiting_scope' | 'staging' | 'ready';
    deadline_source: string | null;
    deadline_confidence?: string | null;
    doc_fetch_status: 'none' | 'pending' | 'partial' | 'complete' | 'failed';
    needs_review?: number;
    review_reason?: string | null;
  }
): Parameters<typeof upsertScrapedTender>[0] {
  const { tenderId, canonicalId, item, portal, candidates, publishDate, publishDateSource } = base;
  return {
    id: tenderId,
    canonical_id: canonicalId ?? tenderId,
    reference_no: item.referenceNo || null,
    title: item.title,
    organization: item.organization,
    portal_id: portal.id,
    portal_name: portal.name,
    direct_url: item.directUrl,
    domain_tracks: overrides.domain_tracks ?? [],
    matched_keywords: overrides.matched_keywords ?? [],
    match_score: overrides.match_score ?? 0,
    semantic_score: overrides.semantic_score ?? 0,
    embedding: overrides.embedding ?? null,
    publish_date: publishDate,
    publish_date_source: publishDateSource,
    closing_date: overrides.closing_date ?? null,
    closing_date_formatted: overrides.closing_date_formatted,
    estimated_value: item.estimatedValue || null,
    location: item.location || 'Pakistan',
    description: item.description ?? '',
    cached_dossiers: overrides.cached_dossiers ?? [],
    attachment_urls: candidates,
    has_corrigendum: overrides.has_corrigendum,
    ingestion_status: overrides.ingestion_status,
    deadline_source: overrides.deadline_source,
    deadline_confidence: overrides.deadline_confidence ?? null,
    doc_fetch_status: overrides.doc_fetch_status,
    needs_review: overrides.needs_review ?? 0,
    review_reason: overrides.review_reason ?? null
  };
}

/**
 * A listing that matched no track but has documents is held as 'awaiting_scope' (hidden from
 * every view) and its first documents are queued; the worker releases it if the document text
 * matches a track and removes it otherwise (docs/15 F2). Listings that are plainly over or old
 * are skipped without downloading anything.
 */
export function holdForDocumentScope(tenderId: string, item: RawScrapedItem, portal: PortalDefinition, candidates: string[]): ProcessTenderResult {
  if (candidates.length === 0) return NOT_MATCHED;
  const closingMs = item.closingDate ? new Date(item.closingDate).getTime() : NaN;
  if (!isNaN(closingMs) && closingMs < Date.now()) return NOT_MATCHED;
  if (!item.closingDate) {
    if (referencesOnlyPriorYears(`${item.title} ${item.directUrl}`)) return NOT_MATCHED;
    const publishMs = item.publishDate ? new Date(item.publishDate).getTime() : NaN;
    if (!isNaN(publishMs) && Date.now() - publishMs > UNDATED_MAX_AGE_DAYS * 86400000) return NOT_MATCHED;
    const inferred = inferPublishDateFromUrl(item.directUrl) || candidates.map(inferPublishDateFromUrl).find(Boolean) || null;
    if (inferred && Date.now() - new Date(`${inferred}T23:59:59+05:00`).getTime() > 2 * UNDATED_MAX_AGE_DAYS * 86400000) return NOT_MATCHED;
  }
  try {
    if (isTenderSuppressed(tenderId, tenderId, item.closingDate)) return NOT_MATCHED;
  } catch {}

  const inferredPublish = item.publishDate ? null : inferPublishDateFromUrl(item.directUrl) || candidates.map(inferPublishDateFromUrl).find(Boolean) || null;
  upsertScrapedTender(buildScrapedTenderPayload(
    {
      tenderId,
      item,
      portal,
      candidates,
      publishDate: item.publishDate || inferredPublish || null,
      publishDateSource: item.publishDate ? 'listing' : inferredPublish ? 'upload_folder' : null
    },
    {
      closing_date: item.closingDate || null,
      closing_date_formatted: formatClosingDate(item.closingDate || null),
      has_corrigendum: item.isCorrigendum ? 1 : 0,
      ingestion_status: 'awaiting_scope',
      deadline_source: item.closingDate ? 'html_row' : null,
      doc_fetch_status: 'pending'
    }
  ));
  try {
    enqueueDocumentJobs(tenderId, candidates.slice(0, UPFRONT_MAX_DOCS).map(url => ({ url, label: deriveDossierLabel(url) })));
    refreshTenderDocFetchStatus(tenderId);
  } catch (err: any) {
    console.warn(`[CrawlIngest] Could not queue scope documents for ${tenderId}:`, err.message);
  }
  return { isNew: false, hasCorrigendum: false, matched: false, awaitingScope: true };
}

export async function processAndSaveTender(
  item: RawScrapedItem,
  portal: PortalDefinition,
  activeTracks: any[],
  options?: { ports?: CrawlerPorts; networkMonitor?: NetworkMonitor }
): Promise<ProcessTenderResult> {
  // Hybrid Keyword + Semantic Matching across tracks
  const { matchedTracks, matchedKeywords, matchScore, semanticScore } = matchTracks(item, activeTracks);
  const candidates = orderDocumentCandidates(item);
  const tenderId = computeTenderId(portal.id, item);

  // 1. The same listing seen again (same portal, reference, title and link): update in place.
  // Checked before anything else so an existing row is never re-staged or deleted (docs/16 A1).
  const existingById = getTenderById(tenderId);
  if (existingById) {
    return applyRescanToExistingTender(existingById, item, portal, candidates, {
      trustListingDeadline: true,
      matchedTracks,
      matchedKeywords,
      matchScore
    });
  }

  // 2. No track matched from the listing text: check cross-portal canonical match first so
  //    agency listings matching a statutory (ready or awaiting_scope) tender merge instead of
  //    creating duplicate awaiting_scope rows, otherwise hold until its documents are read (F2).
  if (matchedTracks.length === 0) {
    const preHoldMatch = findCanonicalMatch({
      referenceNo: item.referenceNo,
      title: item.title,
      organization: item.organization,
      closingDate: item.closingDate,
      embedding: null,
      portalId: portal.id,
      includeAwaitingScope: true
    });
    if (preHoldMatch.isDuplicate && preHoldMatch.matchedTenderId) {
      const existing = getTenderById(preHoldMatch.matchedTenderId);
      if (existing) {
        return applyRescanToExistingTender(existing, item, portal, candidates, {
          trustListingDeadline: preHoldMatch.tier === 'reference'
        });
      }
    }
    return holdForDocumentScope(tenderId, item, portal, candidates);
  }

  // Tagged with its vector space (MiniLM, or fast if the model is not loaded yet) so it is
  // only ever compared against vectors of the same kind.
  const tenderEmbeddingBuf = await embedTextToBlobAsync(buildTenderEmbeddingText(item));

  // 3. The same tender from another source (or re-listed with a new title under the same reference).
  const dedupMatch = findCanonicalMatch({
    referenceNo: item.referenceNo,
    title: item.title,
    organization: item.organization,
    closingDate: item.closingDate,
    embedding: tenderEmbeddingBuf,
    portalId: portal.id
  });

  if (dedupMatch.isDuplicate && dedupMatch.matchedTenderId) {
    const existing = getTenderById(dedupMatch.matchedTenderId);
    if (existing) {
      return applyRescanToExistingTender(existing, item, portal, candidates, {
        trustListingDeadline: dedupMatch.tier === 'reference'
      });
    }
  }

  // 4. A new tender.
  const canonicalId = dedupMatch.canonicalId || tenderId;
  let formattedDate = formatClosingDate(item.closingDate || null);

  // Check if tender was manually deleted or auto-expired (suppression list stops re-adding). An
  // auto-expired tender that reappears with a later, future deadline is let back in (F4).
  try {
    if (isTenderSuppressed(tenderId, canonicalId, item.closingDate)) {
      return { isNew: false, hasCorrigendum: false, matched: true };
    }
  } catch {}

  // Never carry an unparseable closing date forward: B6 would skip it (NaN) and SQLite's
  // julianday() would return NULL, exempting the tender from every expiry/retention query.
  if (item.closingDate && isNaN(new Date(item.closingDate).getTime())) {
    item.closingDate = normalizeExtractedDate(item.closingDate);
    formattedDate = formatClosingDate(item.closingDate || null);
  }

  // ---- Document ingest (docs/13-ingestion-pipeline-plan.md, Phase 3) ----
  const inferredPublishDate = item.publishDate ? null : inferPublishDateFromUrl(item.directUrl) || candidates.map(inferPublishDateFromUrl).find(Boolean) || null;
  const publishDateSource = item.publishDate ? 'listing' : inferredPublishDate ? 'upload_folder' : null;

  // Upfront (blocking) fetch only when the documents are needed to decide Rule B6: the tender
  // has no deadline yet. Dated tenders insert straight away so scans stay fast and their
  // documents are fetched immediately afterward by the prioritized background worker.
  const needsUpfront = !item.closingDate && candidates.length > 0;
  const networkAllowsHeavy = options?.networkMonitor
    ? options.networkMonitor.canRunHeavyTask()
    : canRunHeavyNetworkTask();
  const runUpfront = needsUpfront && hasUpfrontTime() && networkAllowsHeavy;
  if (runUpfront) {
    // Stage the new tender so Inbox/Pipeline/analytics queries ignore it via NOT_STAGING_SQL
    // until verification passes (P2-4). Only ever done for a row that did not exist (step 1).
    upsertScrapedTender(buildScrapedTenderPayload(
      {
        tenderId,
        canonicalId,
        item,
        portal,
        candidates,
        publishDate: item.publishDate || inferredPublishDate || null,
        publishDateSource
      },
      {
        domain_tracks: matchedTracks,
        matched_keywords: matchedKeywords,
        match_score: matchScore,
        semantic_score: semanticScore ?? 0,
        embedding: tenderEmbeddingBuf,
        closing_date: item.closingDate || null,
        closing_date_formatted: formattedDate,
        has_corrigendum: item.isCorrigendum ? 1 : 0,
        ingestion_status: 'staging',
        deadline_source: item.closingDate ? 'html_row' : null,
        doc_fetch_status: 'pending'
      }
    ));
  }

  const upfront = runUpfront
    ? await fetchAndReadDocumentsUpfront(tenderId, item, candidates.slice(0, UPFRONT_MAX_DOCS), portal.id, options?.ports)
    : { dossiers: [] as CachedDossier[], extractions: [] as UpfrontExtraction[], failedUrls: [] as string[], visionPendingUrls: [] as string[] };
  const fetchedUrls = new Set(upfront.dossiers.map(d => d.originalUrl));
  const toQueue = candidates.filter(u => !fetchedUrls.has(u) || upfront.visionPendingUrls.includes(u));
  if (needsUpfront && !runUpfront) noteDeferredDocuments(candidates.length);

  // Resolve the deadline from the listing and every document read (later wins; corrigenda may
  // move it earlier but are flagged; document time beats a listing's default time).
  const signals: DeadlineSignal[] = upfront.extractions.map(({ result }) => ({
    date: result.closingDateISO,
    source: result.docType === 'corrigendum' ? 'corrigendum_doc' : 'primary_doc',
    confidence: result.confidence,
    canAutoExpire: result.canAutoExpire,
    cancelled: result.isCancellation
  }));
  const resolved = resolveCanonicalDeadline(item.closingDate ? { date: item.closingDate, source: 'html_row' } : null, signals);
  let needsReview = resolved.needsReview;
  let reviewReason = resolved.reviewReason;
  if (resolved.closingDate && resolved.closingDate !== item.closingDate) {
    item.closingDate = resolved.closingDate;
    const winning = upfront.extractions.find(e => e.result.closingDateISO === resolved.closingDate);
    formattedDate = winning?.result.closingDateFormatted && winning.result.closingDateFormatted !== 'Not Available'
      ? winning.result.closingDateFormatted
      : formatClosingDate(resolved.closingDate);
  }

  // Fill missing fields from the documents (corrigenda first, then primary documents).
  const descriptionBeforeDocs = item.description;
  for (const { result } of [...upfront.extractions].sort((a, b) => Number(b.result.isCorrigendum) - Number(a.result.isCorrigendum))) {
    if (result.referenceNo && !item.referenceNo) item.referenceNo = result.referenceNo;
    if (result.estimatedValue && !item.estimatedValue) item.estimatedValue = result.estimatedValue;
    if (result.summaryScope && (!item.description || item.description === item.title)) item.description = result.summaryScope;
  }

  // Re-score tracks with the documents' scope of work (Phase 2.5).
  const scopeText = upfront.extractions.map(e => e.result.scopeText).filter(Boolean).join(' ').slice(0, 3000);
  let finalTracks = matchedTracks;
  let finalKeywords = matchedKeywords;
  if (scopeText) {
    const rescored = applyDocumentScopeToTracks({ matchedTracks, matchedKeywords }, item, scopeText, activeTracks);
    finalTracks = rescored.tracks;
    finalKeywords = rescored.keywords;
    if (rescored.excludedBy.length && rescored.tracks === matchedTracks) {
      needsReview = true;
      reviewReason = reviewReason || `excluded_terms_in_documents: ${rescored.excludedBy.join(', ')}`;
    }
  }

  // B6: past deadline.
  if (item.closingDate) {
    const closingTime = new Date(item.closingDate).getTime();
    if (!isNaN(closingTime) && closingTime < Date.now()) {
      if (resolved.canAutoExpire) {
        if (runUpfront) deleteStagedTender(tenderId);
        if (upfront.dossiers.length) purgeTenderFiles([tenderId]);
        try {
          recordTenderSuppression(tenderId, canonicalId, item.closingDate, 'auto-expired');
        } catch {}
        return { isNew: false, hasCorrigendum: false, matched: true };
      }
      // Past its stated time but still on the deadline day: stored as closed, never deleted
      // yet, and not flagged (retention removes it after the grace period). Otherwise past but
      // flagged by a corrigendum or read with too little certainty to delete on: keep it visible
      // and flagged so the operator decides (I3, decision 1).
      if (!needsReview && !resolved.withinDeadlineDay) {
        needsReview = true;
        reviewReason = `uncertain_past_deadline: a document suggests ${formatClosingDate(item.closingDate)}, but it could not be confirmed`;
      }
    }
  }

  // B6b: old, undated notices. An explicit publish date older than the undated age limit
  // rejects. A date only inferred from an upload folder rejects only if a document WAS read and
  // had no text and no date (old uploads are often reused as templates for new notices). When no
  // document could be read at all (download failed, timed out, or no time left) nothing is known,
  // so the tender is kept and the worker decides (docs/16 B8).
  if (!item.closingDate) {
    const explicitAge = item.publishDate ? Date.now() - new Date(item.publishDate).getTime() : NaN;
    const inferredAge = inferredPublishDate ? Date.now() - new Date(`${inferredPublishDate}T23:59:59+05:00`).getTime() : NaN;
    // A scanned document waiting for the Vision budget is not "without content" (the worker will
    // read it); with no Gemini key configured it can never be read, so it counts as unreadable.
    const visionPossible = Boolean(getGeminiApiKey());
    const documentsReadWithoutContent = upfront.extractions.length > 0 &&
      upfront.extractions.every(e => e.result.textChars === 0 && !e.result.closingDateISO && !(e.result.needsVision && visionPossible));
    const stale = (!isNaN(explicitAge) && explicitAge > UNDATED_MAX_AGE_DAYS * 86400000) ||
      (!isNaN(inferredAge) && inferredAge > UNDATED_MAX_AGE_DAYS * 86400000 && documentsReadWithoutContent);
    if (stale) {
      if (runUpfront) deleteStagedTender(tenderId);
      if (upfront.dossiers.length) purgeTenderFiles([tenderId]);
      // Suppress so the next scan does not re-download and re-read the same stale notice.
      try { recordTenderSuppression(tenderId, canonicalId, null, 'stale'); } catch {}
      return { isNew: false, hasCorrigendum: false, matched: true };
    }
  }

  // B6c: Skip undated tenders that only reference previous calendar years (e.g. "Tender 2025")
  if (!item.closingDate && referencesOnlyPriorYears(`${item.title} ${item.directUrl}`)) {
    if (runUpfront) deleteStagedTender(tenderId);
    if (upfront.dossiers.length) purgeTenderFiles([tenderId]);
    try { recordTenderSuppression(tenderId, canonicalId, null, 'stale'); } catch {}
    return { isNew: false, hasCorrigendum: false, matched: true };
  }

  // Re-embed only when the documents added text (scope of work or a filled-in description).
  const embeddingBuf = scopeText || item.description !== descriptionBeforeDocs
    ? (await embedTextToBlobAsync(buildTenderEmbeddingText({ ...item, description: `${item.description || ''} ${scopeText}`.trim() }))) || tenderEmbeddingBuf
    : tenderEmbeddingBuf;
  const deadlineSource = item.closingDate ? (resolved.source || 'html_row') : null;
  const deadlineConfidence = item.closingDate ? (resolved.confidence || (deadlineSource === 'html_row' ? null : 'medium')) : null;
  const shouldQueueDetailDiscover = candidates.length === 0 && isDetailPageDiscoveryUrl(item.directUrl, portal.id);
  const docFetchStatus =
    toQueue.length > 0 || shouldQueueDetailDiscover
      ? 'pending'
      : upfront.dossiers.length > 0
        ? 'complete'
        : upfront.failedUrls.length > 0
          ? 'failed'
          : 'none';

  upsertScrapedTender(buildScrapedTenderPayload(
    {
      tenderId,
      canonicalId,
      item,
      portal,
      candidates,
      // Unknown publish dates are never defaulted to today (that made old archive items look
      // fresh). A CMS upload-folder month is used as an upper-bound fallback (marked as such, so it
      // is never used for ageing; docs/16 A2); otherwise NULL and ageing falls back to created_at.
      publishDate: item.publishDate || inferredPublishDate || null,
      publishDateSource
    },
    {
      domain_tracks: finalTracks,
      matched_keywords: finalKeywords,
      match_score: matchScore,
      semantic_score: semanticScore ?? 0,
      embedding: embeddingBuf,
      closing_date: item.closingDate || null,
      closing_date_formatted: formattedDate,
      cached_dossiers: upfront.dossiers,
      has_corrigendum: item.isCorrigendum || resolved.isExtension ? 1 : 0,
      ingestion_status: 'ready',
      deadline_source: deadlineSource,
      deadline_confidence: deadlineConfidence,
      doc_fetch_status: docFetchStatus,
      needs_review: needsReview ? 1 : 0,
      review_reason: reviewReason
    }
  ));

  // Everything not read upfront (dated tenders, remaining attachments, timeouts, scanned files
  // waiting for Vision budget) or dedicated detail pages goes to the durable queue for the worker.
  if (toQueue.length > 0) {
    try {
      enqueueDocumentJobs(tenderId, toQueue.map(url => ({ url, label: deriveDossierLabel(url) })));
      refreshTenderDocFetchStatus(tenderId);
    } catch (err: any) {
      console.warn(`[CrawlIngest] Could not queue documents for ${tenderId}:`, err.message);
    }
  } else if (shouldQueueDetailDiscover) {
    try {
      enqueueDocumentJobs(tenderId, [{ url: item.directUrl, label: DETAIL_DISCOVER_LABEL, priority: JOB_PRIORITY.primary }]);
      refreshTenderDocFetchStatus(tenderId);
    } catch (err: any) {
      console.warn(`[CrawlIngest] Could not queue detail discovery for ${tenderId}:`, err.message);
    }
  }

  return { isNew: true, hasCorrigendum: Boolean(item.isCorrigendum || resolved.isExtension), matched: true };
}
