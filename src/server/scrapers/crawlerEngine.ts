import { db, DOSSIERS_DIR, getAllDomainTracks, updatePortalHealth, getPortalHealthList, getTenderById, updateTenderFields, getGeminiApiKey } from '../db.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { findCanonicalMatch, isValidReferenceNo, normalizeText } from '../deduplicator.js';
import { getHumanJitterDelay, sleep, sslTolerantAgent, legacySslTolerantAgent, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, Tender } from '../../types.js';
import { downloadAndCacheDossier, deriveDossierLabel } from '../dossierManager.js';
import { extractTenderFromImage, summarizeTenderTextWithAI, extractTenderListFromHtmlWithAI, discoverTenderLinkWithAI } from '../ocrService.js';
import * as cheerio from 'cheerio';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

// Global scan state for solo operator monitoring
export let currentScanStatus: ScanStatus = {
  isScanning: false,
  currentPortal: null,
  progressPercent: 0,
  completedPortals: 0,
  totalPortals: PORTAL_DEFINITIONS.length,
  newTendersFound: 0,
  corrigendaFound: 0,
  lastScanTimestamp: null
};

type ProgressListener = (status: ScanStatus) => void;
const progressListeners: Set<ProgressListener> = new Set();

export function addProgressListener(listener: ProgressListener) {
  progressListeners.add(listener);
}

export function removeProgressListener(listener: ProgressListener) {
  progressListeners.delete(listener);
}

function broadcastProgress() {
  for (const listener of progressListeners) {
    try {
      listener({ ...currentScanStatus });
    } catch (e) {
      // Ignore stale subscriber errors
    }
  }
}

/**
 * Builds merged portal list combining SQLite overrides with base defaults
 */
export function getActivePortalsList(targetPortalId?: string): PortalDefinition[] {
  const dbPortals = getPortalHealthList();
  const dbMap = new Map<string, any>(dbPortals.map(p => [p.portal_id, p]));

  let list: PortalDefinition[] = PORTAL_DEFINITIONS.map(def => {
    const dbP = dbMap.get(def.id);
    if (!dbP) return def;

    return {
      ...def,
      name: dbP.portal_name || def.name,
      category: (dbP.category as any) || def.category,
      tier: (dbP.tier as any) || def.tier,
      baseUrl: dbP.base_url || def.baseUrl,
      tendersUrl: dbP.tenders_url || def.tendersUrl,
      loginUrl: dbP.login_url || def.loginUrl,
      accessMode: (dbP.access_mode as any) || def.accessMode,
      verifiedStatus: dbP.verified_status || def.verifiedStatus,
      sessionCookies: dbP.session_cookies || undefined
    };
  });

  if (targetPortalId) {
    list = list.filter(p => p.id === targetPortalId);
  }

  return list;
}

/**
 * Executes a full scan across all active portals or a single target portal
 */
export async function startCrawlerScan(targetPortalId?: string, awaitCompletion: boolean = false): Promise<ScanStatus> {
  if (currentScanStatus.isScanning) {
    return currentScanStatus;
  }

  const allPortals = getActivePortalsList(targetPortalId);
  // In automated full scans, skip offline_broken portals unless explicitly triggered individually
  const portalsToScan = targetPortalId 
    ? allPortals 
    : allPortals.filter(p => p.accessMode !== 'offline_broken');

  currentScanStatus = {
    isScanning: true,
    currentPortal: null,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: portalsToScan.length,
    newTendersFound: 0,
    corrigendaFound: 0,
    lastScanTimestamp: currentScanStatus.lastScanTimestamp
  };
  broadcastProgress();

  const scanExecution = async () => {
    try {
      const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);

      for (let i = 0; i < portalsToScan.length; i++) {
        const portal = portalsToScan[i];
        currentScanStatus.currentPortal = portal.name;
        currentScanStatus.progressPercent = Math.round((i / portalsToScan.length) * 100);
        broadcastProgress();

        // Update portal state to scanning
        updatePortalHealth(portal.id, { status: 'scanning' });

        try {
          const scrapeResult = await scrapePortal(portal);

          if (scrapeResult.hitlRequired) {
            updatePortalHealth(portal.id, {
              status: 'hitl_required',
              last_scan_at: new Date().toISOString(),
              last_error_message: scrapeResult.isLoginRequired
                ? 'Login credentials or active session required'
                : 'Verification challenge detected (Cloudflare Turnstile or CAPTCHA)'
            });
          } else {
            const rawItems = scrapeResult.items;
            let itemsMatched = 0;

            for (const item of rawItems) {
              try {
                const result = await processAndSaveTender(item, portal, activeTracks);
                if (result.isNew) currentScanStatus.newTendersFound++;
                if (result.hasCorrigendum) currentScanStatus.corrigendaFound++;
                if (result.matched) itemsMatched++;
              } catch (itemErr: any) {
                console.warn(`[Crawler] Failed saving item from ${portal.id}:`, itemErr.message);
              }
            }

            // Consecutive zero yields tracks raw items count (website structure/selector failure), not keyword match rate
            const health = db.prepare('SELECT consecutive_zero_yields FROM portal_health WHERE portal_id = ?').get(portal.id) as any;
            const currentZeros = health?.consecutive_zero_yields || 0;
            const newZeros = rawItems.length === 0 ? currentZeros + 1 : 0;
            const nextStatus = newZeros >= 3 ? 'selector_broken' : 'online';

            updatePortalHealth(portal.id, {
              status: nextStatus,
              last_scan_at: new Date().toISOString(),
              last_items_found: itemsMatched,
              consecutive_zero_yields: newZeros,
              last_error_message: rawItems.length === 0
                ? '0 tenders found on page — check website URL manually if active tenders are expected'
                : null
            });
          }
        } catch (err: any) {
          console.error(`[Crawler] Error scanning portal ${portal.id}:`, err.message || err);
          updatePortalHealth(portal.id, {
            status: 'error',
            last_scan_at: new Date().toISOString(),
            last_error_message: err.message || 'Scrape connection failure'
          });
        }

        currentScanStatus.completedPortals = i + 1;
        currentScanStatus.progressPercent = Math.round(((i + 1) / portalsToScan.length) * 100);
        broadcastProgress();

        // Human-like pause before next portal if more remain
        if (i < portalsToScan.length - 1) {
          const delay = getHumanJitterDelay(2000, 4500);
          await crawlerDeps.sleep(delay);
        }
      }
    } finally {
      currentScanStatus.isScanning = false;
      currentScanStatus.currentPortal = null;
      currentScanStatus.lastScanTimestamp = new Date().toISOString();
      currentScanStatus.progressPercent = 100;
      broadcastProgress();
    }
    return currentScanStatus;
  };

  if (awaitCompletion) {
    return await scanExecution();
  } else {
    scanExecution().catch(err => console.error('[Crawler] Background scan error:', err));
    return currentScanStatus;
  }
}

export interface RawScrapedItem {
  referenceNo?: string;
  title: string;
  organization: string;
  directUrl: string;
  publishDate?: string;
  closingDate?: string | null;
  estimatedValue?: string;
  location?: string;
  description?: string;
  isCorrigendum?: boolean;
  attachmentUrls?: string[];
}

export interface ScrapeResult {
  items: RawScrapedItem[];
  hitlRequired: boolean;
  isLoginRequired?: boolean;
}

export const crawlerDeps = {
  fetchHtml: fetchHtmlWithTolerantAgent,
  sleep: (ms: number) => sleep(ms)
};

export {
  isValidCalendarDay,
  MONTH_NAMES,
  parseDateString,
  formatClosingDate,
  DATE_CANDIDATE_PATTERN,
  extractDatesFromText
} from './dateParser.js';
import {
  parseDateString,
  formatClosingDate,
  DATE_CANDIDATE_PATTERN,
  extractDatesFromText
} from './dateParser.js';

