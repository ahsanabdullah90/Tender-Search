import {
  getTenderById,
  getPortalById,
  updateTenderFields,
  getGeminiApiKey,
  mergeTenderAttachmentUrls,
  setTenderProvenance,
  appendTenderExtractedText,
  markDocumentJobsDoneForUrls,
  refreshTenderDocFetchStatus
} from '../db/index.js';
import {
  sanitizeOriginUrl,
  isDirectDocumentUrl,
  isImageUrl
} from '../../shared/documentUtils.js';
import { Tender, CachedDossier } from '../../shared/types.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { deriveDossierLabel, isHtmlContent, detectExtensionAndMime } from '../services/dossierManager.js';
import {
  saveTenderDocument,
  readCachedDossier,
  getPortalFileCode,
  upgradeDossierDocTypeIfNeeded,
  DocType
} from '../services/dossierStore.js';
import { extractFromDocument, DocumentExtractionResult } from '../services/documentExtractor.js';
import { applyDocumentResultToTender } from '../services/documentApply.js';
import { summarizeTenderTextWithAI } from '../services/ocrService.js';
import { tryConsumeDailyAiText } from '../services/ingestBudget.js';
import { normalizeExtractedDate, formatClosingDate } from './dateParser.js';
import { cleanRowSummary } from './parserHelpers.js';
import { extractHtmlDetailTargets } from './adapters/guards.js';
import { runDetailEnrichment } from './adapters/registry.js';
import { orderDocumentCandidates } from './ingestPipeline.js';
import { getCrawlerPorts, type CrawlerPorts } from './crawlerDeps.js';
import { scanState, type ScanStateStore } from './scanState.js';

export { readCachedDossier };

function resolvePortalDefForTender(tender: Tender): PortalDefinition & { sessionCookies?: string } {
  const canonicalDef = PORTAL_DEFINITIONS.find(p => p.id === tender.portal_id);
  let dbPortal: ReturnType<typeof getPortalById> = null;
  try {
    dbPortal = tender.portal_id ? getPortalById(tender.portal_id) : null;
  } catch {
    dbPortal = null;
  }

  if (dbPortal) {
    return {
      ...(canonicalDef || ({} as PortalDefinition)),
      id: dbPortal.portal_id,
      name: dbPortal.portal_name || canonicalDef?.name || tender.portal_name,
      category: (dbPortal.category || canonicalDef?.category || 'Federal/Regional') as PortalDefinition['category'],
      tier: (dbPortal.tier || canonicalDef?.tier || 'http') as PortalDefinition['tier'],
      baseUrl: sanitizeOriginUrl(
        dbPortal.base_url,
        canonicalDef?.baseUrl || sanitizeOriginUrl(tender.direct_url, tender.direct_url || '')
      ),
      tendersUrl: dbPortal.tenders_url || canonicalDef?.tendersUrl || tender.direct_url,
      loginUrl: dbPortal.login_url || canonicalDef?.loginUrl,
      accessMode: (dbPortal.access_mode || canonicalDef?.accessMode || 'public') as PortalDefinition['accessMode'],
      verifiedStatus: dbPortal.verified_status || canonicalDef?.verifiedStatus || 'User-configured',
      sessionCookies: dbPortal.session_cookies || undefined
    };
  }

  return (
    canonicalDef ||
    ({
      id: tender.portal_id,
      name: tender.portal_name,
      baseUrl: sanitizeOriginUrl(tender.direct_url, tender.direct_url || ''),
      tendersUrl: tender.direct_url
    } as PortalDefinition)
  );
}

