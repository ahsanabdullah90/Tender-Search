import * as cheerio from 'cheerio';
import {
  getAllDomainTracks,
  getPortalById,
  updatePortalHealth,
  getPortalHealthList,
  setAppSetting,
  getKnownTenderMapForPortal
} from '../db/index.js';
import { getPortalAdapter } from './adapters/registry.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { getHumanJitterDelay, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, ScraperErrorCode, ScanDepth, DomainTrack, DocumentQueueStatus } from '../../shared/types.js';
import { extractTenderListFromHtmlWithAI } from '../services/ocrService.js';
import {
  beginScanBudget,
  endScanBudget,
  getActiveScanBudget
} from '../services/ingestBudget.js';
import { defaultNetworkMonitor, type NetworkMonitor } from '../services/networkMonitor.js';
import {
  extractDatesFromText
} from './dateParser.js';
import {
  getCrawlerPorts,
  isUsingRealFetchTransport,
  fetchHtmlSmart,
  postFormSmart,
  type CrawlerPorts
} from './crawlerDeps.js';
import {
  ScanStateStore,
  scanState,
  type ProgressListener
} from './scanState.js';
import {
  ScrapeResult,
  parsePortalHtml,
  sanitizeScrapedItems,
  hasEmptyTenderTableState,
  hasProcurementSignals,
  compactHtmlForAiExtraction,
  isGenericListingUrl,
  resolvePortalUrl,
  buildAspNetPostBackBody
} from './portalParsers.js';
import {
  shouldTriggerAutoHeal,
  healPortalConnection,
  isValidHealedTendersUrl,
  sanitizeBaseOrigin
} from './healer.js';
import { processAndSaveTender } from './ingestPipeline.js';
import { launchHeadlessChromium, type PlaywrightManager } from './playwrightEngine.js';
import { resolvePaginationMaxPages, shouldEarlyStopKnownPage } from './scraperUtils.js';

// ===========================================================================
// Re-exports for backward compatibility across active callers and tests
// ===========================================================================
export {
  parseDateString,
  formatClosingDate,
  extractDatesFromText
} from './dateParser.js';

export {
  fetchHtmlWithMetadata,
  fetchHtmlWithTolerantAgent
} from './htmlFetcher.js';

export {
  getCrawlerPorts,
  configureCrawlerPorts,
  resetCrawlerPorts,
  isUsingRealFetchTransport,
  fetchHtmlSmart,
  postFormSmart,
  type CrawlerPorts
} from './crawlerDeps.js';

export {
  ScanStateStore,
  scanState,
  type ScanProgressEventType,
  type ProgressListener
} from './scanState.js';

export {
  type RawScrapedItem,
  type ScrapeResult,
  isNonBidEvaluationOrPlanTitle,
  extractRefFromText,
  isGenericListingUrl,
  isNavigationRow,
  sanitizeScrapedItems,
  collectRowAttachments,
  parsePortalHtml,
  compactHtmlForAiExtraction,
  hasEmptyTenderTableState,
  hasProcurementSignals,
  buildAspNetPostBackBody
} from './portalParsers.js';

export {
  matchTracks
} from './trackMatcher.js';

export {
  readCachedDossier,
  fetchDocumentsForTender,
  analyzeTenderById
} from './tenderAnalysis.js';