const GENERIC_LINK_LABELS = /^(download(?:\s+rfp|\s+specs|\s+doc|\s+file)?|click\s+to\s+view|view(?:\s+details|\s+file)?|details|advertisement|bidding\s+document|nit\s+document|boq\s+document|rfq\s+document|bid\s+document|evaluation\s+report|tender\s+document|read\s+more|open|apply|corrigendum|asset\s+register|o&m\s+manuals|drawings)$/i;

function resolvePortalUrl(href: string | undefined, portal: PortalDefinition): string {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return portal.tendersUrl;
  try {
    const resolved = href.startsWith('http') ? new URL(href) : new URL(href, portal.baseUrl);
    resolved.pathname = resolved.pathname.replace(/\/{2,}/g, '/');
    return resolved.toString();
  } catch {
    return portal.tendersUrl;
  }
}

/**
 * Checks whether a title or filename represents a post-bid evaluation report, pre-bid meeting minutes,
 * annual procurement plan, or architectural/CAD drawing rather than an open tender opportunity.
 */
export function isNonBidEvaluationOrPlanTitle(title: string, url?: string): boolean {
  const cleanTitle = (title || '').replace(/\s+/g, ' ').trim();
  const fileSlug = url
    ? decodeURIComponent(url.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim()
    : '';
  const combined = `${cleanTitle} ${fileSlug}`;

  // 1. Post-bid evaluation reports (Technical / Financial / Final / PPRA Evaluation Report)
  if (
    /^(?:ppra\s+)?(?:technical\s+|financial\s+|final\s+|bid\s+)?eval(?:ua|u)tion\s+report\b/i.test(cleanTitle) ||
    /\b(?:technical|financial|final|bid)\s+eval(?:ua|u)tion\s+(?:report|as\s+per\s+ppra)\b/i.test(combined) ||
    /^evaluation\s+report\b/i.test(cleanTitle)
  ) {
    return true;
  }

  // 2. Pre-bid minutes, procurement plans, templates, and non-tender notices
  if (
    /^(?:minutes?\s+of\s+pre[- ]?bid|minuets?\s+of\s+meeting|mom\s+of\s+|annual\s+procurement\s+plan|cancellation(?:\s+notice)?|approval\s+mechanism|management\s+team\s+cv\s+format|cv\s+format|list\s+of\s+trades|manual\s+skills\s+scholarship\s+program\s+system|formats?)$/i.test(cleanTitle) ||
    /\b(?:annual\s+procurement\s+plan|minutes?\s+of\s+pre[- ]?bid|minuets?\s+of\s+meeting)\b/i.test(combined)
  ) {
    return true;
  }

  // 3. CAD floor plans, site plans, asset registers, and bid summaries (e.g. PSEB sub-files like "SITE PLANGround")
  if (
    /(?:site\s*plan|floor\s*plans?|ground\s*floor|elevation\s*plan|cad\s*drawing|assets?\s*register|bid\s*summary|tech\s+destination\s+of\s+the\s+year|approval\s+mechanism)/i.test(combined)
  ) {
    return true;
  }

  return false;
}

function extractRefFromText(text: string): string | undefined {
  const refMatch = text.match(/(?:\bTS[-/]?\d{3,10}\b|\bPID\s*\([A-Z]+\)\s*\d+\b|\b[A-Z]{2,10}[-/][A-Z0-9/-]*\d[A-Z0-9/-]{1,20}\b)/i);
  return refMatch && isValidReferenceNo(refMatch[0]) ? refMatch[0] : undefined;
}

/**
 * Strips repeated titles, dates, serial numbers, and generic button words from raw table/card text
 * so the summary never displays noisy table garbage. Returns empty string if no genuine scope text remains.
 */
export function cleanRowSummary(rowText: string, title: string, $el?: cheerio.Cheerio<any>): string {
  if ($el) {
    const paragraphs: string[] = [];
    $el.find('p').each((_, p) => {
      const pText = $el.find(p).text().replace(/\s+/g, ' ').trim();
      if (
        pText.length >= 20 &&
        !/^(reference|organization|submission deadline|published|closing date|opening date)\s*:/i.test(pText) &&
        pText.toLowerCase() !== title.toLowerCase()
      ) {
        paragraphs.push(pText);
      }
    });
    if (paragraphs.length > 0) {
      return paragraphs.join('\n').slice(0, 500);
    }
  }

  let cleaned = rowText.replace(/\s+/g, ' ').trim();
  if (title) {
    cleaned = cleaned.split(title).join(' ');
  }
  // Remove dates, standalone row numbers, and generic action button labels
  cleaned = cleaned
    .replace(new RegExp(DATE_CANDIDATE_PATTERN, 'gi'), ' ')
    .replace(/\b(?:download(?:\s+rfp|\s+specs|\s+doc|\s+file)?|click\s+to\s+view|view(?:\s+details|\s+file)?|details|advertisement|tender\s+document|read\s+more|open|apply|submission\s+date|opening\s+date|closing\s+date|publish\s+date|published|due\s+date|closed|active)\b/gi, ' ')
    .replace(/^\s*\d+\s*/, '')
    .replace(/[|•:,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 25 || cleaned.toLowerCase() === title.toLowerCase()) {
    return '';
  }
  return cleaned.slice(0, 350);
}

function collectRowAttachments($: cheerio.CheerioAPI, el: any, portal: PortalDefinition): string[] {
  const attachmentUrls: string[] = [];
  $(el).find('a[href], a[data-downloadurl]').each((__, aEl) => {
    const aHref = $(aEl).attr('data-downloadurl') || $(aEl).attr('href');
    if (
      aHref &&
      (/\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(aHref) ||
       /[?&]wpdmdl=\d+/i.test(aHref) ||
       $(aEl).hasClass('wpdm-download-link'))
    ) {
      if (aHref.startsWith('#') || aHref.startsWith('javascript:')) return;
      const absUrl = resolvePortalUrl(aHref, portal);
      if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
    }
  });
  $(el).find('img').each((__, imgEl) => {
    const src = $(imgEl).attr('data-lazy-src') || $(imgEl).attr('data-src') || $(imgEl).attr('src');
    const cls = ($(imgEl).attr('class') || '').toLowerCase();
    if (
      src &&
      !src.startsWith('data:') &&
      /\.(jpe?g|png|webp)(\?|$)/i.test(src) &&
      !/logo|icon|avatar|spinner|zoom-onhover|banner|flag|placeholder|download-icon/i.test(src) &&
      !cls.includes('on-hover-image')
    ) {
      const absUrl = resolvePortalUrl(src, portal);
      if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
    }
  });
  return attachmentUrls;
}

/**
 * Parses raw HTML string from a portal into structured items or detects verification challenge.
 */
export function parsePortalHtml(html: string, portal: PortalDefinition): ScrapeResult {
  const $ = cheerio.load(html);
  const items: RawScrapedItem[] = [];

  // Hard Cloudflare / FortiWeb / Gov WAF / challenge block checks (Bug B4)
  if (
    $('iframe[src*="challenges.cloudflare.com"], #cf-browser-verification').length > 0 ||
    html.includes('cf-browser-verification') ||
    html.includes('challenges.cloudflare.com') ||
    html.includes('Just a moment...') ||
    html.includes('Attention Required! | Cloudflare') ||
    /Web Page Blocked!|Attack ID:\s*\d+|FortiWeb|The page cannot be displayed\.\s*Please contact the administrator/i.test(html)
  ) {
    return { items: [], hitlRequired: true };
  }

  // Generic CAPTCHA check only triggers on small challenge pages without content (prevents false-positives on WP footer widgets)
  if (
    $('iframe[src*="cloudflare"], #captcha, input[name*="captcha"]').length > 0 &&
    html.length < 50000 &&
    !$('table, .tender-card, .package-title, .inner-advertisement-listing-box, a[href*=".pdf"]').length
  ) {
    return { items: [], hitlRequired: true };
  }

  // Check for login forms or credentials requirement (Bug B5)
  if (
    portal.accessMode === 'login_required' &&
    !(portal as any).sessionCookies &&
    $('a[href*="login.php"], a[href*="/login"]').length > 0 &&
    !$('.tender-item, .procurement-item').length
  ) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }
  const hasLoginForm = $('input[type="password"]').length > 0 ||
    /login to continue|enter credentials|sign in to access|session expired/i.test(html);
  if (hasLoginForm && !$('table, .tender-row, .notice-item, .procurement-item, .tender-card, .package-title, .tender-item').length) {
    return { items: [], hitlRequired: true, isLoginRequired: true };
  }

  // 1. Structured NDMA tender cards (.tender-card)
  if ($('.tender-card').length > 0) {
    $('.tender-card').each((_, el) => {
      const titleLink = $(el).find('.tender-card__title a').first();
      const title = (titleLink.text() || $(el).find('.tender-card__title').text()).replace(/\s+/g, ' ').trim();
      if (title.length <= 5) return;

      const href = titleLink.attr('href');
      const fullUrl = resolvePortalUrl(href, portal);
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      const subText = $(el).find('[data-label*="Submission"], [data-label*="Closing"]').text().trim();
      const openText = $(el).find('[data-label*="Opening"], [data-label*="Publish"]').text().trim();
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();

      const fallbackDates = extractDatesFromText(rowText);
      const closingDate = parseDateString(subText) || fallbackDates.closingDate;
      const publishDate = parseDateString(openText) || fallbackDates.publishDate;

      const attachmentUrls = collectRowAttachments($, el, portal);
      if (href && /\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(href) && !attachmentUrls.includes(fullUrl)) {
        attachmentUrls.unshift(fullUrl);
      }

      items.push({
        referenceNo: extractRefFromText(rowText),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 2. Structured WordPress Download Manager cards (FDE: h3.package-title)
  if ($('h3.package-title').length > 0) {
    $('h3.package-title').each((_, el) => {
      const link = $(el).find('a').first();
      const rawTitle = (link.text() || $(el).text()).replace(/\s+/g, ' ').trim();
      if (rawTitle.length <= 5) return;

      const fullUrl = resolvePortalUrl(link.attr('href'), portal);
      const cardEl = $(el).closest('.card, .media, article, .wpdm-link-tpl, .col-md-4, .col-md-6');
      const rowText = (cardEl.length ? cardEl.text() : rawTitle).replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      // Strip leading date prefix from title if present (e.g. "22-08-2026, RENOVATION OF...")
      const cleanTitle = rawTitle.replace(/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s*[,:-]?\s*/, '').trim() || rawTitle;
      if (isNonBidEvaluationOrPlanTitle(cleanTitle, fullUrl)) return;

      const attachmentUrls = cardEl.length ? collectRowAttachments($, cardEl.get(0), portal) : [];

      items.push({
        referenceNo: extractRefFromText(rowText),
        title: cleanTitle,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, cleanTitle, cardEl.length ? cardEl : undefined),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3. Structured PSDF advertisement listing boxes (.inner-advertisement-listing-box) & dropdown PDFs (#tendersdownload-button)
  if ($('.inner-advertisement-listing-box').length > 0 || $('#tendersdownload-button .dropdown-content a[href$=".pdf"]').length > 0) {
    const seenTitles = new Set<string>();
    const seenUrls = new Set<string>();

    // 3a. Parse active tender PDFs in #tendersdownload-button .dropdown-content
    $('#tendersdownload-button .dropdown-content a[href$=".pdf"], .dropdown-content a[href$=".pdf"]').each((_, aEl) => {
      const href = $(aEl).attr('href');
      if (!href) return;
      // Skip historical archive years 2020-2024 on PSDF uploads
      if (/\/wp-content\/uploads\/202[0-4]\//i.test(href)) return;

      const fullUrl = resolvePortalUrl(href, portal);
      if (seenUrls.has(fullUrl)) return;

      const liText = $(aEl).find('li').first().text().replace(/\s+/g, ' ').trim() || $(aEl).text().replace(/\s+/g, ' ').trim();
      const fileSlug = decodeURIComponent(fullUrl.split('/').pop() || '')
        .replace(/\.pdf$/i, '')
        .replace(/^(?:Tender[-_ ]Document[-_ ]|Bidding[-_ ]Document[-_ ])/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();

      const isGenericLabel = !liText || GENERIC_LINK_LABELS.test(liText) || /^(tender\s+document(?:\s+uploaded)?|bidding\s+document|corrigendum(?:\s+bd|\s+tender\s+doc)?|advertisement(?:\s+\d+)?|formats?|ks)$/i.test(liText);
      const title = isGenericLabel ? fileSlug : liText;
      if (!title || title.length <= 5) return;
      if (/^(tender\s+document(?:\s+uploaded)?|bidding\s+document|corrigendum(?:\s+bd|\s+tender\s+doc)?|advertisement(?:\s+\d+)?|formats?|ks)$/i.test(title)) return;
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      const normTitle = title.toLowerCase();
      if (seenTitles.has(normTitle)) return;
      seenTitles.add(normTitle);
      seenUrls.add(fullUrl);

      const { publishDate, closingDate } = extractDatesFromText(`${title} ${fileSlug}`);
      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls: [fullUrl]
      });
    });

    // 3b. Parse advertisement listing boxes (.inner-advertisement-listing-box)
    $('.inner-advertisement-listing-box').each((_, el) => {
      const title = ($(el).find('h4.listingadver-title1').first().text() || $(el).find('h4, h3, .listingadver-title1').first().text()).replace(/\s+/g, ' ').trim();
      if (title.length <= 5 || seenTitles.has(title.toLowerCase())) return;
      if (isNonBidEvaluationOrPlanTitle(title)) return;
      seenTitles.add(title.toLowerCase());

      const attachmentUrls = collectRowAttachments($, el, portal);
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl: attachmentUrls[0] || portal.tendersUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3b. Structured BPPRA ePPS Multi-Row Table (tr.tender-row-main + sibling tr.tender-row-dates)
  if ($('tr.tender-row-main').length > 0) {
    $('tr.tender-row-main').each((_, el) => {
      const titleLink = $(el).find('.td-title-link').first();
      const rawTitleBlock = (titleLink.text() || $(el).find('.td-title-cell').first().text()).replace(/\s+/g, ' ').trim();
      if (!rawTitleBlock || rawTitleBlock.length <= 5) return;

      const refFromBlock = extractRefFromText(rawTitleBlock);
      let cleanTitle = rawTitleBlock;
      if (refFromBlock) {
        cleanTitle = cleanTitle.replace(refFromBlock, '').trim();
      }
      cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();
      if (cleanTitle.length <= 5) cleanTitle = rawTitleBlock;

      // Extract agency/department, UNSPSC category, and budget from main row cells
      const agencyText = $(el).find('td:nth-child(3)').text().replace(/\s+/g, ' ').trim();
      const unspscText = $(el).find('td:nth-child(4)').text().replace(/\s+/g, ' ').trim();
      const budgetText = (
        $(el).find('td:nth-child(5)').text() ||
        $(el).find('.td-title-footer').text()
      ).replace(/Estimated\s*budget\s*:\s*/i, '').replace(/\bOpen\b/gi, '').replace(/\s+/g, ' ').trim();

      // Extract dates from sibling .tender-row-dates rows belonging to this rowspan group
      let siblingDatesText = '';
      let nextTr = $(el).next('tr');
      let steps = 0;
      while (nextTr.length > 0 && !nextTr.hasClass('tender-row-main') && steps < 3) {
        siblingDatesText += ' ' + (nextTr.html() || nextTr.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        nextTr = nextTr.next('tr');
        steps++;
      }

      const { publishDate, closingDate } = extractDatesFromText(siblingDatesText || $(el).text());

      // Collect document links (.td-doc-link and standard file attachments)
      const attachmentUrls = collectRowAttachments($, el, portal);
      $(el).find('a.td-doc-link[href], .td-doc-links a[href]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href) {
          const absUrl = resolvePortalUrl(href, portal);
          if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
        }
      });

      const directUrl = attachmentUrls[0] || portal.tendersUrl;
      const summaryParts = [agencyText, unspscText].filter(Boolean);

      items.push({
        referenceNo: refFromBlock,
        title: cleanTitle,
        organization: agencyText || portal.name,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        estimatedValue: budgetText || undefined,
        description: summaryParts.join(' | ').slice(0, 350),
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3c. Structured GBPPRA & Laravel Job/Procurement Cards (.job-post-item)
  if ($('.job-post-item').length > 0) {
    $('.job-post-item').each((_, el) => {
      // Find reference no in [TSE-...] or similar badge
      let refNo: string | undefined;
      const refMatch = $(el).text().match(/\[?(TSE-[\w\d]+)\]?/i);
      if (refMatch) refNo = refMatch[1];

      // Extract title: from .job-post-item-header h2, h3, h4
      let title = '';
      $(el).find('.job-post-item-header h2, .job-post-item-header h3, .job-post-item-header h4').each((__, hEl) => {
        const text = $(hEl).text().replace(/\s+/g, ' ').trim();
        if (text && (!refNo || !text.includes(refNo)) && text.length > 5 && !title) {
          title = text;
        }
      });
      if (!title) {
        title = $(el).find('h2, h3, h4').last().text().replace(/\s+/g, ' ').trim();
      }
      if (!title || title.length <= 5) return;

      // Extract department/organization
      let organization = portal.name;
      const orgEl = $(el).find('.fa-university').parent();
      if (orgEl.length > 0) {
        const orgText = orgEl.text().replace(/\s+/g, ' ').trim();
        if (orgText && orgText.length > 2) organization = orgText;
      }

      // Extract dates
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      // Collect attachments (.proc_files or standard files)
      const attachmentUrls = collectRowAttachments($, el, portal);
      $(el).find('a[href*="proc_files"], a[href$=".pdf"]').each((__, aEl) => {
        const href = $(aEl).attr('href');
        if (href) {
          const absUrl = resolvePortalUrl(href, portal);
          if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
        }
      });

      // Detail link from "View Details" button or /procurementdetails/ link
      let detailUrl: string | undefined;
      const detailLink = $(el).find('a[href*="/procurementdetails/"], a.btn-primary[href]').first().attr('href');
      if (detailLink) {
        detailUrl = resolvePortalUrl(detailLink, portal);
      }
      const directUrl = detailUrl || attachmentUrls[0] || portal.tendersUrl;

      items.push({
        referenceNo: refNo || extractRefFromText(rowText),
        title,
        organization,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 3d. Structured UNGM Notice Rows (.tableRow.dataRow, .ungm-list-item, div[data-noticeid])
  if ($('.tableRow.dataRow, .ungm-list-item, div[data-noticeid]').length > 0) {
    $('.tableRow.dataRow, .ungm-list-item, div[data-noticeid]').each((_, el) => {
      const noticeLink = $(el).find('a[href*="/Public/Notice/"]').first();
      const title = (
        noticeLink.find('.ungm-title').text() ||
        noticeLink.text() ||
        $(el).find('.ungm-title, .resultTitle').text()
      ).replace(/\s+/g, ' ').trim();
      if (!title || title.length <= 5) return;

      const noticeId = $(el).attr('data-noticeid');
      const href = noticeLink.attr('href') || (noticeId ? `/Public/Notice/${noticeId}` : undefined);
      const directUrl = resolvePortalUrl(href, portal);
      const rowText = $(el).text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      // Extract UN agency or reference cell if present
      const cells = $(el).find('.tableCell');
      const refText = cells.length >= 6 ? $(cells[5]).text().replace(/\s+/g, ' ').trim() : undefined;
      const agencyText = cells.length >= 4 ? $(cells[3]).text().replace(/\s+/g, ' ').trim() : undefined;

      items.push({
        referenceNo: (refText && refText.length >= 3 && refText.length <= 40 ? refText : undefined) || extractRefFromText(rowText),
        title,
        organization: (agencyText && agencyText.length >= 2 && agencyText.length <= 60) ? `${agencyText} (${portal.name})` : portal.name,
        directUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls: collectRowAttachments($, el, portal)
      });
    });
    if (items.length > 0) return { items, hitlRequired: false };
  }

  // 4. Standard & Drupal / NinjaTable / GridView rows
  const selector = [
    'table tbody tr',
    'table#ContentPlaceHolder1_GridView1 tr',
    '.tender-row',
    '.notice-item',
    '.view-content .views-row',
    '.procurement-item',
    '.download-item',
    '.tender-item',
    '.tab-pane table tr',
    'article'
  ].join(', ');

  $(selector).each((_, el) => {
    // Skip if inside form, select, nav, header, footer, or search bar
    if ($(el).closest('form, select, nav, header, footer, .job-search, .search-form, .filter-bar, .pagination, aside').length > 0) return;

    // Skip outer <article> wrappers that contain nested tables or tender rows (fixes Ignite mega-row bug)
    if ($(el).is('article') && $(el).find('table, tbody tr, .tender-row, .tender-card, .job-post-item').length > 0) return;

    // Skip table header rows
    if ($(el).is('th') || $(el).closest('thead').length > 0 || $(el).find('th').length > $(el).find('td').length) return;

    const rowText = $(el).text().replace(/\s+/g, ' ').trim();
    if (!rowText || rowText.length < 20) return;

    // Choose the best link (prefer non-generic title links over "Download" buttons)
    let chosenHref: string | undefined;
    let chosenLinkText = '';
    $(el).find('a[href]').each((__, aEl) => {
      const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
      const aHref = $(aEl).attr('href');
      if (!chosenHref && aHref) chosenHref = aHref;
      if (!chosenLinkText && aText.length > 5 && !GENERIC_LINK_LABELS.test(aText) && !parseDateString(aText)) {
        chosenLinkText = aText;
        if (aHref) chosenHref = aHref;
      }
    });

    // Filter out category, tag, or generic navigation links
    if (
      chosenHref &&
      (/\/(category|tag|searchresults?|search|login)(\/|$)/i.test(chosenHref) ||
       /^(all newspapers|newspapers?|canteen|all categories)$/i.test(chosenLinkText))
    ) {
      return;
    }

    const fullUrl = resolvePortalUrl(chosenHref, portal);

    // Determine clean title from structured cells or non-generic link text
    let title = chosenLinkText;
    if (!title) {
      const candidateCells = [
        $(el).find('.views-field-title').first().text(),
        $(el).find('h3, h4').first().text(),
        $(el).find('td:nth-child(2)').first().text(),
        $(el).find('td:nth-child(1)').first().text()
      ];
      for (const c of candidateCells) {
        const cleaned = c.replace(/\s+/g, ' ').trim();
        if (
          cleaned.length > 5 &&
          !/^\d+$/.test(cleaned) &&
          !GENERIC_LINK_LABELS.test(cleaned) &&
          !parseDateString(cleaned)
        ) {
          title = cleaned;
          break;
        }
      }
    }
    if (!title) {
      title = rowText.slice(0, 100);
    }

    if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

    const referenceNo = extractRefFromText(rowText);

    // Disambiguate dates using explicit Drupal/table cells, <time datetime>, or row text (Bug B7)
    let { publishDate, closingDate } = extractDatesFromText(rowText);
    if (!closingDate) {
      const closingCellText = $(el).find('.views-field-field-tender-closing-date, td:nth-child(4), td:nth-child(3)').text().trim();
      closingDate = parseDateString(closingCellText);
    }
    if (!publishDate) {
      const openingCellText = $(el).find('.views-field-field-tender-opening-date, td:nth-child(3), td:nth-child(2)').text().trim();
      const candidatePub = parseDateString(openingCellText);
      if (candidatePub && candidatePub !== closingDate) {
        publishDate = candidatePub;
      }
    }

    // Collect any file or notice image attachments in row
    const attachmentUrls = collectRowAttachments($, el, portal);

    if (title.length > 5) {
      items.push({
        referenceNo,
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: cleanRowSummary(rowText, title, $(el)),
        attachmentUrls
      });
    }
  });

  // 5. Fallback for Elementor / WordPress direct PDF procurement listings (e.g. PSEB TechDestination)
  if (items.length === 0) {
    const seenUrls = new Set<string>();
    $('a[href*="/wp-content/uploads/"][href$=".pdf"], a[href*="/Tender"][href$=".pdf"]').each((_, aEl) => {
      const href = $(aEl).attr('href');
      if (!href) return;
      const fullUrl = resolvePortalUrl(href, portal);
      if (seenUrls.has(fullUrl)) return;

      const fileSlug = decodeURIComponent(fullUrl.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
      const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
      const title = (!aText || GENERIC_LINK_LABELS.test(aText)) ? fileSlug : aText;
      if (title.length <= 5) return;
      if (isNonBidEvaluationOrPlanTitle(title, fullUrl)) return;

      seenUrls.add(fullUrl);

      const containerText = $(aEl).closest('.e-con, tr, article, li, div').text().replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(containerText);

      items.push({
        referenceNo: extractRefFromText(title),
        title,
        organization: portal.name,
        directUrl: fullUrl,
        publishDate: publishDate || undefined,
        closingDate,
        description: '',
        attachmentUrls: [fullUrl]
      });
    });
  }

  return { items, hitlRequired: false };
}

/**
 * Converts raw HTML into a compact, link-preserving markdown-style digest for Gemini AI extraction.
 * Preserves <a href="...">Label</a> as [Label](resolvedUrl) while stripping scripts, styles, and chrome.
 */
export function compactHtmlForAiExtraction(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);
  $('script, style, svg, noscript, iframe, nav, footer, header, select, option, optgroup, datalist, form, .job-search, .search-form, .filter-bar, .pagination, aside').remove();

  $('a[href]').each((_, aEl) => {
    const href = $(aEl).attr('href');
    const text = $(aEl).text().replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      const absUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      $(aEl).replaceWith(` [${text || 'Link'}](${absUrl}) `);
    } catch {
      // Keep original text if URL is malformed
    }
  });

  const bodyText = ($('body').text() || $.root().text())
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  return bodyText.slice(0, 25000);
}

/**
 * Checks whether an HTML page contains explicit "0 open tenders" empty table wording.
 */
export function hasEmptyTenderTableState(html: string): boolean {
  return /no\s+active\s+(?:tenders?|records?|procurements?)|no\s+records?\s+found|currently\s+0\s+open\s+tenders?|no\s+open\s+tenders?|0\s+tenders?\s+found/i.test(html);
}

/**
 * Checks whether an HTML page has enough procurement signal words to warrant Adaptive AI DOM extraction.
 */
export function hasProcurementSignals(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 120) return false;
  const signals = [
    /\btenders?\b/i,
    /\bprocurements?\b/i,
    /\brfps?\b|\brfqs?\b/i,
    /\bbids?\b|\bbidding\b/i,
    /\bnit\b|\bnotice\s+inviting\b/i,
    /\bclosing\s+date\b|\bdead\s*line\b|\bsubmission\b/i
  ];
  let matchedCount = 0;
  for (const rx of signals) {
    if (rx.test(text)) matchedCount++;
  }
  return matchedCount >= 2;
}

/**
 * Helper that fetches HTML and returns { html, finalUrl }.
 * Uses crawlerDeps.fetchHtml when mocked in tests, or fetchHtmlWithMetadata in live production runs
 * so cross-origin 301/302 redirects (e.g. bppra.gob.pk -> bpptwo.vdc.services:5451) are accurately tracked.
 */
export async function fetchHtmlSmart(url: string, cookieStr?: string): Promise<{ html: string; finalUrl: string }> {
  if (crawlerDeps.fetchHtml !== fetchHtmlWithTolerantAgent) {
    const html = await crawlerDeps.fetchHtml(url, 0, cookieStr);
    return { html, finalUrl: url };
  }
  return fetchHtmlWithMetadata(url, 0, cookieStr);
}

export {
  scoreCandidateTenderLinks,
  sanitizeBaseOrigin,
  shouldTriggerAutoHeal,
  isAllowedPortalDomain,
  isValidHealedTendersUrl,
  hasVerifiedTenderYield,
  healPortalConnection
} from './healer.js';
import {
  shouldTriggerAutoHeal,
  isValidHealedTendersUrl,
  sanitizeBaseOrigin,
  healPortalConnection
} from './healer.js';

/**
 * Scrapes a portal via Playwright headless (if tier === 'playwright') with fallback to tolerant HTTP/Cheerio (Bug B1),
 * enhanced with Self-Healing Phase 2 (Adaptive AI Layout Extraction) and strictly gated Phase 3 (Auto-Healer on dead links only).
 */
async function scrapePortal(portal: PortalDefinition & { sessionCookies?: string }): Promise<ScrapeResult> {
  let html: string | null = null;
  let fetchError: any = null;
  let redirectedUrl: string | null = null;

  if (portal.tier === 'playwright') {
    try {
      const modName = 'playwright';
      const playwright: any = await (Function('m', 'return import(m)')(modName) as Promise<any>).catch(() => null);
      if (playwright && playwright.chromium) {
        let browser: any = null;
        try {
          browser = await playwright.chromium
            .launch({ headless: true, channel: 'chromium' })
            .catch(() => playwright.chromium.launch({ headless: true }));
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            userAgent: HUMAN_CHROME_HEADERS['User-Agent']
          });
          const page = await context.newPage();
          await page.goto(portal.tendersUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page
            .waitForSelector('table, .job-post-item, .notice-table, .tableRow.dataRow, .tender-card, a[href*=".pdf"]', { timeout: 6000 })
            .catch(() => {});
          html = await page.content();
          await browser.close();
        } catch {
          if (browser) {
            try { await browser.close(); } catch {}
          }
        }
      }
    } catch {}
  }

  if (html === null) {
    try {
      const fetched = await fetchHtmlSmart(portal.tendersUrl, portal.sessionCookies);
      html = fetched.html;
      if (fetched.finalUrl && fetched.finalUrl !== portal.tendersUrl) {
        redirectedUrl = fetched.finalUrl;
      }
    } catch (err) {
      fetchError = err;
    }
  }

  // Rule 1: Only trigger Auto-Healer on explicit dead-link HTTP errors (404/410/500), NEVER on timeouts/TLS/0-item scans
  if (fetchError || html === null) {
    if (shouldTriggerAutoHeal(fetchError, false)) {
      const healed = await healPortalConnection(portal);
      if (healed) {
        return healed.result;
      }
    }
    throw fetchError || new Error('Scrape connection failure');
  }

  let result = parsePortalHtml(html, portal);

  // Rule 2: Non-Destructive Redirect Handling — only update in-memory URL if redirect target is valid and yielded tenders
  if (redirectedUrl && result.items.length > 0 && isValidHealedTendersUrl(redirectedUrl, portal)) {
    portal.baseUrl = sanitizeBaseOrigin(redirectedUrl, portal.baseUrl);
    portal.tendersUrl = redirectedUrl;
  }

  // If 0 items returned and not a challenge/login wall or explicit empty state:
  // Run Phase 2 Adaptive AI Layout Extraction on the current page ONLY.
  // Rule 1: Do NOT run healPortalConnection on 0-item scans; preserve the URL and surface the manual URL check warning.
  if (result.items.length === 0 && !result.hitlRequired && !hasEmptyTenderTableState(html)) {
    if (hasProcurementSignals(html)) {
      const compacted = compactHtmlForAiExtraction(html, portal.baseUrl);
      const aiItems = await extractTenderListFromHtmlWithAI({
        compactedHtml: compacted,
        portalName: portal.name,
        baseUrl: portal.baseUrl,
        tendersUrl: portal.tendersUrl
      });
      if (aiItems.length > 0) {
        return { items: aiItems, hitlRequired: false };
      }
    }
  }

  return result;
}

export function fetchHtmlWithMetadata(
  url: string,
  redirectCount: number = 0,
  cookieStr?: string,
  useLegacyTls: boolean = false
): Promise<{ html: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects while loading portal page'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...HUMAN_CHROME_HEADERS };
    if (cookieStr) {
      reqHeaders['Cookie'] = cookieStr;
    }

    const req = client.get(url, {
      agent: isHttps ? (useLegacyTls ? legacySslTolerantAgent : sslTolerantAgent) : undefined,
      headers: reqHeaders,
      timeout: 25000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchHtmlWithMetadata(nextUrl, redirectCount + 1, cookieStr, useLegacyTls).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', chunk => errBody += chunk);
        res.on('end', () => {
          if (
            (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) &&
            (errBody.includes('cloudflare') || errBody.includes('Just a moment') || errBody.includes('challenge'))
          ) {
            // Return challenge HTML so parsePortalHtml flags hitlRequired (Bug B4)
            return resolve({ html: errBody, finalUrl: url });
          }
          const httpErr: any = new Error(`HTTP ${res.statusCode} from portal server`);
          httpErr.statusCode = res.statusCode;
          return reject(httpErr);
        });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, finalUrl: url }));
    });

    req.on('error', (err: any) => {
      const msg = String(err?.message || '');
      const code = String(err?.code || '');
      // Automatic fallback 1: If server speaks plain HTTP on an HTTPS URL ("wrong version number"), retry over http://
      if (isHttps && /wrong version number/i.test(msg)) {
        const httpUrl = url.replace(/^https:/i, 'http:');
        return fetchHtmlWithMetadata(httpUrl, redirectCount + 1, cookieStr, false).then(resolve).catch(() => reject(err));
      }
      // Automatic fallback 2: If modern TLS handshake fails on legacy .gov.pk server, retry once with legacySslTolerantAgent (SECLEVEL=0, TLSv1)
      if (
        isHttps &&
        !useLegacyTls &&
        (/EPROTO|ERR_SSL|TLSV1|UNSUPPORTED_PROTOCOL|ECONNRESET|socket hang up/i.test(`${code} ${msg}`))
      ) {
        return fetchHtmlWithMetadata(url, redirectCount, cookieStr, true).then(resolve).catch(() => reject(err));
      }
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

export function fetchHtmlWithTolerantAgent(url: string, redirectCount: number = 0, cookieStr?: string): Promise<string> {
  return fetchHtmlWithMetadata(url, redirectCount, cookieStr).then(res => res.html);
}

const DEFAULT_PORTAL_NAMES = new Set(PORTAL_DEFINITIONS.map(p => p.name.toLowerCase()));

/**
 * Matches scraped tender against active domain tracks and computes keyword match score
 */
export function matchTracks(
  item: RawScrapedItem,
  activeTracks: any[]
): { matchedTracks: string[]; matchedKeywords: string[]; matchScore: number } {
  // Exclude generic portal name from keyword matching to prevent 100% false-positive matches on education/skills portals
  const orgLower = (item.organization || '').toLowerCase();
  const orgForMatching = DEFAULT_PORTAL_NAMES.has(orgLower) ? '' : orgLower;
  const combinedText = `${item.title} ${item.description || ''} ${orgForMatching} ${item.referenceNo || ''}`.toLowerCase();

  const matchedTracks: string[] = [];
  const matchedKeywords: string[] = [];

  for (const track of activeTracks) {
    // Check negative keywords (exclusions)
    const hasNegative = track.negative_keywords?.some((neg: string) => combinedText.includes(neg.toLowerCase()));
    if (hasNegative) continue;

    // Check positive keywords
    const hitKeywords: string[] = [];
    for (const pos of (track.positive_keywords || [])) {
      if (combinedText.includes(pos.toLowerCase())) {
        hitKeywords.push(pos);
      }
    }

    if (hitKeywords.length > 0) {
      matchedTracks.push(track.name);
      matchedKeywords.push(...hitKeywords);
    }
  }

  const matchScore = matchedTracks.length === 0 ? 0 : Math.min(100, Math.max(30, matchedKeywords.length * 20));
  return { matchedTracks, matchedKeywords, matchScore };
}

/**
 * Matches scraped tender against active domain tracks and handles deduplication
 */
export async function processAndSaveTender(
  item: RawScrapedItem,
  portal: PortalDefinition,
  activeTracks: any[]
): Promise<{ isNew: boolean; hasCorrigendum: boolean; matched: boolean }> {
  // Keyword Matching across tracks
  const { matchedTracks, matchedKeywords, matchScore } = matchTracks(item, activeTracks);

  // If no track matched, skip saving
  if (matchedTracks.length === 0) {
    return { isNew: false, hasCorrigendum: false, matched: false };
  }

  // Check Deduplication
  const dedupMatch = findCanonicalMatch({
    referenceNo: item.referenceNo,
    title: item.title,
    organization: item.organization,
    closingDate: item.closingDate
  });

  const formattedDate = formatClosingDate(item.closingDate || null);

  if (dedupMatch.isDuplicate && dedupMatch.matchedTenderId) {
    // Append secondary source to existing tender
    const existing = db.prepare('SELECT secondary_sources, closing_date, has_corrigendum, cached_dossiers FROM tenders WHERE id = ?').get(dedupMatch.matchedTenderId) as any;
    if (existing) {
      const sources = JSON.parse(existing.secondary_sources || '[]');
      const alreadyPresent = sources.some((s: any) => s.portalName === portal.name);
      if (!alreadyPresent) {
        sources.push({
          portalName: portal.name,
          directUrl: item.directUrl,
          discoveredAt: new Date().toISOString()
        });
        db.prepare('UPDATE tenders SET secondary_sources = ? WHERE id = ?').run(JSON.stringify(sources), dedupMatch.matchedTenderId);
      }

      // Check for Corrigendum (Date extension)
      let corrigendumDetected = false;
      if (item.closingDate && existing.closing_date && item.closingDate !== existing.closing_date) {
        corrigendumDetected = true;
        const updateTx = db.transaction(() => {
          db.prepare(`
            UPDATE tenders SET closing_date = ?, closing_date_formatted = ?, has_corrigendum = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(item.closingDate, formattedDate, dedupMatch.matchedTenderId);

          db.prepare(`
            INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
            VALUES (?, ?, 'deadline_extension', ?, ?, 0)
          `).run(
            'corr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            dedupMatch.matchedTenderId,
            formatClosingDate(existing.closing_date),
            formattedDate
          );
        });
        updateTx();
      }

      return { isNew: false, hasCorrigendum: corrigendumDetected, matched: true };
    }
  }

  // B6: Skip saving new opportunities if closing date is already in the past
  if (item.closingDate) {
    const closingTime = new Date(item.closingDate).getTime();
    if (!isNaN(closingTime) && closingTime < Date.now()) {
      return { isNew: false, hasCorrigendum: false, matched: true };
    }
  }

  // Deterministic, collision-free tender primary key based on SHA-256 hash
  const idMaterial = `${portal.id}:${item.referenceNo || ''}:${normalizeText(item.title)}:${item.directUrl}`;
  const tenderHash = crypto.createHash('sha256').update(idMaterial).digest('hex').slice(0, 16);
  const tenderId = `tender-${portal.id}-${tenderHash}`;
  const canonicalId = dedupMatch.canonicalId || tenderId;

  // Insert as new Tender wrapped in a transaction
  const insertTx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO tenders (
        id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
        domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
        estimated_value, location, description, has_corrigendum, pipeline_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Opportunity')
      ON CONFLICT(id) DO UPDATE SET
        match_score = excluded.match_score,
        domain_tracks = excluded.domain_tracks,
        matched_keywords = excluded.matched_keywords,
        updated_at = CURRENT_TIMESTAMP
    `);

    insertStmt.run(
      tenderId,
      canonicalId,
      item.referenceNo || null,
      item.title,
      item.organization,
      portal.id,
      portal.name,
      item.directUrl,
      JSON.stringify(matchedTracks),
      JSON.stringify(Array.from(new Set(matchedKeywords))),
      matchScore,
      item.publishDate || new Date().toISOString().slice(0, 10),
      item.closingDate || null,
      formattedDate,
      item.estimatedValue || null,
      item.location || 'Pakistan',
      item.description ?? '',
      item.isCorrigendum ? 1 : 0
    );
  });

  insertTx();

  // If tender notice has downloadable attachments, cache first attachment in background
  if (item.attachmentUrls && item.attachmentUrls.length > 0) {
    const firstUrl = item.attachmentUrls[0];
    const isImage = /\.(jpe?g|png|webp)(\?|$)/i.test(firstUrl);
    const label = isImage ? 'Tender Notice Image' : deriveDossierLabel(firstUrl, `${item.title.slice(0, 30)}_Doc`);
    downloadAndCacheDossier(tenderId, firstUrl, label).then(async (doc) => {
      if (doc) {
        db.prepare('UPDATE tenders SET cached_dossiers = ? WHERE id = ?').run(JSON.stringify([doc]), tenderId);
        // If document is an image or PDF and tender lacks date, reference, or summary, attempt Gemini extraction
        if ((doc.mimeType.startsWith('image/') || doc.mimeType === 'application/pdf') && (!item.closingDate || !item.referenceNo || !item.description)) {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const filename = decodeURIComponent(path.basename(doc.localPath));
            const diskPath = path.resolve(DOSSIERS_DIR, tenderId, filename);
            if (fs.existsSync(diskPath)) {
              const imgBuffer = fs.readFileSync(diskPath);
              const ocrResult = await extractTenderFromImage(imgBuffer, doc.mimeType);
              if (ocrResult) {
                if (ocrResult.referenceNo && !item.referenceNo) {
                  db.prepare('UPDATE tenders SET reference_no = ? WHERE id = ?').run(ocrResult.referenceNo, tenderId);
                }
                if (ocrResult.closingDateISO && !item.closingDate) {
                  db.prepare('UPDATE tenders SET closing_date = ?, closing_date_formatted = ? WHERE id = ?').run(
                    ocrResult.closingDateISO,
                    ocrResult.closingDateFormatted || formatClosingDate(ocrResult.closingDateISO),
                    tenderId
                  );
                }
                if (ocrResult.summaryScope && !item.description) {
                  db.prepare('UPDATE tenders SET description = ? WHERE id = ?').run(ocrResult.summaryScope, tenderId);
                }
                if (ocrResult.estimatedValue && !item.estimatedValue) {
                  db.prepare('UPDATE tenders SET estimated_value = ? WHERE id = ?').run(ocrResult.estimatedValue, tenderId);
                }
              }
            }
          } catch (ocrErr: any) {
            console.warn('[OCR] Background extraction warning:', ocrErr.message);
          }
        }
      }
    }).catch(() => {});
  }

  return { isNew: true, hasCorrigendum: Boolean(item.isCorrigendum), matched: true };
}

/**
 * On-demand detail-page fetcher + Gemini AI analyzer for a single tender.
 * When forceRefresh is true, re-fetches the live portal page and updates attachments/summary.
 */
/**
 * Checks whether a URL is a generic listing page, root portal URL, or main tenders index
 * rather than a specific individual tender detail page or document.
 */
export function isGenericListingUrl(url: string, portalDef?: PortalDefinition): boolean {
  if (!url) return true;
  try {
    const cleanUrl = url.replace(/\/+$/, '').toLowerCase();
    if (portalDef) {
      const cleanBase = portalDef.baseUrl.replace(/\/+$/, '').toLowerCase();
      const cleanTenders = portalDef.tendersUrl.replace(/\/+$/, '').toLowerCase();
      if (cleanUrl === cleanBase || cleanUrl === cleanTenders) return true;
    }
    const parsed = new URL(url);
    return parsed.pathname === '' || parsed.pathname === '/' || /^\/(tenders?|active-tenders?|procurements?)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function analyzeTenderById(tenderId: string, options: { forceRefresh?: boolean } = {}): Promise<Tender | null> {
  const tender = getTenderById(tenderId);
  if (!tender) return null;

  const fs = await import('fs');
  const path = await import('path');
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

  // 2. Run Gemini AI on the first cached image/PDF if available and Gemini API key exists
  let aiResult = null;
  if (getGeminiApiKey()) {
    for (const doc of dossiers) {
      if (doc.mimeType?.startsWith('image/') || doc.mimeType === 'application/pdf') {
        const filename = decodeURIComponent(path.basename(doc.localPath));
        const diskPath = path.resolve(DOSSIERS_DIR, tender.id, filename);
        if (fs.existsSync(diskPath)) {
          const buf = fs.readFileSync(diskPath);
          aiResult = await extractTenderFromImage(buf, doc.mimeType);
          if (aiResult) break;
        }
      }
    }

    // 3. Fallback: summarize detail page text (or existing title/description) with Gemini AI
    if (!aiResult) {
      const textToAnalyze = detailText || tender.description || tender.title;
      aiResult = await summarizeTenderTextWithAI({
        title: tender.title,
        organization: tender.organization,
        rawText: textToAnalyze
      });
    }
  }

  // 4. Persist newly discovered dossiers and extracted fields
  const updates: Parameters<typeof updateTenderFields>[1] = {
    cached_dossiers: dossiers
  };

  if (aiResult) {
    if (aiResult.summaryScope) updates.description = aiResult.summaryScope;
    if (aiResult.referenceNo) updates.reference_no = aiResult.referenceNo;
    if (aiResult.estimatedValue) updates.estimated_value = aiResult.estimatedValue;
    if (aiResult.closingDateISO) {
      const parsedIso = parseDateString(aiResult.closingDateISO) || aiResult.closingDateISO;
      const formatted = aiResult.closingDateFormatted || formatClosingDate(parsedIso);
      
      // Check if closing date was extended
      if (tender.closing_date && parsedIso !== tender.closing_date) {
        const oldTime = new Date(tender.closing_date).getTime();
        const newTime = new Date(parsedIso).getTime();
        if (!isNaN(oldTime) && !isNaN(newTime) && newTime > oldTime) {
          const logId = `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          try {
            db.prepare(`
              INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
              VALUES (?, ?, 'deadline_extension', ?, ?, 0)
            `).run(logId, tender.id, tender.closing_date_formatted || tender.closing_date, formatted);
            updates.has_corrigendum = 1;
          } catch (e) {
            console.warn('[Refresh] Could not insert corrigendum log:', e);
          }
        }
      }
      updates.closing_date = parsedIso;
      updates.closing_date_formatted = formatted;
    }
  } else if (detailText && !tender.description) {
    updates.description = cleanRowSummary(detailText, tender.title);
  }

  return updateTenderFields(tender.id, updates);
}

/**
 * Seeds a high-fidelity realistic dataset representing real-world tenders
 * across Pakistani statutory portals on fresh install.
 */
export function seedRealisticTenders() {
  const count = (db.prepare('SELECT COUNT(*) as c FROM tenders').get() as any).c;
  if (count > 0) return;

  const sampleTenders = [
    {
      referenceNo: 'EPADS-2026-SLR-041',
      title: 'Solarization of 150 Public Schools and Rural Health Centers in Southern Punjab (Phase-II)',
      organization: 'Punjab Energy Department / Punjab eProc',
      portalId: 'punjab_eproc',
      portalName: 'Punjab PPRA (eproc.punjab.gov.pk)',
      directUrl: 'http://eproc.punjab.gov.pk/ActiveTenders.aspx',
      closingDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 4 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 85,000,000',
      location: 'Multan & Bahawalpur, Punjab',
      description: 'Turnkey EPC contract for design, supply, installation, testing and commissioning of 10kW to 25kW hybrid solar photovoltaic (PV) systems with net metering and lithium iron phosphate (LiFePO4) storage banks.',
      tracks: ['Solar & Clean Energy'],
      keywords: ['solarization', 'pv system', 'photovoltaic', 'inverter', 'net metering'],
      score: 95
    },
    {
      referenceNo: 'MOFEPT/SOLAR/2026/08',
      title: 'Supply and Installation of 200kW Grid-Tied Rooftop Solar PV System at National Curriculum Council',
      organization: 'Ministry of Federal Education & Professional Training',
      portalId: 'mofept',
      portalName: 'Ministry of Federal Education & Professional Training',
      directUrl: 'https://mofept.gov.pk/Tenders',
      closingDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 32,500,000',
      location: 'Islamabad Capital Territory',
      description: 'Procurement of Tier-1 bifacial monocrystalline solar panels, string on-grid inverters, and net-metering bidirectional meters.',
      tracks: ['Solar & Clean Energy', 'Education & Learning'],
      keywords: ['solar panels', 'pv system', 'clean energy', 'education'],
      score: 88
    },
    {
      referenceNo: 'KPPRA-CW-2026-112',
      title: 'Rehabilitation and Infrastructure Upgradation of District Hospital Complex Swat',
      organization: 'KP Communication & Works Department',
      portalId: 'kppra',
      portalName: 'Khyber Pakhtunkhwa KPPRA (kp.eprocure.gov.pk)',
      directUrl: 'https://kp.eprocure.gov.pk',
      closingDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 6 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 142,000,000',
      location: 'Swat, Khyber Pakhtunkhwa',
      description: 'Civil works comprising structural retrofitting, architectural renovation, waterproofing, HVAC ducting, and exterior masonry rehabilitation.',
      tracks: ['Construction & Civil Works'],
      keywords: ['civil works', 'rehabilitation', 'renovation', 'infrastructure', 'masonry'],
      score: 92
    },
    {
      referenceNo: 'NDMA-INFRA-890',
      title: 'Construction of Prefabricated Flood-Resilient Community Warehouses & Emergency Hubs',
      organization: 'National Disaster Management Authority (NDMA)',
      portalId: 'ndma',
      portalName: 'National Disaster Management Authority (NDMA)',
      directUrl: 'https://ndma.gov.pk/tenders',
      closingDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 64,000,000',
      location: 'Lasbela & Naseerabad, Balochistan',
      description: 'Civil construction of elevated concrete plinths and installation of prefabricated heavy-duty insulated steel warehouses.',
      tracks: ['Construction & Civil Works'],
      keywords: ['construction', 'infrastructure', 'prefabricated', 'building repair'],
      score: 85
    },
    {
      referenceNo: 'PSDF-TVET-2026-Q4',
      title: 'Skills for High-Demand Industrial Trades: Provision of Competency-Based Training (CBT) Courses',
      organization: 'Punjab Skills Development Fund (PSDF)',
      portalId: 'psdf',
      portalName: 'Punjab Skills Development Fund (PSDF)',
      directUrl: 'https://psdf.org.pk/procurement',
      closingDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 55,000,000',
      location: 'Lahore, Faisalabad & Gujranwala',
      description: 'Engaging certified Technical & Vocational Training Institutes (TVET) to deliver 3-month and 6-month hands-on vocational courses with guaranteed post-training placement.',
      tracks: ['Vocational Training (TVET)'],
      keywords: ['tvet', 'vocational', 'skill development', 'technical training', 'capacity building'],
      score: 96
    },
    {
      referenceNo: 'FDE-EDU-2026-03',
      title: 'Printing and Supply of Single National Curriculum Supplementary Readers & Classroom Textbooks',
      organization: 'Federal Directorate of Education (FDE)',
      portalId: 'fde',
      portalName: 'Federal Directorate of Education (FDE)',
      directUrl: 'https://fde.gov.pk/download-category/tender/',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 12 * 3600 * 1000).toISOString(),
      estimatedValue: 'PKR 48,000,000',
      location: 'ICT Islamabad',
      description: 'Four-color offset printing on 75 GSM offset paper with art-card laminated covers for Grade 1 through 8 textbooks across Islamabad educational institutions.',
      tracks: ['Education & Learning', 'Stationery & Office Supplies'],
      keywords: ['education', 'curriculum', 'textbooks', 'printing', 'school supplies'],
      score: 94
    },
    {
      referenceNo: 'IGNITE-MEDIA-2026-02',
      title: 'Hiring of Creative Agency for National Innovation Documentary Series and Digital Video Production',
      organization: 'Ignite National Technology Fund',
      portalId: 'ignite',
      portalName: 'Ignite National Technology Fund',
      directUrl: 'https://ignite.org.pk/procurement/',
      closingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      estimatedValue: 'PKR 28,000,000',
      location: 'Islamabad',
      description: 'Production of 10 high-impact documentary episodes (4K cinematic grade), 25 short-form social reels, and nationwide digital public relations campaign spotlighting Pakistani tech founders and startup incubators.',
      tracks: ['Media, Documentaries & Communications'],
      keywords: ['documentary', 'media production', 'video production', 'digital communications', 'short film'],
      score: 98
    }
  ];

  const insertStmt = db.prepare(`
    INSERT INTO tenders (
      id, canonical_id, reference_no, title, organization, portal_id, portal_name, direct_url,
      domain_tracks, matched_keywords, match_score, publish_date, closing_date, closing_date_formatted,
      estimated_value, location, description, has_corrigendum, pipeline_status, status_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((tendersList: typeof sampleTenders) => {
    for (let i = 0; i < tendersList.length; i++) {
      const t = tendersList[i];
      const tenderId = `tender-${t.portalId}-${i + 1}`;
      const formattedDate = formatClosingDate(t.closingDate);
      
      let initialStatus = 'New Opportunity';
      let notes = '';
      if (i === 0) {
        initialStatus = 'Preparing Bid';
        notes = 'BOQ evaluated. Vendor quotes for solar inverters requested from Multan suppliers.';
      } else if (i === 1) {
        initialStatus = 'Under Review';
        notes = 'Evaluating NCC site access and building structural engineering clearance.';
      }

      insertStmt.run(
        tenderId,
        tenderId,
        t.referenceNo,
        t.title,
        t.organization,
        t.portalId,
        t.portalName,
        t.directUrl,
        JSON.stringify(t.tracks),
        JSON.stringify(t.keywords),
        t.score,
        new Date(Date.now() - (i * 2 + 1) * 24 * 3600 * 1000).toISOString().slice(0, 10),
        t.closingDate,
        formattedDate,
        t.estimatedValue,
        t.location,
        t.description,
        i === 0 ? 1 : 0,
        initialStatus,
        notes
      );

      if (i === 0) {
        db.prepare(`
          INSERT INTO corrigendum_logs (id, tender_id, change_type, previous_value, new_value, is_acknowledged)
          VALUES (?, ?, 'deadline_extension', '10 Nov 2026, 02:00 PM PKT', ?, 0)
        `).run('corr-seed-01', tenderId, formattedDate);
      }
    }
  });

  insertMany(sampleTenders);
}