async function downloadAndAttachCandidateUrl(
  tender: Tender,
  portalCode: string,
  url: string,
  idx: number,
  dossiers: CachedDossier[],
  cachedUrls: Set<string>,
  options: {
    defaultLabel?: string;
    maxDossiers?: number;
    checkCachedUrls?: boolean;
    warnPrefix?: string;
    ports?: CrawlerPorts;
  } = {}
): Promise<boolean> {
  const maxDossiers = options.maxDossiers ?? 5;
  if (!url || dossiers.length >= maxDossiers) return false;
  if (options.checkCachedUrls && cachedUrls.has(url)) return false;
  const tag = options.warnPrefix || 'FetchDocs';
  const activePorts = options.ports ?? getCrawlerPorts();
  try {
    const buf = await activePorts.fetchFileBuffer(url);
    const ct = (buf as any)?.contentType;
    if (isHtmlContent(buf, ct)) {
      console.warn(`[${tag}] Rejected HTML content from ${url} for ${tender.id}`);
      return false;
    }
    const detected = detectExtensionAndMime(buf, ct, url);
    const cdHeader = (buf as any)?.contentDisposition as string | undefined;
    const defaultLabel = options.defaultLabel ?? (isImageUrl(url) ? 'Tender Notice Image' : 'Bidding Document');
    const doc = saveTenderDocument(tender.id, buf, {
      portalCode,
      referenceNo: tender.reference_no,
      title: tender.title,
      label: deriveDossierLabel(url, defaultLabel, idx + 1),
      originalUrl: url,
      contentDisposition: cdHeader,
      extension: detected.ext,
      mimeType: detected.mimeType,
      index: idx + 1,
      existingDossiers: dossiers,
      source: 'portal_scrape'
    });
    const added = !dossiers.some(
      d => d.sha256 === doc.sha256 || d.originalUrl === doc.originalUrl || d.localPath === doc.localPath
    );
    if (added) {
      dossiers.push(doc);
    }
    cachedUrls.add(url);
    return added;
  } catch (dlErr: any) {
    console.warn(`[${tag}] Failed to download attachment ${url} for ${tender.id}:`, dlErr.message);
    return false;
  }
}