export {
  orderDocumentCandidates,
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

export function addProgressListener(listener: ProgressListener) {
  return scanState.subscribe(listener);
}

export function removeProgressListener(listener: ProgressListener) {
  scanState.unsubscribe(listener);
}

export function mergeLiveDocQueueStatus(docQueue: DocumentQueueStatus): DocumentQueueStatus {
  return scanState.mergeLiveDocQueueStatus(docQueue);
}

export function updateDocQueueStatus(
  docQueue: DocumentQueueStatus,
  options?: { documentsUpdated?: boolean }
): void {
  scanState.updateDocQueueStatus(docQueue, options);
}

export function refreshLiveDocQueueStatus(options?: { documentsUpdated?: boolean }): void {
  scanState.refreshLiveDocQueueStatus(options);
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
        category: (dbP.category as any) || def?.category || 'Federal/Regional',
        tier: (dbP.tier as any) || def?.tier || 'http',
        baseUrl: dbP.base_url || def?.baseUrl || '',
        tendersUrl: dbP.tenders_url || def?.tendersUrl || '',
        loginUrl: dbP.login_url || def?.loginUrl,
        accessMode: (dbP.access_mode as any) || def?.accessMode || 'public',
        verifiedStatus: dbP.verified_status || def?.verifiedStatus || 'Active',
        sessionCookies: dbP.session_cookies || undefined,
        description: def?.description || '',
        defaultKeywords: def?.defaultKeywords || [],
        pagination: def?.pagination
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

export const HTTP_PORTAL_CONCURRENCY = 3;
export const PLAYWRIGHT_PORTAL_CONCURRENCY = 1;

export const STATUTORY_PORTAL_IDS = new Set([
  'epms_ppra',
  'punjab_eproc',
  'sppra',
  'bppra',
  'kppra',
  'gilgit',
  'ajk_ppra'
]);

export function isStatutoryPortal(portal: Pick<PortalDefinition, 'id' | 'category'>): boolean {
  return portal.category === 'Regulatory' || STATUTORY_PORTAL_IDS.has(portal.id);
}

/**
 * Classifies an uncaught scraper failure into a compact diagnostic category for portal_health.last_error_code.
 */
export function classifyScraperError(err: any): ScraperErrorCode {
  const status = Number(err?.statusCode ?? err?.status ?? 0);
  const msg = `${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? err ?? ''}`;

  if (/\b(timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError)\b/i.test(msg)) {
    return 'TIMEOUT';
  }
  if (/ssl|tls|CERT_|ERR_TLS|wrong version number|unable to verify|self[- ]signed|handshake/i.test(msg)) {
    return 'TLS_ERROR';
  }
  if (/cloudflare|turnstile|captcha|just a moment|verification challenge/i.test(msg)) {
    return 'CLOUDFLARE_HITL';
  }
  if (/login|unauthorized|credentials|authentication required/i.test(msg)) {
    return 'LOGIN_REQUIRED';
  }
  if ((status >= 400 && status < 600) || /\b(?:HTTP|status(?: code)?)\s*[45]\d{2}\b/i.test(msg)) {
    return 'HTTP_4XX_5XX';
  }
  if (/parse|selector|empty|0 tenders/i.test(msg)) {
    return 'PARSE_EMPTY';
  }
  return 'NETWORK_UNREACHABLE';
}

/**
 * Runs work across `items` with a bounded pool of `concurrency` async workers.
 * Each item runs inside its own worker invocation so failures should be handled per item.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIdx = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      await worker(items[idx]);
    }
  });

  await Promise.all(runners);
}

async function scanSinglePortal(
  portal: PortalDefinition,
  activeTracks: DomainTrack[],
  depth: ScanDepth,
  activeSet: Set<string>,
  totalPortals: number,
  options: {
    degradedMode?: boolean;
    scanState: ScanStateStore;
    ports: CrawlerPorts;
    networkMonitor: NetworkMonitor;
    playwright?: PlaywrightManager;
  }
): Promise<'ok' | 'network_error' | 'other_error'> {
  const activeScanState = options.scanState;
  activeSet.add(portal.name);
  activeScanState.setActivePortals(Array.from(activeSet));
  updatePortalHealth(portal.id, { status: 'scanning' });

  try {
    const scrapeResult = await scrapePortal(portal, {
      depth,
      degradedMode: options.degradedMode,
      ports: options.ports,
      playwright: options.playwright
    });

    if (scrapeResult.hitlRequired) {
      updatePortalHealth(portal.id, {
        status: 'hitl_required',
        last_scan_at: new Date().toISOString(),
        last_error_code: scrapeResult.isLoginRequired ? 'LOGIN_REQUIRED' : 'CLOUDFLARE_HITL',
        last_error_message: scrapeResult.isLoginRequired
          ? 'Login credentials or active session required'
          : 'Verification challenge detected (Cloudflare Turnstile or CAPTCHA)'
      });
    } else {
      const rawItems = scrapeResult.items;
      let itemsMatched = 0;
      const budgetNow = getActiveScanBudget();
      if (budgetNow) {
        activeScanState.recordBudgetCounts(budgetNow.documentsDeferred, budgetNow.visionDeferred);
      }

      for (const item of rawItems) {
        try {
          const result = await processAndSaveTender(item, portal, activeTracks, {
            ports: options.ports,
            networkMonitor: options.networkMonitor
          });
          activeScanState.recordTenderResult(result);
          if (result.matched) itemsMatched++;
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
        last_error_code: rawItems.length === 0 ? 'PARSE_EMPTY' : null,
        last_error_message: rawItems.length === 0
          ? '0 tenders found on page — check website URL manually if active tenders are expected'
          : null
      });
    }
    return 'ok';
  } catch (err: any) {
    console.error(`[Crawler] Error scanning portal ${portal.id}:`, err.message || err);
    const errorCode = classifyScraperError(err);
    updatePortalHealth(portal.id, {
      status: 'error',
      last_scan_at: new Date().toISOString(),
      last_items_found: 0,
      last_error_code: errorCode,
      last_error_message: err.message || 'Scrape connection failure'
    });
    return errorCode === 'TIMEOUT' || errorCode === 'NETWORK_UNREACHABLE' ? 'network_error' : 'other_error';
  } finally {
    activeSet.delete(portal.name);
    activeScanState.completePortal(totalPortals, Array.from(activeSet));
  }
}

/**
 * Executes a full scan across all active portals or a single target portal.
 * Multi-portal scans run HTTP portals concurrently (up to HTTP_PORTAL_CONCURRENCY)
 * and Playwright portals sequentially (PLAYWRIGHT_PORTAL_CONCURRENCY) for stability.
 */
export async function startCrawlerScan(
  targetPortalId?: string,
  awaitCompletion: boolean = false,
  options?: {
    depth?: ScanDepth;
    forceOnDegraded?: boolean;
    scanState?: ScanStateStore;
    ports?: CrawlerPorts;
    networkMonitor?: NetworkMonitor;
    playwright?: PlaywrightManager;
  }
): Promise<ScanStatus> {
  const activeScanState = options?.scanState ?? scanState;
  const activePorts = options?.ports ?? getCrawlerPorts();
  const activeNetworkMonitor = options?.networkMonitor ?? defaultNetworkMonitor;

  if (!activeScanState.tryAcquireStart()) {
    return activeScanState.getSnapshot();
  }

  let depth: ScanDepth;
  let degradedMode: boolean;
  let effectiveHttpConcurrency: number;
  let portalsToScan: PortalDefinition[];
  try {
    depth = options?.depth === 'deep' ? 'deep' : 'quick';
    const net = await activeNetworkMonitor.checkHealth();

    if (!activeNetworkMonitor.canRunLightTask(net)) {
      if (!targetPortalId && depth === 'deep') {
        activeNetworkMonitor.setDeepScanPending(true);
      }
      return activeScanState.pauseScan(net.reason || 'No internet connection detected — scan paused');
    }

    if (!activeNetworkMonitor.canRunHeavyTask(net) && !targetPortalId && depth === 'deep' && !options?.forceOnDegraded) {
      activeNetworkMonitor.setDeepScanPending(true);
      return activeScanState.pauseScan(
        'Slow network detected — deep scan held until connection is healthy (Quick Scan remains available)'
      );
    }

    degradedMode = !activeNetworkMonitor.canRunHeavyTask(net);
    effectiveHttpConcurrency = degradedMode ? 1 : HTTP_PORTAL_CONCURRENCY;
    const allPortals = getActivePortalsList(targetPortalId);
    // In automated full scans, skip offline_broken portals unless explicitly triggered individually
    portalsToScan = targetPortalId
      ? allPortals
      : allPortals.filter(p => p.accessMode !== 'offline_broken');

    activeScanState.beginScan({ depth, totalPortals: portalsToScan.length });
  } finally {
    activeScanState.releaseStartLock();
  }

  const scanExecution = async (): Promise<ScanStatus> => {
    // Per-scan document budget: time for upfront fetches and a Gemini Vision call cap (docs/13 §3.2).
    beginScanBudget();
    const activeSet = new Set<string>();
    let succeededPortals = 0;
    let networkFailedPortals = 0;
    let finalStatus: ScanStatus;
    try {
      const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
      const total = portalsToScan.length;

      if (portalsToScan.length <= 1) {
        for (const portal of portalsToScan) {
          const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, {
            degradedMode,
            scanState: activeScanState,
            ports: activePorts,
            networkMonitor: activeNetworkMonitor,
            playwright: options?.playwright
          });
          if (outcome === 'ok') succeededPortals++;
          else if (outcome === 'network_error') networkFailedPortals++;
        }
      } else {
        const runPortalPhase = async (phasePortals: typeof portalsToScan) => {
          const httpPortals = phasePortals.filter(p => p.tier !== 'playwright');
          const pwPortals = phasePortals.filter(p => p.tier === 'playwright');

          await Promise.all([
            runWithConcurrency(httpPortals, effectiveHttpConcurrency, async portal => {
              const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, {
                degradedMode,
                scanState: activeScanState,
                ports: activePorts,
                networkMonitor: activeNetworkMonitor,
                playwright: options?.playwright
              });
              if (outcome === 'ok') succeededPortals++;
              else if (outcome === 'network_error') networkFailedPortals++;
              await activePorts.sleep(getHumanJitterDelay(500, 1200));
            }),
            runWithConcurrency(pwPortals, PLAYWRIGHT_PORTAL_CONCURRENCY, async portal => {
              const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, {
                degradedMode,
                scanState: activeScanState,
                ports: activePorts,
                networkMonitor: activeNetworkMonitor,
                playwright: options?.playwright
              });
              if (outcome === 'ok') succeededPortals++;
              else if (outcome === 'network_error') networkFailedPortals++;
              await activePorts.sleep(getHumanJitterDelay(500, 1200));
            })
          ]);
        };

        // Two-Phase Scan Execution: Phase 1 (Statutory Backbone) completes before Phase 2 (Individual Agencies)
        const phase1Statutory = portalsToScan.filter(p => isStatutoryPortal(p));
        const phase2Agencies = portalsToScan.filter(p => !isStatutoryPortal(p));

        if (phase1Statutory.length > 0) {
          await runPortalPhase(phase1Statutory);
        }
        if (phase2Agencies.length > 0) {
          await runPortalPhase(phase2Agencies);
        }
      }
    } finally {
      const budget = endScanBudget();
      const timestamp = new Date().toISOString();
      let pausedReason: string | null | undefined;
      if (!targetPortalId) {
        const allFailedFromNetwork =
          portalsToScan.length > 0 && succeededPortals === 0 && networkFailedPortals >= portalsToScan.length;
        if (!allFailedFromNetwork) {
          setAppSetting('last_full_scan_at', timestamp);
          if (depth === 'deep') {
            setAppSetting('last_deep_scan_at', timestamp);
            if (succeededPortals > 0) {
              activeNetworkMonitor.setDeepScanPending(false);
            }
          }
        } else {
          pausedReason = 'All portals timed out or unreachable — catch-up scan will retry when network recovers';
          if (depth === 'deep') {
            activeNetworkMonitor.setDeepScanPending(true);
          }
        }
      }
      finalStatus = activeScanState.finishScan({
        documentsDeferred: budget?.documentsDeferred ?? 0,
        visionDeferred: budget?.visionDeferred ?? 0,
        timestamp,
        pausedReason
      });
    }
    return finalStatus;
  };

  if (awaitCompletion) {
    return await scanExecution();
  } else {
    scanExecution().catch(err => console.error('[Crawler] Background scan error:', err));
    return activeScanState.getSnapshot();
  }
}

