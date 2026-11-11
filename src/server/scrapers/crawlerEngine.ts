import * as cheerio from 'cheerio';
import {
  getAllDomainTracks,
  getPortalById,
  updatePortalHealth,
  getPortalHealthList,
  getAppSetting,
  setAppSetting,
  seedSampleTendersIfEmpty
} from '../db.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { getHumanJitterDelay, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus } from '../../types.js';
import { extractTenderListFromHtmlWithAI } from '../ocrService.js';
import {
  beginScanBudget,
  endScanBudget,
  getActiveScanBudget
} from '../ingestBudget.js';
import {
  formatClosingDate,
  extractDatesFromText
} from './dateParser.js';
import {
  crawlerDeps,
  fetchHtmlSmart
} from './crawlerDeps.js';
import {
  RawScrapedItem,
  ScrapeResult,
  parsePortalHtml,
  sanitizeScrapedItems,
  hasEmptyTenderTableState,
  hasProcurementSignals,
  compactHtmlForAiExtraction,
  isGenericListingUrl,
  resolvePortalUrl
} from './portalParsers.js';
import {
  shouldTriggerAutoHeal,
  healPortalConnection,
  isValidHealedTendersUrl,
  sanitizeBaseOrigin
} from './healer.js';
import { processAndSaveTender } from './ingestPipeline.js';

// ===========================================================================
// Re-exports for 100% backward compatibility across all modules and tests
// ===========================================================================
export {
  isValidCalendarDay,
  MONTH_NAMES,
  parseDateString,
  formatClosingDate,
  DATE_CANDIDATE_PATTERN,
  extractDatesFromText,
  normalizeExtractedDate,
  reconcileDeadline,
  resolveCanonicalDeadline,
  inferPublishDateFromUrl,
  type DeadlineSignal
} from './dateParser.js';

export {
  fetchHtmlWithMetadata,
  fetchHtmlWithTolerantAgent
} from './htmlFetcher.js';

export {
  crawlerDeps,
  fetchHtmlSmart
} from './crawlerDeps.js';

export {
  type RawScrapedItem,
  type ScrapeResult,
  resolvePortalUrl,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  cleanRowSummary,
  isGenericListingUrl,
  isNavigationRow,
  sanitizeScrapedItems,
  collectRowAttachments,
  parsePortalHtml,
  compactHtmlForAiExtraction,
  hasEmptyTenderTableState,
  hasProcurementSignals
} from './portalParsers.js';

export {
  matchTracks,
  applyDocumentScopeToTracks,
  containsKeyword
} from './trackMatcher.js';

export {
  readCachedDossier,
  isReadableDocumentMime,
  fetchDocumentsForTender,
  analyzeTenderById
} from './tenderAnalysis.js';

export {
  UPFRONT_MAX_DOCS,
  MAX_DOCUMENTS_PER_TENDER,
  type ProcessTenderResult,
  type UpfrontExtraction,
  referencesOnlyPriorYears,
  computeTenderId,
  isDirectDocumentUrl,
  orderDocumentCandidates,
  fetchAndReadDocumentsUpfront,
  applyRescannedDeadline,
  applyRescanToExistingTender,
  holdForDocumentScope,
  processAndSaveTender
} from './ingestPipeline.js';

export {
  scoreCandidateTenderLinks,
  sanitizeBaseOrigin,
  shouldTriggerAutoHeal,
  isAllowedPortalDomain,
  isValidHealedTendersUrl,
  hasVerifiedTenderYield,
  healPortalConnection
} from './healer.js';

// ===========================================================================
// Scan State & Progress Broadcasting
// ===========================================================================