/** Document types the extractor can read: PDF, Word (.docx) and images. */
export function isReadableDocumentMime(mimeType?: string | null): boolean {
  return Boolean(
    mimeType && (
      mimeType.startsWith('image/') ||
      mimeType === 'application/pdf' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  );
}

export interface FetchDocumentsResult {
  tender: Tender | null;
  dossiers: CachedDossier[];
  newlyFetched: number;
  expired: boolean;
}

const inFlightDocFetches = new Map<string, Promise<FetchDocumentsResult>>();

/** Returns tender IDs currently undergoing an active on-demand/detail document fetch. */
export function getInFlightDocFetchTenderIds(): string[] {
  return scanState.getInFlightDocFetchTenderIds();
}

/**
 * On-demand (and background detail-discovery) document scraper:
 *  - short-circuits cleanly if dossiers are already cached and `forceRefresh` is false;
 *  - downloads any queued/stored `attachment_urls` and direct document URL first;
 *  - inspects dedicated detail pages (EPMS PPRA, FDE, Punjab detail) when needed;
 *  - reconciles `document_ingest_jobs` and `doc_fetch_status`;
 *  - extracts deadlines, BidBrief, and FTS5 full text from downloaded files.
 */
export async function fetchDocumentsForTender(
  tenderId: string,
  options: {
    forceRefresh?: boolean;
    throwOnDetailError?: boolean;
    scanState?: ScanStateStore;
    ports?: CrawlerPorts;
  } = {}
): Promise<FetchDocumentsResult> {
  if (!options.forceRefresh && !options.throwOnDetailError && !options.scanState && !options.ports) {
    const existingFlight = inFlightDocFetches.get(tenderId);
    if (existingFlight) return existingFlight;
    const runPromise = runFetchDocumentsForTender(tenderId, options).finally(() => {
      if (inFlightDocFetches.get(tenderId) === runPromise) {
        inFlightDocFetches.delete(tenderId);
      }
    });
    inFlightDocFetches.set(tenderId, runPromise);
    return runPromise;
  }
  return runFetchDocumentsForTender(tenderId, options);
}

async function runFetchDocumentsForTender(
  tenderId: string,
  options: {
    forceRefresh?: boolean;
    throwOnDetailError?: boolean;
    scanState?: ScanStateStore;
    ports?: CrawlerPorts;
  } = {}
): Promise<FetchDocumentsResult> {
  const activeScanState = options.scanState ?? scanState;
  const activePorts = options.ports ?? getCrawlerPorts();
  const tender = getTenderById(tenderId);
  if (!tender) {
    throw new Error(`Tender not found: ${tenderId}`);
  }
  if (tender.pipeline_status === 'Passed') {
    throw new Error(`Cannot fetch documents for passed tender: ${tenderId}`);
  }

  const dossiers: CachedDossier[] = Array.isArray(tender.cached_dossiers) ? [...tender.cached_dossiers] : [];
  const cachedUrls = new Set(dossiers.map(d => d.originalUrl).filter(Boolean));
  const portalCode = getPortalFileCode(tender.portal_id);
  let newlyFetched = 0;

  if (!options.forceRefresh && dossiers.length > 0) {
    markDocumentJobsDoneForUrls(tender.id, Array.from(cachedUrls), { includeDetailDiscover: true });
    const derived = refreshTenderDocFetchStatus(tender.id);
    if (derived === 'none') {
      setTenderProvenance(tender.id, { doc_fetch_status: 'complete' });
    }
    return {
      tender: getTenderById(tender.id),
      dossiers,
      newlyFetched: 0,
      expired: false
    };
  }

  activeScanState.beginDocFetch(tenderId);
  try {

  const isDirectFile = isDirectDocumentUrl(tender.direct_url);

  const downloadAndAttachUrl = async (u: string, idx: number): Promise<boolean> => {
    const added = await downloadAndAttachCandidateUrl(tender, portalCode, u, idx, dossiers, cachedUrls, {
      defaultLabel: isDirectFile && u === tender.direct_url ? 'Tender Document' : 'Bidding Document',
      maxDossiers: 5,
      checkCachedUrls: true,
      warnPrefix: 'FetchDocs',
      ports: activePorts
    });
    if (added) newlyFetched++;
    return added;
  };

  // Step A: Download known candidate URLs (attachment_urls + direct document URL) first.
  const knownUrls = orderDocumentCandidates({
    directUrl: tender.direct_url,
    attachmentUrls: tender.attachment_urls
  });
  for (let idx = 0; idx < knownUrls.length; idx++) {
    if (dossiers.length >= 5) break;
    await downloadAndAttachUrl(knownUrls[idx], idx);
  }

  // Step B: Inspect detail source (adapter enrichment or HTML detail page) when needed.
  let detailPageChecked = false;
  const portalDef = resolvePortalDefForTender(tender);

  try {
    const enrichment = await runDetailEnrichment({
      tender,
      portal: portalDef,
      existingDossierCount: dossiers.length,
      forceRefresh: Boolean(options.forceRefresh),
      fetchHtml: (url: string) => activePorts.fetchHtml(url)
    });

    if (enrichment?.handled) {
      if (enrichment.checked !== false) {
        detailPageChecked = true;
      }
      if (enrichment.fieldUpdates && Object.keys(enrichment.fieldUpdates).length > 0) {
        updateTenderFields(tender.id, enrichment.fieldUpdates);
      }
      if (enrichment.extractedText) {
        appendTenderExtractedText(tender.id, enrichment.extractedText);
      }
      const discoveredUrls = enrichment.discoveredUrls || [];
      if (discoveredUrls.length > 0) {
        mergeTenderAttachmentUrls(tender.id, discoveredUrls);
      }
      for (let idx = 0; idx < discoveredUrls.slice(0, 5).length; idx++) {
        if (dossiers.length >= 5) break;
        await downloadAndAttachUrl(discoveredUrls[idx], dossiers.length + idx);
      }
    } else if (
      tender.direct_url &&
      tender.direct_url.startsWith('http') &&
      !isDirectFile &&
      (dossiers.length === 0 || Boolean(options.forceRefresh))
    ) {
      const html = await activePorts.fetchHtml(tender.direct_url);
      detailPageChecked = true;
      const extracted = extractHtmlDetailTargets(html, tender, portalDef);
      if (extracted.found) {
        if (extracted.discoveredUrls.length > 0) {
          mergeTenderAttachmentUrls(tender.id, extracted.discoveredUrls);
        }
        for (let idx = 0; idx < extracted.discoveredUrls.slice(0, 5).length; idx++) {
          if (dossiers.length >= 5) break;
          await downloadAndAttachUrl(extracted.discoveredUrls[idx], dossiers.length + idx);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[FetchDocs] Could not fetch detail source for ${tender.id}:`, err.message);
    if (options.throwOnDetailError && dossiers.length === 0) {
      throw err;
    }
  }

  // Save the document list first, reconcile queue jobs, then read documents through the shared rules (B3).
  updateTenderFields(tender.id, { cached_dossiers: dossiers });
  markDocumentJobsDoneForUrls(tender.id, Array.from(cachedUrls), {
    includeDetailDiscover: dossiers.length > 0 || detailPageChecked
  });
  const derivedStatus = refreshTenderDocFetchStatus(tender.id);
  if (derivedStatus === 'none' && dossiers.length > 0) {
    setTenderProvenance(tender.id, { doc_fetch_status: 'complete' });
  }

  const needsReading =
    newlyFetched > 0 ||
    !tender.closing_date ||
    !tender.reference_no ||
    !tender.description ||
    tender.description === tender.title;
  if (dossiers.length > 0 && needsReading) {
    let dossiersRenamed = false;
    for (let i = 0; i < dossiers.length; i++) {
      const doc = dossiers[i];
      if (!isReadableDocumentMime(doc.mimeType)) continue;
      const buf = readCachedDossier(tender.id, doc);
      if (!buf) continue;
      try {
        // Local text first (digital PDFs/DOCX); Gemini Vision only for scans and images.
        const docResult = await extractFromDocument(buf, doc.mimeType, doc.label || '', {
          title: tender.title,
          organization: tender.organization
        });
        const upgraded = upgradeDossierDocTypeIfNeeded(tender, doc, docResult.docType as DocType, dossiers);
        if (upgraded.upgraded) {
          dossiers.splice(0, dossiers.length, ...upgraded.dossiers);
          dossiersRenamed = true;
        }
        if (
          docResult.closingDateISO ||
          docResult.referenceNo ||
          docResult.summaryScope ||
          docResult.bidBrief ||
          docResult.extractedText
        ) {
          if (dossiersRenamed) {
            updateTenderFields(tender.id, { cached_dossiers: dossiers });
            dossiersRenamed = false;
          }
          const applied = applyDocumentResultToTender(getTenderById(tender.id) || tender, docResult);
          if (applied === 'expired') {
            // Signal the removal explicitly instead of returning a fake 'Deleted' tender,
            // which the Inbox kept rendering as a ghost row.
            return { tender: null, dossiers, newlyFetched, expired: true };
          }
        }
      } catch (e: any) {
        console.warn(`[FetchDocs] Extraction failed for document ${doc.label || doc.localPath}:`, e.message);
      }
    }
    if (dossiersRenamed) {
      updateTenderFields(tender.id, { cached_dossiers: dossiers });
    }
  }

  const updatedTender = getTenderById(tender.id)!;

  return {
    tender: updatedTender,
    dossiers,
    newlyFetched,
    expired: false
  };
  } finally {
    activeScanState.endDocFetch(tenderId);
  }
}

/**
 * On-demand detail-page fetcher + Gemini AI analyzer for a single tender.
 * When forceRefresh is true, re-fetches the live portal page and updates attachments/summary.
 */
export async function analyzeTenderById(
  tenderId: string,
  options: { forceRefresh?: boolean; ports?: CrawlerPorts } = {}
): Promise<Tender | null> {
  const activePorts = options.ports ?? getCrawlerPorts();
  const tender = getTenderById(tenderId);
  if (!tender) return null;

  const dossiers = Array.isArray(tender.cached_dossiers) ? [...tender.cached_dossiers] : [];
  const cachedUrls = new Set(dossiers.map(d => d.originalUrl).filter(Boolean));
  const portalCode = getPortalFileCode(tender.portal_id);
  let detailText = '';
  const shouldFetchLive = Boolean(options.forceRefresh || dossiers.length === 0);

  // 1. Fetch from direct_url or scrape detail page for images/PDFs
  if (shouldFetchLive && tender.direct_url && tender.direct_url.startsWith('http')) {
    if (isDirectDocumentUrl(tender.direct_url)) {
      await downloadAndAttachCandidateUrl(tender, portalCode, tender.direct_url, 0, dossiers, cachedUrls, {
        defaultLabel: isImageUrl(tender.direct_url) ? 'Tender Notice Image' : 'Tender Document',
        maxDossiers: Number.MAX_SAFE_INTEGER,
        warnPrefix: 'Analyze',
        ports: activePorts
      });
    } else {
      const portalDef = resolvePortalDefForTender(tender);

      try {
        const enrichment = await runDetailEnrichment({
          tender,
          portal: portalDef,
          existingDossierCount: dossiers.length,
          forceRefresh: Boolean(options.forceRefresh),
          fetchHtml: (url: string) => activePorts.fetchHtml(url)
        });

        if (enrichment?.handled) {
          if (enrichment.fieldUpdates && Object.keys(enrichment.fieldUpdates).length > 0) {
            updateTenderFields(tender.id, enrichment.fieldUpdates);
          }
          if (enrichment.extractedText) {
            appendTenderExtractedText(tender.id, enrichment.extractedText);
          }
          if (enrichment.detailText) {
            detailText = enrichment.detailText;
          }
          const discoveredUrls = enrichment.discoveredUrls || [];
          for (let idx = 0; idx < discoveredUrls.slice(0, 3).length; idx++) {
            await downloadAndAttachCandidateUrl(tender, portalCode, discoveredUrls[idx], idx, dossiers, cachedUrls, {
              maxDossiers: Number.MAX_SAFE_INTEGER,
              warnPrefix: 'Analyze',
              ports: activePorts
            });
          }
        } else {
          const html = await activePorts.fetchHtml(tender.direct_url);
          const extracted = extractHtmlDetailTargets(html, tender, portalDef);
          if (extracted.found) {
            detailText = extracted.detailText;
            for (let idx = 0; idx < extracted.discoveredUrls.slice(0, 3).length; idx++) {
              await downloadAndAttachCandidateUrl(tender, portalCode, extracted.discoveredUrls[idx], idx, dossiers, cachedUrls, {
                maxDossiers: Number.MAX_SAFE_INTEGER,
                warnPrefix: 'Analyze',
                ports: activePorts
              });
            }
          } else {
            console.warn(`[Analyze] Tender ${tender.id} has listing URL ${tender.direct_url} and was not found in page rows. Skipping body PDF scraping.`);
          }
        }
      } catch (err: any) {
        console.warn(`[Analyze] Could not fetch detail page for ${tender.id}:`, err.message);
      }
    }
  }

  // Save the (possibly new) document list before reading anything.
  updateTenderFields(tender.id, { cached_dossiers: dossiers });

  // 2. Read the first cached document that yields something, through the shared rules (B3).
  let docResult: DocumentExtractionResult | null = null;
  for (let i = 0; i < dossiers.length; i++) {
    const doc = dossiers[i];
    if (!isReadableDocumentMime(doc.mimeType)) continue;
    const buf = readCachedDossier(tender.id, doc);
    if (!buf) continue;
    // Local text first (digital PDFs/DOCX); Gemini Vision only for scans and images.
    const r = await extractFromDocument(buf, doc.mimeType, doc.label || '', {
      title: tender.title,
      organization: tender.organization
    });
    const upgraded = upgradeDossierDocTypeIfNeeded(tender, doc, r.docType as DocType, dossiers);
    if (upgraded.upgraded) {
      dossiers.splice(0, dossiers.length, ...upgraded.dossiers);
      updateTenderFields(tender.id, { cached_dossiers: dossiers });
    }
    if (r.closingDateISO || r.referenceNo || r.summaryScope || r.bidBrief || r.extractedText) {
      docResult = r;
      break;
    }
  }
  if (docResult) {
    // An explicit Analyze may replace the description with the document summary.
    const applied = applyDocumentResultToTender(getTenderById(tender.id) || tender, docResult, { replaceDescription: true });
    return applied === 'expired' ? null : getTenderById(tender.id);
  }

  // 3. Fallback: summarize detail page text (or existing title/description) with Gemini AI. A
  // date read from page text may fill in or extend a deadline but never expire a tender.
  if (getGeminiApiKey() && tryConsumeDailyAiText()) {
    const textToAnalyze = detailText || tender.description || tender.title;
    const summary = await summarizeTenderTextWithAI({
      title: tender.title,
      organization: tender.organization,
      rawText: textToAnalyze
    });
    if (summary) {
      const closing = normalizeExtractedDate(summary.closingDateISO);
      const asResult: DocumentExtractionResult = {
        ...summary,
        closingDateISO: closing,
        closingDateFormatted: closing ? summary.closingDateFormatted || formatClosingDate(closing) : 'Not Available',
        extractionMethod: 'local_text_ai',
        confidence: 'low',
        docType: 'other' as any,
        scopeText: (summary.summaryScope || '').slice(0, 1500),
        isCancellation: false,
        anchoredDeadlines: closing ? [closing] : [],
        canAutoExpire: false,
        needsVision: false,
        textChars: textToAnalyze.length
      };
      applyDocumentResultToTender(getTenderById(tender.id) || tender, asResult, {
        source: 'html_detail',
        replaceDescription: true,
        allowAutoExpire: false
      });
      return getTenderById(tender.id);
    }
  }

  const latestTender = getTenderById(tender.id);
  if (detailText && !(latestTender?.description ?? tender.description)) {
    return updateTenderFields(tender.id, { description: cleanRowSummary(detailText, tender.title) });
  }
  return latestTender;
}
