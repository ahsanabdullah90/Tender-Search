import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import {
  DOSSIERS_DIR,
  getTenderById,
  updateTenderFields,
  getGeminiApiKey,
  mergeTenderAttachmentUrls,
  setTenderProvenance,
  appendTenderExtractedText,
  markDocumentJobsDoneForUrls,
  refreshTenderDocFetchStatus
} from '../db/index.js';
import {
  safeDecodeURIComponent,
  sanitizeOriginUrl,
  isDirectDocumentUrl,
  isImageUrl
} from '../../shared/documentUtils.js';
import { Tender, CachedDossier } from '../../shared/types.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { deriveDossierLabel, isHtmlContent, detectExtensionAndMime } from '../services/dossierManager.js';
import { saveTenderDocument, getPortalFileCode, upgradeDossierDocTypeIfNeeded, DocType } from '../services/dossierStore.js';
import { extractFromDocument, DocumentExtractionResult } from '../services/documentExtractor.js';
import { applyDocumentResultToTender } from '../services/documentApply.js';
import { summarizeTenderTextWithAI } from '../services/ocrService.js';
import { tryConsumeDailyAiText } from '../services/ingestBudget.js';
import { normalizeExtractedDate, formatClosingDate } from './dateParser.js';
import { isGenericListingUrl, collectRowAttachments, parseEpmsDetailHtml, cleanRowSummary } from './portalParsers.js';
import { extractSppraPublishedDocId, fetchSppraPublishedDocuments } from './sppraApi.js';
import { extractBppraBidId, fetchBppraDetailMetadata } from './bppraScraper.js';
import { orderDocumentCandidates } from './ingestPipeline.js';
import { crawlerDeps } from './crawlerDeps.js';

/** Reads a cached dossier's bytes from disk, or null if it is missing. */
export function readCachedDossier(tenderId: string, dossier: CachedDossier): Buffer | null {
  const filename = safeDecodeURIComponent(path.basename(dossier.localPath || ''));
  if (!filename) return null;
  const diskPath = path.resolve(DOSSIERS_DIR, tenderId, filename);
  if (!diskPath.startsWith(path.resolve(DOSSIERS_DIR) + path.sep) || !fs.existsSync(diskPath)) return null;
  return fs.readFileSync(diskPath);
}

function resolvePortalDefForTender(tender: Tender): PortalDefinition {
  return (
    PORTAL_DEFINITIONS.find(p => p.id === tender.portal_id) ||
    ({
      id: tender.portal_id,
      name: tender.portal_name,
      baseUrl: sanitizeOriginUrl(tender.direct_url, tender.direct_url || ''),
      tendersUrl: tender.direct_url
    } as PortalDefinition)
  );
}

