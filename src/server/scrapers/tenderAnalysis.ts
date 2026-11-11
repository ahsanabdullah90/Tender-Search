import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import {
  DOSSIERS_DIR,
  getTenderById,
  updateTenderFields,
  getGeminiApiKey
} from '../db.js';
import { Tender, CachedDossier } from '../../types.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { downloadAndCacheDossier, deriveDossierLabel } from '../dossierManager.js';
import { saveTenderDocument, getPortalFileCode } from '../dossierStore.js';
import { extractFromDocument, DocumentExtractionResult } from '../documentExtractor.js';
import { applyDocumentResultToTender } from '../documentApply.js';
import { summarizeTenderTextWithAI } from '../ocrService.js';
import { tryConsumeDailyAiText } from '../ingestBudget.js';
import { normalizeExtractedDate, formatClosingDate } from './dateParser.js';
import { isGenericListingUrl, collectRowAttachments, cleanRowSummary } from './portalParsers.js';
import { crawlerDeps } from './crawlerDeps.js';

/** Reads a cached dossier's bytes from disk, or null if it is missing. */
export function readCachedDossier(tenderId: string, dossier: CachedDossier): Buffer | null {
  const filename = decodeURIComponent(path.basename(dossier.localPath || ''));
  if (!filename) return null;
  const diskPath = path.resolve(DOSSIERS_DIR, tenderId, filename);
  if (!diskPath.startsWith(path.resolve(DOSSIERS_DIR) + path.sep) || !fs.existsSync(diskPath)) return null;
  return fs.readFileSync(diskPath);
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
 * On-demand document scraper that inspects a tender's direct_url and downloads/caches attachments
 */
export async function fetchDocumentsForTender(
  tenderId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<{ tender: Tender | null; dossiers: CachedDossier[]; newlyFetched: number; expired: boolean }> {
  const tender = getTenderById(tenderId);
  if (!tender) {
    throw new Error(`Tender not found: ${tenderId}`);
  }
  if (tender.pipeline_status === 'Passed') {
    throw new Error(`Cannot fetch documents for passed tender: ${tenderId}`);
  }

  const dossiers: CachedDossier[] = Array.isArray(tender.cached_dossiers) ? [...tender.cached_dossiers] : [];
  const portalCode = getPortalFileCode(tender.portal_id);
  let newlyFetched = 0;

  if (tender.direct_url && tender.direct_url.startsWith('http')) {
    const isDirectFile = /\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(tender.direct_url) || /[?&]wpdmdl=\d+/i.test(tender.direct_url);

    if (isDirectFile) {
      try {
        const buf = await crawlerDeps.fetchFileBuffer(tender.direct_url);
        const doc = saveTenderDocument(tender.id, buf, {
          portalCode,
          referenceNo: tender.reference_no,
          title: tender.title,
          label: deriveDossierLabel(tender.direct_url, 'Tender Document'),
          originalUrl: tender.direct_url,
          source: 'portal_scrape'
        });
        if (!dossiers.some(d => d.sha256 === doc.sha256 || d.localPath === doc.localPath)) {
          dossiers.unshift(doc);
          newlyFetched++;
        }
      } catch (err: any) {
        console.warn(`[FetchDocs] Failed to download direct file for ${tender.id}:`, err.message);
      }
    } else {
      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === tender.portal_id) || {
        id: tender.portal_id,
        name: tender.portal_name,
        baseUrl: new URL(tender.direct_url).origin,
        tendersUrl: tender.direct_url
      } as PortalDefinition;

      const isListing = isGenericListingUrl(tender.direct_url, portalDef);

      try {
        const html = await crawlerDeps.fetchHtml(tender.direct_url);
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer, select, option, form, .job-search, .search-form, .filter-bar, aside').remove();

        let targetEl: any = $('body').get(0);

        if (isListing) {
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
          if (matchingContainer) {
            targetEl = (matchingContainer as any).get(0);
          }
        }

        const discoveredUrls = collectRowAttachments($, targetEl, portalDef);
        for (let idx = 0; idx < discoveredUrls.slice(0, 5).length; idx++) {
          const u = discoveredUrls[idx];
          try {
            const buf = await crawlerDeps.fetchFileBuffer(u);
            const doc = saveTenderDocument(tender.id, buf, {
              portalCode,
              referenceNo: tender.reference_no,
              title: tender.title,
              label: deriveDossierLabel(u, 'Bidding Document', idx + 1),
              originalUrl: u,
              index: idx + 1,
              source: 'portal_scrape'
            });
            if (!dossiers.some(d => d.sha256 === doc.sha256 || d.originalUrl === doc.originalUrl || d.localPath === doc.localPath)) {
              dossiers.push(doc);
              newlyFetched++;
            }
          } catch (dlErr: any) {
            console.warn(`[FetchDocs] Failed to download discovered attachment ${u} for ${tender.id}:`, dlErr.message);
          }
        }
      } catch (err: any) {
        console.warn(`[FetchDocs] Could not fetch detail page for ${tender.id}:`, err.message);
      }
    }
  }

  // Save the document list first, then read documents through the same rules as the background
  // worker (docs/16 B3): read when something new was downloaded or a field is still missing.
  updateTenderFields(tender.id, { cached_dossiers: dossiers });

  const needsReading = newlyFetched > 0 || !tender.closing_date || !tender.reference_no || !tender.description || tender.description === tender.title;
  if (dossiers.length > 0 && needsReading) {
    for (const doc of dossiers) {
      if (!isReadableDocumentMime(doc.mimeType)) continue;
      const buf = readCachedDossier(tender.id, doc);
      if (!buf) continue;
      try {
        // Local text first (digital PDFs/DOCX); Gemini Vision only for scans and images.
        const docResult = await extractFromDocument(buf, doc.mimeType, doc.label || '', {
          title: tender.title,
          organization: tender.organization
        });
        if (docResult.closingDateISO || docResult.referenceNo || docResult.summaryScope) {
          const applied = applyDocumentResultToTender(getTenderById(tender.id) || tender, docResult);
          if (applied === 'expired') {
            // Signal the removal explicitly instead of returning a fake 'Deleted' tender,
            // which the Inbox kept rendering as a ghost row.
            return { tender: null, dossiers, newlyFetched, expired: true };
          }
          break;
        }
      } catch (e: any) {
        console.warn(`[FetchDocs] Extraction failed for document ${doc.label || doc.localPath}:`, e.message);
      }
    }
  }

  const updatedTender = getTenderById(tender.id)!;

  return {
    tender: updatedTender,
    dossiers,
    newlyFetched,
    expired: false
  };
}

/**
 * On-demand detail-page fetcher + Gemini AI analyzer for a single tender.
 * When forceRefresh is true, re-fetches the live portal page and updates attachments/summary.
 */
export async function analyzeTenderById(tenderId: string, options: { forceRefresh?: boolean } = {}): Promise<Tender | null> {
  const tender = getTenderById(tenderId);
  if (!tender) return null;

  const dossiers = Array.isArray(tender.cached_dossiers) ? [...tender.cached_dossiers] : [];
  let detailText = '';
  const shouldFetchLive = Boolean(options.forceRefresh || dossiers.length === 0);

  // 1. Fetch from direct_url or scrape detail page for images/PDFs
  if (shouldFetchLive && tender.direct_url && tender.direct_url.startsWith('http')) {
    if (/\.(pdf|jpe?g|png|webp)(\?|$)/i.test(tender.direct_url) || /[?&]wpdmdl=\d+/i.test(tender.direct_url)) {
      const isImg = /\.(jpe?g|png|webp)(\?|$)/i.test(tender.direct_url);
      const label = deriveDossierLabel(tender.direct_url, isImg ? 'Tender Notice Image' : 'Tender Document');
      const doc = await downloadAndCacheDossier(tender.id, tender.direct_url, label);
      if (doc && !dossiers.some(d => d.sha256 === doc.sha256 || d.localPath === doc.localPath)) {
        dossiers.unshift(doc);
      }
    } else {
      const portalDef = PORTAL_DEFINITIONS.find(p => p.id === tender.portal_id) || {
        id: tender.portal_id,
        name: tender.portal_name,
        baseUrl: new URL(tender.direct_url).origin,
        tendersUrl: tender.direct_url
      } as PortalDefinition;

      const isListing = isGenericListingUrl(tender.direct_url, portalDef);

      try {
        const html = await crawlerDeps.fetchHtml(tender.direct_url);
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer, select, option, form, .job-search, .search-form, .filter-bar, aside').remove();

        if (isListing) {
          // Guard: shared listing page. Only collect attachments from the matching row or card
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

          if (matchingContainer) {
            detailText = (matchingContainer as any).text().replace(/\s+/g, ' ').trim();
            const discoveredUrls = collectRowAttachments($, (matchingContainer as any).get(0), portalDef);
            for (let idx = 0; idx < discoveredUrls.slice(0, 3).length; idx++) {
              const u = discoveredUrls[idx];
              const isImg = /\.(jpe?g|png|webp)(\?|$)/i.test(u);
              const label = deriveDossierLabel(u, isImg ? 'Tender Notice Image' : 'Bidding Document', idx + 1);
              const doc = await downloadAndCacheDossier(tender.id, u, label, undefined, idx + 1);
              if (doc && !dossiers.some(d => d.sha256 === doc.sha256 || d.originalUrl === doc.originalUrl || d.localPath === doc.localPath)) {
                dossiers.push(doc);
              }
            }
          } else {
            console.warn(`[Analyze] Tender ${tender.id} has listing URL ${tender.direct_url} and was not found in page rows. Skipping body PDF scraping.`);
          }
        } else {
          // Dedicated detail page
          detailText = $('main, article, .content, .card, .package-details, body').first().text().replace(/\s+/g, ' ').trim();
          const discoveredUrls = collectRowAttachments($, $('body').get(0), portalDef);
          for (let idx = 0; idx < discoveredUrls.slice(0, 3).length; idx++) {
            const u = discoveredUrls[idx];
            const isImg = /\.(jpe?g|png|webp)(\?|$)/i.test(u);
            const label = deriveDossierLabel(u, isImg ? 'Tender Notice Image' : 'Bidding Document', idx + 1);
            const doc = await downloadAndCacheDossier(tender.id, u, label, undefined, idx + 1);
            if (doc && !dossiers.some(d => d.sha256 === doc.sha256 || d.originalUrl === doc.originalUrl || d.localPath === doc.localPath)) {
              dossiers.push(doc);
            }
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
  for (const doc of dossiers) {
    if (!isReadableDocumentMime(doc.mimeType)) continue;
    const buf = readCachedDossier(tender.id, doc);
    if (!buf) continue;
    // Local text first (digital PDFs/DOCX); Gemini Vision only for scans and images.
    const r = await extractFromDocument(buf, doc.mimeType, doc.label || '', {
      title: tender.title,
      organization: tender.organization
    });
    if (r.closingDateISO || r.referenceNo || r.summaryScope) {
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