export let currentScanStatus: ScanStatus = {
  isScanning: false,
  currentPortal: null,
  progressPercent: 0,
  completedPortals: 0,
  totalPortals: PORTAL_DEFINITIONS.length,
  newTendersFound: 0,
  corrigendaFound: 0,
  heldForScope: 0,
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
  const fullScanAt = getAppSetting('last_full_scan_at') || null;
  currentScanStatus.lastFullScanTimestamp = fullScanAt;
  for (const listener of progressListeners) {
    try {
      listener({ ...currentScanStatus, lastFullScanTimestamp: fullScanAt });
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
  const canonicalMap = new Map<string, PortalDefinition>(PORTAL_DEFINITIONS.map(def => [def.id, def]));

  let list: PortalDefinition[];
  if (dbPortals.length > 0) {
    list = dbPortals.map(dbP => {
      const def = canonicalMap.get(dbP.portal_id);
      return {
        id: dbP.portal_id,
        name: dbP.portal_name || def?.name || dbP.portal_id,
        category: (dbP.category as any) || def?.category || 'Federal',
        tier: (dbP.tier as any) || def?.tier || 'cheerio',
        baseUrl: dbP.base_url || def?.baseUrl || '',
        tendersUrl: dbP.tenders_url || def?.tendersUrl || '',
        loginUrl: dbP.login_url || def?.loginUrl,
        accessMode: (dbP.access_mode as any) || def?.accessMode || 'public',
        verifiedStatus: dbP.verified_status || def?.verifiedStatus || 'Active',
        sessionCookies: dbP.session_cookies || undefined,
        description: def?.description || '',
        defaultKeywords: def?.defaultKeywords || []
      };
    });
  } else {
    list = [...PORTAL_DEFINITIONS];
  }

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
    heldForScope: 0,
    lastScanTimestamp: currentScanStatus.lastScanTimestamp
  };
  broadcastProgress();

  const scanExecution = async () => {
    // Per-scan document budget: time for upfront fetches and a Gemini Vision call cap (docs/13 §3.2).
    beginScanBudget();
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
            const budgetNow = getActiveScanBudget();
            if (budgetNow) {
              currentScanStatus.documentsDeferred = budgetNow.documentsDeferred;
              currentScanStatus.visionDeferred = budgetNow.visionDeferred;
            }

            for (const item of rawItems) {
              try {
                const result = await processAndSaveTender(item, portal, activeTracks);
                if (result.isNew) currentScanStatus.newTendersFound++;
                if (result.hasCorrigendum) currentScanStatus.corrigendaFound++;
                if (result.matched) itemsMatched++;
                if (result.awaitingScope) currentScanStatus.heldForScope = (currentScanStatus.heldForScope || 0) + 1;
              } catch (itemErr: any) {
                console.warn(`[Crawler] Failed saving item from ${portal.id}:`, itemErr.message);
              }
            }

            // Consecutive zero yields tracks raw items count (website structure/selector failure), not keyword match rate
            const health = getPortalById(portal.id);
            const currentZeros = health?.consecutive_zero_yields || 0;
            const newZeros = rawItems.length === 0 ? currentZeros + 1 : 0;
            const nextStatus = newZeros >= 3 ? 'selector_broken' : 'online';

            const nowIso = new Date().toISOString();
            updatePortalHealth(portal.id, {
              status: nextStatus,
              last_scan_at: nowIso,
              last_success_at: nowIso,
              last_items_found: itemsMatched,
              consecutive_zero_yields: newZeros,
              pages_scanned: scrapeResult.pagesScanned || 1,
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
            last_items_found: 0,
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
      const budget = endScanBudget();
      currentScanStatus.documentsDeferred = budget?.documentsDeferred ?? 0;
      currentScanStatus.visionDeferred = budget?.visionDeferred ?? 0;
      currentScanStatus.isScanning = false;
      currentScanStatus.currentPortal = null;
      currentScanStatus.lastScanTimestamp = new Date().toISOString();
      currentScanStatus.progressPercent = 100;
      if (!targetPortalId) {
        setAppSetting('last_full_scan_at', currentScanStatus.lastScanTimestamp);
      }
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

/**
 * Scrapes a portal via Playwright headless (if tier === 'playwright') with fallback to tolerant HTTP/Cheerio (Bug B1),
 * enhanced with Self-Healing Phase 2 (Adaptive AI Layout Extraction) and strictly gated Phase 3 (Auto-Healer on dead links only).
 */
export async function scrapePortal(portal: PortalDefinition & { sessionCookies?: string }): Promise<ScrapeResult> {
  let html: string | null = null;
  let fetchError: any = null;
  let redirectedUrl: string | null = null;
  let playwrightError: Error | null = null;

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
        } catch (pwErr: any) {
          playwrightError = pwErr;
          console.warn(`[Crawler] Playwright execution failed for ${portal.id}:`, pwErr?.message || pwErr);
          if (browser) {
            try { await browser.close(); } catch {}
          }
        }
      } else {
        playwrightError = new Error('Playwright or Chromium binary not available on host');
        console.warn(`[Crawler] Playwright not available for ${portal.id}`);
      }
    } catch (e: any) {
      playwrightError = e;
    }
  }

  if (html === null) {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fetched = await fetchHtmlSmart(portal.tendersUrl, portal.sessionCookies);
        html = fetched.html;
        if (fetched.finalUrl && fetched.finalUrl !== portal.tendersUrl) {
          redirectedUrl = fetched.finalUrl;
        }
        fetchError = null;
        break;
      } catch (err: any) {
        fetchError = err;
        const isTimeout = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(err?.message || err?.code || '');
        if (isTimeout && attempt < maxRetries) {
          const backoffMs = attempt === 0 ? 30000 : 120000;
          console.log(`[Crawler] Timed out fetching ${portal.id}, retrying attempt ${attempt + 1}/${maxRetries} after backoff...`);
          await crawlerDeps.sleep(backoffMs);
          continue;
        }
        break;
      }
    }

    if (portal.tier === 'playwright' && playwrightError && (fetchError || html === null)) {
      const pwMsg = playwrightError.message || 'Playwright launch/render failed';
      fetchError = new Error(`Playwright error: ${pwMsg}${fetchError ? ` (HTTP fallback: ${fetchError.message})` : ''}`);
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
  result.items = sanitizeScrapedItems(result.items, portal);

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
        return { items: sanitizeScrapedItems(aiItems, portal), hitlRequired: false };
      }
    }
  }

  // Pagination loop (docs/15 F1): read subsequent listing pages up to maxPages
  let pagesScanned = 1;
  if (portal.pagination && portal.pagination.maxPages > 1 && !result.hitlRequired && result.items.length > 0) {
    const maxPages = portal.pagination.maxPages;
    const seenUrls = new Set(result.items.map(it => (it.directUrl || it.title).toLowerCase()));

    for (let page = 2; page <= maxPages; page++) {
      let pageUrl: string;
      if (portal.pagination.kind === 'query') {
        try {
          const u = new URL(portal.tendersUrl);
          u.searchParams.set(portal.pagination.param || 'page', String(page));
          pageUrl = u.toString();
        } catch {
          break;
        }
      } else if (portal.pagination.kind === 'path') {
        pageUrl = (portal.pagination.pathPattern || `${portal.tendersUrl}/{page}`).replace('{page}', String(page));
      } else {
        break;
      }

      try {
        await crawlerDeps.sleep(getHumanJitterDelay(1500, 3000));
        const pageFetched = await fetchHtmlSmart(pageUrl, portal.sessionCookies);
        if (!pageFetched.html) break;

        const pageParsed = parsePortalHtml(pageFetched.html, portal);
        const cleanPageItems = sanitizeScrapedItems(pageParsed.items, portal);
        if (cleanPageItems.length === 0) {
          // Stop on empty page (Rule 1: empty later page never triggers Auto-Heal or counts towards zero yields)
          break;
        }

        let newOnThisPage = 0;
        for (const item of cleanPageItems) {
          const key = (item.directUrl || item.title).toLowerCase();
          if (!seenUrls.has(key)) {
            seenUrls.add(key);
            result.items.push(item);
            newOnThisPage++;
          }
        }

        if (newOnThisPage === 0) {
          break; // Stop when page yields only items already seen
        }
        pagesScanned++;
      } catch {
        // A network or parse error on subsequent pages must not fail the entire scrape
        break;
      }
    }
  }
  result.pagesScanned = pagesScanned;

  // Enrich dates for undated items from detail pages (e.g. WPDM / FDE cards where dates exist on detail page)
  const undatedItems = result.items.filter(it => !it.closingDate && !it.publishDate && it.directUrl && !isGenericListingUrl(it.directUrl, portal));
  if (undatedItems.length > 0 && undatedItems.length <= 20) {
    await Promise.allSettled(undatedItems.map(async (it) => {
      try {
        const detailHtml = await crawlerDeps.fetchHtml(it.directUrl);
        const detail$ = cheerio.load(detailHtml);
        detail$('script, style, nav, header, footer, aside, noscript').remove();

        // 1. Creation / Publish Date: select deepest element carrying Create Date / Creation Date (A10)
        const createEl = detail$('*').filter((_, e) => {
          return detail$(e).children().length === 0 && /(?:create|creation)\s*date/i.test(detail$(e).text());
        });
        if (createEl.length > 0) {
          const parentText = detail$(createEl[0]).parent().text().replace(/\s+/g, ' ');
          const elText = detail$(createEl[0]).text().replace(/\s+/g, ' ');
          const textToParse = parentText.length < 150 ? parentText : elText;
          const parsed = extractDatesFromText(textToParse);
          if (parsed.publishDate && !it.publishDate) {
            it.publishDate = parsed.publishDate;
          }
          // Never assign a closing date from a creation date (docs/16 A10)
        }

        // 2. Closing Date: only from explicit closing-type labels inside main content (main, article, .wpdm-*, body)
        const mainContainer = detail$('main, article, [class*="wpdm"], .content, #content, body');
        const closingEl = mainContainer.find('*').filter((_, e) => {
          return detail$(e).children().length === 0 && /\b(closing|submission|dead\s*line|due|last)\b/i.test(detail$(e).text());
        });
        if (closingEl.length > 0) {
          const parentText = detail$(closingEl[0]).parent().text().replace(/\s+/g, ' ');
          const elText = detail$(closingEl[0]).text().replace(/\s+/g, ' ');
          const textToParse = parentText.length < 150 ? parentText : elText;
          const parsed = extractDatesFromText(textToParse);
          if (parsed.closingDate && !it.closingDate) {
            it.closingDate = parsed.closingDate;
          }
        }

        // Collect download links from detail page if attachments not yet populated (e.g. FDE WPDM packages)
        detail$('a[href*="wpdmdl="], a.wpdm-download-link, a[href$=".pdf"]').each((_, aEl) => {
          const href = detail$(aEl).attr('href');
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            const absUrl = resolvePortalUrl(href, portal);
            if (!it.attachmentUrls) it.attachmentUrls = [];
            if (!it.attachmentUrls.includes(absUrl)) it.attachmentUrls.push(absUrl);
          }
        });
      } catch {}
    }));
  }

  return result;
}

/**
 * Seeds a high-fidelity realistic dataset representing real-world tenders
 * across Pakistani statutory portals on fresh install.
 */
export function seedRealisticTenders() {
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

  seedSampleTendersIfEmpty(sampleTenders, formatClosingDate);
}
