import { db, DOSSIERS_DIR, getAllDomainTracks, updatePortalHealth, getPortalHealthList, getTenderById, updateTenderFields } from '../db.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { findCanonicalMatch, isValidReferenceNo, normalizeText } from '../deduplicator.js';
import { getHumanJitterDelay, sleep, sslTolerantAgent, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, Tender } from '../../types.js';
import { downloadAndCacheDossier } from '../dossierManager.js';
import { extractTenderFromImage, summarizeTenderTextWithAI } from '../ocrService.js';
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
              last_error_message: rawItems.length === 0 ? 'No listings found on the last scan' : null
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

const DATE_CANDIDATE_PATTERN = `(?:\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?,?\\s+\\d{4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{4}-\\d{2}-\\d{2}(?:[\\sT]\\d{1,2}:\\d{2}(?::\\d{2})?)?)`;

/**
 * Extracts and disambiguates publish dates vs closing dates using labels and chronological sorting (Bug B7)
 */
export function extractDatesFromText(rowText: string): { publishDate: string | null; closingDate: string | null } {
  // 1. Look for explicit labels
  const closingLabelRegex = new RegExp(`(?:closing|submission|deadline|due|last)(?:[\\s\\w]{0,20}?)(?:[:\\s-])\\s*(${DATE_CANDIDATE_PATTERN})`, 'i');
  const publishLabelRegex = new RegExp(`(?:publish(?:ed)?|posted|advertised|issue(?:d)?|opening)(?:[\\s\\w]{0,20}?)(?:[:\\s-])\\s*(${DATE_CANDIDATE_PATTERN})`, 'i');

  const closingMatch = rowText.match(closingLabelRegex);
  const publishMatch = rowText.match(publishLabelRegex);

  let closingDate: string | null = closingMatch ? parseDateString(closingMatch[1]) : null;
  let publishDate: string | null = publishMatch ? parseDateString(publishMatch[1]) : null;

  if (closingDate) {
    return { publishDate, closingDate };
  }

  // 2. If no explicit closing label found, extract all candidate dates
  const globalDateRegex = new RegExp(DATE_CANDIDATE_PATTERN, 'gi');
  const matches = rowText.match(globalDateRegex) || [];
  const parsedDates: string[] = [];
  for (const m of matches) {
    const p = parseDateString(m);
    if (p && !parsedDates.includes(p)) {
      parsedDates.push(p);
    }
  }

  if (parsedDates.length === 1) {
    if (publishMatch && publishDate === parsedDates[0]) {
      return { publishDate, closingDate: null };
    }
    return { publishDate: null, closingDate: parsedDates[0] };
  }

  if (parsedDates.length >= 2) {
    parsedDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return {
      publishDate: publishDate || parsedDates[0],
      closingDate: parsedDates[parsedDates.length - 1]
    };
  }

  return { publishDate: null, closingDate: null };
}

const GENERIC_LINK_LABELS = /^(download(?:\s+rfp|\s+specs|\s+doc|\s+file)?|click\s+to\s+view|view(?:\s+details|\s+file)?|details|advertisement|tender\s+document|read\s+more|open|apply|corrigendum|asset\s+register|o&m\s+manuals|drawings)$/i;