function findListingRowContainer($: cheerio.CheerioAPI, tender: Tender): cheerio.Cheerio<any> | null {
  let matchingContainer: cheerio.Cheerio<any> | null = null;
  $('tr, .job-post-item, .tender-card, .card, article').each((_, el) => {
    const text = $(el).text();
    if (
      (tender.reference_no && text.includes(tender.reference_no)) ||
      (tender.title && text.toLowerCase().includes(tender.title.toLowerCase().slice(0, 30)))
    ) {
      matchingContainer = $(el);
      return false;
    }
  });
  return matchingContainer;
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
  } = {}
): Promise<boolean> {
  const maxDossiers = options.maxDossiers ?? 5;
  if (!url || dossiers.length >= maxDossiers) return false;
  if (options.checkCachedUrls && cachedUrls.has(url)) return false;
  const tag = options.warnPrefix || 'FetchDocs';
  try {
    const buf = await crawlerDeps.fetchFileBuffer(url);
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

/**
 * Applies structured deterministic metadata parsed from an EPMS PPRA detail page
 * (`epms.ppra.gov.pk/public/tenders/tender-details/...`) onto the tender record
 * without consuming Gemini API quota.
 */
function applyEpmsDetailMetadata(tender: Tender, html: string, forceRefresh: boolean = false): void {
  if (!tender.direct_url?.includes('epms.ppra.gov.pk')) return;
  const meta = parseEpmsDetailHtml(html);
  if (!meta) return;

  const updates: Partial<Tender> = {};
  if (meta.bidBrief && (forceRefresh || !tender.bid_brief)) {
    updates.bid_brief = meta.bidBrief;
  }
  if (meta.description && (forceRefresh || !tender.description || meta.description.length > tender.description.length + 20)) {
    updates.description = meta.description;
  }
  if (meta.location && (!tender.location || tender.location === 'Pakistan')) {
    updates.location = meta.location;
  }
  if (Object.keys(updates).length > 0) {
    updateTenderFields(tender.id, updates);
  }
}

export interface FetchDocumentsResult {
  tender: Tender | null;
  dossiers: CachedDossier[];
  newlyFetched: number;
  expired: boolean;
}

const inFlightDocFetches = new Map<string, Promise<FetchDocumentsResult>>();
const activeDocFetchCounts = new Map<string, number>();

/** Returns tender IDs currently undergoing an active on-demand/detail document fetch. */
export function getInFlightDocFetchTenderIds(): string[] {
  return Array.from(activeDocFetchCounts.keys());
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
  options: { forceRefresh?: boolean; throwOnDetailError?: boolean } = {}
): Promise<FetchDocumentsResult> {
  if (!options.forceRefresh && !options.throwOnDetailError) {
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
  options: { forceRefresh?: boolean; throwOnDetailError?: boolean } = {}
): Promise<FetchDocumentsResult> {
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

  activeDocFetchCounts.set(tenderId, (activeDocFetchCounts.get(tenderId) || 0) + 1);
  try {
    crawlerDeps.onDocFetchChange?.();
  } catch {}
  try {

  const isDirectFile = isDirectDocumentUrl(tender.direct_url);

  const downloadAndAttachUrl = async (u: string, idx: number): Promise<boolean> => {
    const added = await downloadAndAttachCandidateUrl(tender, portalCode, u, idx, dossiers, cachedUrls, {
      defaultLabel: isDirectFile && u === tender.direct_url ? 'Tender Document' : 'Bidding Document',
      maxDossiers: 5,
      checkCachedUrls: true,
      warnPrefix: 'FetchDocs'
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

  // Step B: Inspect detail source (SPPRA API, BPPRA :9446 API, or HTML detail page) when needed.
  let detailPageChecked = false;
  const spPublishedDocId = tender.portal_id === 'sppra' ? extractSppraPublishedDocId(tender.direct_url) : null;
  const bppraBidId = tender.portal_id === 'bppra'
    ? (
        extractBppraBidId(tender.direct_url) ??
        (tender.attachment_urls || []).map(u => extractBppraBidId(u)).find((id): id is number => id !== null) ??
        null
      )
    : null;
  if (spPublishedDocId && (dossiers.length < 2 || Boolean(options.forceRefresh))) {
    try {
      const discoveredUrls = await fetchSppraPublishedDocuments(spPublishedDocId);
      detailPageChecked = true;
      if (discoveredUrls.length > 0) {
        mergeTenderAttachmentUrls(tender.id, discoveredUrls);
      }
      for (let idx = 0; idx < discoveredUrls.slice(0, 5).length; idx++) {
        if (dossiers.length >= 5) break;
        await downloadAndAttachUrl(discoveredUrls[idx], dossiers.length + idx);
      }
    } catch (err: any) {
      console.warn(`[FetchDocs] Could not fetch SPPRA published docs for ${tender.id} (pdid=${spPublishedDocId}):`, err.message);
      if (options.throwOnDetailError && dossiers.length === 0) {
        throw err;
      }
    }
  } else if (bppraBidId && (Boolean(options.forceRefresh) || !tender.bid_brief || dossiers.length === 0)) {
    try {
      const meta = await fetchBppraDetailMetadata(bppraBidId);
      detailPageChecked = true;
      if (meta) {
        const metaUpdates: Parameters<typeof updateTenderFields>[1] = {};
        if (options.forceRefresh || !tender.bid_brief) {
          metaUpdates.bid_brief = meta.bidBrief;
        }
        if (meta.isCorrigendum && !tender.has_corrigendum) {
          metaUpdates.has_corrigendum = 1;
        }
        if (Object.keys(metaUpdates).length > 0) {
          updateTenderFields(tender.id, metaUpdates);
        }
        if (meta.extractedText) {
          appendTenderExtractedText(tender.id, meta.extractedText);
        }
        if (meta.boqPdfUrl) {
          mergeTenderAttachmentUrls(tender.id, [meta.boqPdfUrl]);
          await downloadAndAttachUrl(meta.boqPdfUrl, dossiers.length);
        }
      }
    } catch (err: any) {
      console.warn(`[FetchDocs] Could not fetch BPPRA NIT metadata for ${tender.id} (bidId=${bppraBidId}):`, err.message);
      if (options.throwOnDetailError && dossiers.length === 0) {
        throw err;
      }
    }
  } else if (
    tender.portal_id !== 'sppra' &&
    tender.portal_id !== 'bppra' &&
    tender.direct_url &&
    tender.direct_url.startsWith('http') &&
    !isDirectFile &&
    (dossiers.length === 0 || Boolean(options.forceRefresh) || tender.direct_url.includes('epms.ppra.gov.pk'))
  ) {
    const portalDef = resolvePortalDefForTender(tender);
    const isListing = isGenericListingUrl(tender.direct_url, portalDef);

    try {
      const html = await crawlerDeps.fetchHtml(tender.direct_url);
      detailPageChecked = true;
      applyEpmsDetailMetadata(tender, html, Boolean(options.forceRefresh));
      const $ = cheerio.load(html);
      $('script, style, nav, header, footer, select, option, form, .job-search, .search-form, .filter-bar, aside').remove();

      let targetEl: any = $('body').get(0);
      let skipListingAttachmentScrape = false;

      if (isListing) {
        const matchingContainer = findListingRowContainer($, tender);
        if (matchingContainer) {
          targetEl = (matchingContainer as any).get(0);
        } else {
          skipListingAttachmentScrape = true;
        }
      }

      if (!skipListingAttachmentScrape) {
        const discoveredUrls = collectRowAttachments($, targetEl, portalDef);
        if (discoveredUrls.length > 0) {
          mergeTenderAttachmentUrls(tender.id, discoveredUrls);
        }
        for (let idx = 0; idx < discoveredUrls.slice(0, 5).length; idx++) {
          if (dossiers.length >= 5) break;
          await downloadAndAttachUrl(discoveredUrls[idx], dossiers.length + idx);
        }
      }
    } catch (err: any) {
      console.warn(`[FetchDocs] Could not fetch detail page for ${tender.id}:`, err.message);
      if (options.throwOnDetailError && dossiers.length === 0) {
        throw err;
      }
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
    const remaining = (activeDocFetchCounts.get(tenderId) || 1) - 1;
    if (remaining <= 0) {
      activeDocFetchCounts.delete(tenderId);
    } else {
      activeDocFetchCounts.set(tenderId, remaining);
    }
    try {
      crawlerDeps.onDocFetchChange?.();
    } catch {}
  }
}

/**
 * On-demand detail-page fetcher + Gemini AI analyzer for a single tender.
 * When forceRefresh is true, re-fetches the live portal page and updates attachments/summary.
 */
export async function analyzeTenderById(tenderId: string, options: { forceRefresh?: boolean } = {}): Promise<Tender | null> {
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
        warnPrefix: 'Analyze'
      });
    } else {
      const portalDef = resolvePortalDefForTender(tender);
      const isListing = isGenericListingUrl(tender.direct_url, portalDef);

      try {
        const html = await crawlerDeps.fetchHtml(tender.direct_url);
        applyEpmsDetailMetadata(tender, html, Boolean(options.forceRefresh));
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer, select, option, form, .job-search, .search-form, .filter-bar, aside').remove();

        const targetEl: any = isListing ? (findListingRowContainer($, tender)?.get(0) ?? null) : $('body').get(0);
        if (targetEl) {
          detailText = (isListing ? $(targetEl) : $('main, article, .content, .card, .package-details, body').first())
            .text()
            .replace(/\s+/g, ' ')
            .trim();
          const discoveredUrls = collectRowAttachments($, targetEl, portalDef);
          for (let idx = 0; idx < discoveredUrls.slice(0, 3).length; idx++) {
            await downloadAndAttachCandidateUrl(tender, portalCode, discoveredUrls[idx], idx, dossiers, cachedUrls, {
              maxDossiers: Number.MAX_SAFE_INTEGER,
              warnPrefix: 'Analyze'
            });
          }
        } else {
          console.warn(`[Analyze] Tender ${tender.id} has listing URL ${tender.direct_url} and was not found in page rows. Skipping body PDF scraping.`);
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

  if (detailText && !tender.description) {
    return updateTenderFields(tender.id, { description: cleanRowSummary(detailText, tender.title) });
  }
  return getTenderById(tender.id);
}