/**
 * Scrapes a portal via Playwright headless (if tier === 'playwright') with fallback to tolerant HTTP/Cheerio (Bug B1),
 * enhanced with Self-Healing Phase 2 (Adaptive AI Layout Extraction) and strictly gated Phase 3 (Auto-Healer on dead links only).
 */
export async function scrapePortal(
  portal: PortalDefinition & { sessionCookies?: string },
  options?: { depth?: ScanDepth; degradedMode?: boolean; ports?: CrawlerPorts; playwright?: PlaywrightManager }
): Promise<ScrapeResult> {
  const activePorts = options?.ports ?? getCrawlerPorts();
  const usingRealTransport = isUsingRealFetchTransport(activePorts);
  const adapter = getPortalAdapter(portal.id);

  if (adapter.scrapeListings) {
    const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
    const customResult = await adapter.scrapeListings(portal, {
      depth,
      degradedMode: Boolean(options?.degradedMode),
      usingRealTransport,
      getKnownMap: () => (depth === 'quick' ? getKnownTenderMapForPortal(portal.id) : null)
    });
    if (customResult) {
      customResult.items = sanitizeScrapedItems(customResult.items, portal);
      return customResult;
    }
  }

  const htmlTimeoutMs = options?.degradedMode
    ? (adapter.transport?.degradedTimeoutMs ?? 45000)
    : undefined;
  let html: string | null = null;
  let fetchError: any = null;
  let redirectedUrl: string | null = null;
  let responseCookies: string | undefined = portal.sessionCookies;
  let playwrightError: Error | null = null;

  if (portal.tier === 'playwright' && usingRealTransport) {
    let browser: any = null;
    try {
      browser = options?.playwright
        ? await options.playwright.launchHeadlessChromium()
        : await launchHeadlessChromium();
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
  }

  if (html === null) {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fetched = await fetchHtmlSmart(portal.tendersUrl, portal.sessionCookies, htmlTimeoutMs, activePorts);
        html = fetched.html;
        if (fetched.cookies) responseCookies = fetched.cookies;
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
          await activePorts.sleep(backoffMs);
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

  // Two-speed pagination (quick vs deep) + DB early-stop when page >= 2 repeats already-known unchanged notices
  const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = resolvePaginationMaxPages(portal, depth, 1);
  let pagesScanned = 1;
  if (portal.pagination && maxPages > 1 && !result.hitlRequired && result.items.length > 0) {
    const seenUrls = new Set(result.items.map(it => (it.directUrl || it.title).toLowerCase()));
    const knownMap = depth === 'quick' ? getKnownTenderMapForPortal(portal.id) : null;
    let currentPageHtml = html;
    let currentCookies = responseCookies;

    for (let page = 2; page <= maxPages; page++) {
      let pageUrl = portal.tendersUrl;
      let postBody: string | null = null;

      if (portal.pagination.kind === 'query') {
        try {
          const u = new URL(portal.tendersUrl);
          u.searchParams.set(portal.pagination.param || 'page', String(page));
          pageUrl = u.toString();
        } catch {
          break;
        }
      } else if (portal.pagination.kind === 'postback') {
        postBody = buildAspNetPostBackBody(currentPageHtml, page);
        if (!postBody) break;
      } else {
        break;
      }

      try {
        await activePorts.sleep(getHumanJitterDelay(1500, 3000));
        const forwardCookies = adapter.transport?.forwardResponseCookiesOnPagination ?? true;
        const pageFetched = postBody
          ? await postFormSmart(pageUrl, postBody, currentCookies, htmlTimeoutMs, activePorts)
          : await fetchHtmlSmart(pageUrl, forwardCookies ? currentCookies : portal.sessionCookies, htmlTimeoutMs, activePorts);
        if (!pageFetched.html) break;
        currentPageHtml = pageFetched.html;
        if (pageFetched.cookies) currentCookies = pageFetched.cookies;

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
        if (shouldEarlyStopKnownPage(cleanPageItems, knownMap, { threshold: 1, keyMode: 'urlOrTitle' })) {
          // Quick scan caught up to already-indexed unchanged pages in SQLite
          break;
        }
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
        const detailHtml = await activePorts.fetchHtml(it.directUrl);
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