function resolvePortalUrl(href: string | undefined, portal: PortalDefinition): string {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return portal.tendersUrl;
  try {
    return href.startsWith('http') ? href : new URL(href, portal.baseUrl).toString();
  } catch {
    return portal.tendersUrl;
  }
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
  $(el).find('a[href]').each((__, aEl) => {
    const aHref = $(aEl).attr('href');
    if (aHref && /\.(pdf|docx?|xlsx?|jpe?g|png|webp)(\?|$)/i.test(aHref)) {
      const absUrl = resolvePortalUrl(aHref, portal);
      if (!attachmentUrls.includes(absUrl)) attachmentUrls.push(absUrl);
    }
  });
  $(el).find('img[src]').each((__, imgEl) => {
    const src = $(imgEl).attr('src');
    const cls = ($(imgEl).attr('class') || '').toLowerCase();
    if (
      src &&
      /\.(jpe?g|png|webp)(\?|$)/i.test(src) &&
      !/logo|icon|avatar|spinner|zoom-onhover|banner|flag|placeholder/i.test(src) &&
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

  // Hard Cloudflare / challenge block checks (Bug B4)
  if (
    $('iframe[src*="challenges.cloudflare.com"], #cf-browser-verification').length > 0 ||
    html.includes('cf-browser-verification') ||
    html.includes('challenges.cloudflare.com') ||
    html.includes('Just a moment...') ||
    html.includes('Attention Required! | Cloudflare')
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
      const cardEl = $(el).closest('.card, .media, article');
      const rowText = (cardEl.length ? cardEl.text() : rawTitle).replace(/\s+/g, ' ').trim();
      const { publishDate, closingDate } = extractDatesFromText(rowText);

      // Strip leading date prefix from title if present (e.g. "22-08-2026, RENOVATION OF...")
      const cleanTitle = rawTitle.replace(/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s*[,:-]?\s*/, '').trim() || rawTitle;
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

  // 3. Structured PSDF advertisement listing boxes (.inner-advertisement-listing-box)
  if ($('.inner-advertisement-listing-box').length > 0) {
    const seenTitles = new Set<string>();
    $('.inner-advertisement-listing-box').each((_, el) => {
      const title = $(el).find('h4, h3, .listingadver-title1').first().text().replace(/\s+/g, ' ').trim();
      if (title.length <= 5 || seenTitles.has(title.toLowerCase())) return;
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
      // Skip non-procurement marketing/drawings files
      if (/tech destination of the year|floor plans|asset register|approval mechanism/i.test(fileSlug)) return;

      seenUrls.add(fullUrl);
      const aText = $(aEl).text().replace(/\s+/g, ' ').trim();
      const title = (!aText || GENERIC_LINK_LABELS.test(aText)) ? fileSlug : aText;
      if (title.length <= 5) return;

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
 * Scrapes a portal via Playwright headless (if tier === 'playwright') with fallback to tolerant HTTP/Cheerio (Bug B1)
 */
async function scrapePortal(portal: PortalDefinition & { sessionCookies?: string }): Promise<ScrapeResult> {
  if (portal.tier === 'playwright') {
    try {
      const modName = 'playwright';
      const playwright: any = await (Function('m', 'return import(m)')(modName) as Promise<any>).catch(() => null);
      if (playwright && playwright.chromium) {
        let browser: any = null;
        try {
          browser = await playwright.chromium.launch({ headless: true });
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(portal.tendersUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const html = await page.content();
          await browser.close();
          return parsePortalHtml(html, portal);
        } catch {
          if (browser) {
            try { await browser.close(); } catch {}
          }
        }
      }
    } catch {}
  }

  const html = await crawlerDeps.fetchHtml(portal.tendersUrl, 0, portal.sessionCookies);
  return parsePortalHtml(html, portal);
}

export function fetchHtmlWithTolerantAgent(url: string, redirectCount: number = 0, cookieStr?: string): Promise<string> {
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
      agent: isHttps ? sslTolerantAgent : undefined,
      headers: reqHeaders,
      timeout: 15000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchHtmlWithTolerantAgent(nextUrl, redirectCount + 1, cookieStr).then(resolve).catch(reject);
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
            return resolve(errBody);
          }
          return reject(new Error(`HTTP ${res.statusCode} from portal server`));
        });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

/**
 * Strict date string parsing for Pakistani tenders:
 * Checks DD/MM/YYYY and DD-MM-YYYY first with explicit PKT (+05:00) timezone,
 * preventing US-style day/month swaps on days 1-12.
 */
function isValidCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const maxDays = new Date(year, month, 0).getDate();
  return day <= maxDays;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};

const DEFAULT_PORTAL_NAMES = new Set(PORTAL_DEFINITIONS.map(p => p.name.toLowerCase()));

export function parseDateString(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const str = raw.trim();

  // Exclude known non-date text noise
  if (/^(not available|n\/a|none|null|undefined|-+)$/i.test(str)) return null;

  // Strip ordinal suffixes (1st, 2nd, 3rd, 4th..31st) and commas for uniform matching
  const cleanStr = str
    .replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    // 1. Check numeric DD/MM/YYYY or DD-MM-YYYY with optional time
    const dmyMatch = cleanStr.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      let year = parseInt(dmyMatch[3], 10);
      if (year < 100) year += 2000;

      const hour = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 14;
      const minute = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
      const second = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;

      if (
        isValidCalendarDay(year, month, day) &&
        hour >= 0 && hour < 24 &&
        minute >= 0 && minute < 60 &&
        second >= 0 && second < 60
      ) {
        const hStr = String(hour).padStart(2, '0');
        const mStr = String(minute).padStart(2, '0');
        const sStr = String(second).padStart(2, '0');
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
      return null;
    }

    // 2. Named month format (Day first): e.g. 15 Nov 2026, 30 Oct, 2026, 15-November-2026
    const namedMonthMatch = cleanStr.match(/^(\d{1,2})\s*[-/.\s]\s*([A-Za-z]{3,9})\.?\s*[-/.\s]\s*(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i);
    if (namedMonthMatch) {
      const day = parseInt(namedMonthMatch[1], 10);
      const month = MONTH_NAMES[namedMonthMatch[2].toLowerCase()];
      let year = parseInt(namedMonthMatch[3], 10);
      if (year < 100) year += 2000;

      const hour = namedMonthMatch[4] ? parseInt(namedMonthMatch[4], 10) : 14;
      const minute = namedMonthMatch[5] ? parseInt(namedMonthMatch[5], 10) : 0;
      const second = namedMonthMatch[6] ? parseInt(namedMonthMatch[6], 10) : 0;

      if (
        month &&
        isValidCalendarDay(year, month, day) &&
        hour >= 0 && hour < 24 &&
        minute >= 0 && minute < 60 &&
        second >= 0 && second < 60
      ) {
        const hStr = String(hour).padStart(2, '0');
        const mStr = String(minute).padStart(2, '0');
        const sStr = String(second).padStart(2, '0');
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
      return null;
    }

    // 2b. Named month format (Month first): e.g. September 25, 2026, Jun 30th 2026, Aug 17, 2026
    const monthFirstMatch = cleanStr.match(/^([A-Za-z]{3,9})\.?\s*[-/.\s]\s*(\d{1,2})\s*[-/.\s]\s*(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i);
    if (monthFirstMatch) {
      const month = MONTH_NAMES[monthFirstMatch[1].toLowerCase()];
      const day = parseInt(monthFirstMatch[2], 10);
      let year = parseInt(monthFirstMatch[3], 10);
      if (year < 100) year += 2000;

      const hour = monthFirstMatch[4] ? parseInt(monthFirstMatch[4], 10) : 14;
      const minute = monthFirstMatch[5] ? parseInt(monthFirstMatch[5], 10) : 0;
      const second = monthFirstMatch[6] ? parseInt(monthFirstMatch[6], 10) : 0;

      if (
        month &&
        isValidCalendarDay(year, month, day) &&
        hour >= 0 && hour < 24 &&
        minute >= 0 && minute < 60 &&
        second >= 0 && second < 60
      ) {
        const hStr = String(hour).padStart(2, '0');
        const mStr = String(minute).padStart(2, '0');
        const sStr = String(second).padStart(2, '0');
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
      return null;
    }

    // 3. ISO format YYYY-MM-DD with optional time
    const isoMatch = cleanStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      const hour = isoMatch[4] ? parseInt(isoMatch[4], 10) : 14;
      const minute = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
      const second = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;

      if (
        isValidCalendarDay(year, month, day) &&
        hour >= 0 && hour < 24 &&
        minute >= 0 && minute < 60 &&
        second >= 0 && second < 60
      ) {
        const hStr = String(hour).padStart(2, '0');
        const mStr = String(minute).padStart(2, '0');
        const sStr = String(second).padStart(2, '0');
        const d = new Date(Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hStr}:${mStr}:${sStr}+05:00`));
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
      return null;
    }

    // 4. Fallback standard parse (only if it contains digits and not noise)
    if (/\d/.test(str)) {
      const fallback = new Date(str);
      if (!isNaN(fallback.getTime())) {
        return fallback.toISOString();
      }
    }
  } catch {}

  return null;
}

export function formatClosingDate(isoDate: string | null): string {
  if (!isoDate) return 'Not Available';
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return 'Not Available';
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }) + ', ' + d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }) + ' PKT';
  } catch {
    return 'Not Available';
  }
}

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
    const label = isImage ? 'Tender Notice Image' : `${item.title.slice(0, 30)}_Doc`;
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
 * On-demand detail-page fetcher + Gemini AI analyzer for a single tender
 */
export async function analyzeTenderById(tenderId: string): Promise<Tender | null> {
  const tender = getTenderById(tenderId);
  if (!tender) return null;

  const fs = await import('fs');
  const path = await import('path');
  const dossiers = Array.isArray(tender.cached_dossiers) ? [...tender.cached_dossiers] : [];
  let detailText = '';

  // 1. If no cached files exist yet, try downloading from direct_url or scraping detail page for images/PDFs
  if (dossiers.length === 0 && tender.direct_url && tender.direct_url.startsWith('http')) {
    if (/\.(pdf|jpe?g|png|webp)(\?|$)/i.test(tender.direct_url)) {
      const isImg = /\.(jpe?g|png|webp)(\?|$)/i.test(tender.direct_url);
      const doc = await downloadAndCacheDossier(tender.id, tender.direct_url, isImg ? 'Tender Notice Image' : 'Tender Document');
      if (doc) dossiers.push(doc);
    } else {
      try {
        const html = await crawlerDeps.fetchHtml(tender.direct_url);
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer').remove();
        detailText = $('main, article, .content, .card, body').first().text().replace(/\s+/g, ' ').trim();

        const portalDef = PORTAL_DEFINITIONS.find(p => p.id === tender.portal_id) || {
          id: tender.portal_id,
          name: tender.portal_name,
          baseUrl: new URL(tender.direct_url).origin,
          tendersUrl: tender.direct_url
        } as PortalDefinition;

        const discoveredUrls = collectRowAttachments($, $('body').get(0), portalDef);
        for (const u of discoveredUrls.slice(0, 2)) {
          const isImg = /\.(jpe?g|png|webp)(\?|$)/i.test(u);
          const doc = await downloadAndCacheDossier(tender.id, u, isImg ? 'Tender Notice Image' : 'Bidding Document');
          if (doc) dossiers.push(doc);
        }
      } catch (err: any) {
        console.warn(`[Analyze] Could not fetch detail page for ${tender.id}:`, err.message);
      }
    }
  }

  // 2. Run Gemini AI on the first cached image/PDF if available
  let aiResult = null;
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

  // 4. Persist any newly discovered dossiers and extracted fields
  const updates: Parameters<typeof updateTenderFields>[1] = {
    cached_dossiers: dossiers
  };

  if (aiResult) {
    if (aiResult.summaryScope) updates.description = aiResult.summaryScope;
    if (aiResult.referenceNo && !tender.reference_no) updates.reference_no = aiResult.referenceNo;
    if (aiResult.estimatedValue && !tender.estimated_value) updates.estimated_value = aiResult.estimatedValue;
    if (aiResult.closingDateISO && !tender.closing_date) {
      const parsedIso = parseDateString(aiResult.closingDateISO) || aiResult.closingDateISO;
      updates.closing_date = parsedIso;
      updates.closing_date_formatted = aiResult.closingDateFormatted || formatClosingDate(parsedIso);
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
