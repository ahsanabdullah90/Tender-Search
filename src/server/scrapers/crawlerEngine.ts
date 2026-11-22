import * as cheerio from 'cheerio';
import {
  getAllDomainTracks,
  getPortalById,
  updatePortalHealth,
  getPortalHealthList,
  getAppSetting,
  setAppSetting,
  seedSampleTendersIfEmpty,
  getKnownTenderMapForPortal,
  getDocumentQueueCounts
} from '../db/index.js';
import { getInFlightDocFetchTenderIds } from './tenderAnalysis.js';
import { scrapeSppraPortal } from './sppraApi.js';
import { scrapeKpPortal } from './kpApi.js';
import { scrapeBppraPortal } from './bppraScraper.js';
import { fetchHtmlWithTolerantAgent } from './htmlFetcher.js';
import { PORTAL_DEFINITIONS, PortalDefinition } from './portalList.js';
import { getHumanJitterDelay, HUMAN_CHROME_HEADERS } from './baseScraper.js';
import { ScanStatus, ScraperErrorCode, ScanDepth, DomainTrack, DocumentQueueStatus } from '../../shared/types.js';
import { extractTenderListFromHtmlWithAI } from '../services/ocrService.js';
import {
  beginScanBudget,
  endScanBudget,
  getActiveScanBudget
} from '../services/ingestBudget.js';
import {
  checkNetworkHealth,
  canRunHeavyNetworkTask,
  canRunLightNetworkTask,
  setDeepScanPending
} from '../services/networkMonitor.js';
import {
  formatClosingDate,
  extractDatesFromText
} from './dateParser.js';
import {
  crawlerDeps,
  fetchHtmlSmart,
  postFormSmart
} from './crawlerDeps.js';
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

export { scrapeKpPortal } from './kpApi.js';

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
  hasProcurementSignals,
  buildAspNetPostBackBody
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
  analyzeTenderById,
  getInFlightDocFetchTenderIds
} from './tenderAnalysis.js';

export {
  UPFRONT_MAX_DOCS,
  MAX_DOCUMENTS_PER_TENDER,
  type ProcessTenderResult,
  type UpfrontExtraction,
  referencesOnlyPriorYears,
  computeTenderId,
  isDirectDocumentUrl,
  isDownloadableCandidateUrl,
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
  activePortals: [],
  scanDepth: 'quick',
  progressPercent: 0,
  completedPortals: 0,
  totalPortals: PORTAL_DEFINITIONS.length,
  newTendersFound: 0,
  corrigendaFound: 0,
  heldForScope: 0,
  lastScanTimestamp: null
};

export type ScanProgressEventType = 'scan_progress' | 'documents_updated' | 'doc_queue_progress';
type ProgressListener = (status: ScanStatus, eventType?: ScanProgressEventType) => void;
const progressListeners: Set<ProgressListener> = new Set();

export function addProgressListener(listener: ProgressListener) {
  progressListeners.add(listener);
}

export function removeProgressListener(listener: ProgressListener) {
  progressListeners.delete(listener);
}

function broadcastProgress(eventType: ScanProgressEventType = 'scan_progress') {
  const fullScanAt = getAppSetting('last_full_scan_at') || null;
  currentScanStatus.lastFullScanTimestamp = fullScanAt;
  const snapshot: ScanStatus = { ...currentScanStatus, lastFullScanTimestamp: fullScanAt };
  for (const listener of progressListeners) {
    try {
      listener(snapshot, eventType);
    } catch (e) {
      // Ignore stale subscriber errors
    }
  }
}

export function mergeLiveDocQueueStatus(docQueue: DocumentQueueStatus): DocumentQueueStatus {
  const inFlightManual = getInFlightDocFetchTenderIds();
  const activeTenderIds = Array.from(new Set([...(docQueue.activeTenderIds || []), ...inFlightManual]));
  const processing = Math.max(docQueue.processing ?? 0, inFlightManual.length);
  const processingTenders = Math.max(docQueue.processingTenders ?? 0, activeTenderIds.length);
  return {
    ...docQueue,
    isFetching: Boolean(docQueue.isFetching || activeTenderIds.length > 0),
    processing,
    processingTenders,
    activeTenderIds
  };
}

export function updateDocQueueStatus(
  docQueue: DocumentQueueStatus,
  options?: { documentsUpdated?: boolean }
): void {
  currentScanStatus.docQueue = mergeLiveDocQueueStatus(docQueue);
  broadcastProgress(options?.documentsUpdated ? 'documents_updated' : 'doc_queue_progress');
}

export function refreshLiveDocQueueStatus(options?: { documentsUpdated?: boolean }): void {
  try {
    const counts = getDocumentQueueCounts();
    updateDocQueueStatus(
      {
        isFetching: Boolean(currentScanStatus.docQueue?.isFetching || counts.processing > 0),
        readyPending: counts.readyPending,
        readyTenders: counts.readyTenders,
        awaitingScopePending: counts.awaitingScopePending,
        awaitingScopeTenders: counts.awaitingScopeTenders,
        totalPending: counts.totalPending,
        processing: counts.processing,
        processingTenders: counts.processingTenders,
        activeTenderIds: counts.activeTenderIds,
        completedInRun: currentScanStatus.docQueue?.completedInRun ?? 0,
        lastUpdatedAt: currentScanStatus.docQueue?.lastUpdatedAt ?? null
      },
      options
    );
  } catch {
    // DB may not be initialized in unit tests
  }
}

crawlerDeps.onDocFetchChange = () => {
  refreshLiveDocQueueStatus();
};

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

function updateActivePortalsState(activeSet: Set<string>) {
  const active = Array.from(activeSet);
  currentScanStatus.activePortals = active;
  currentScanStatus.currentPortal = active[0] ?? null;
  broadcastProgress();
}

async function scanSinglePortal(
  portal: PortalDefinition,
  activeTracks: DomainTrack[],
  depth: ScanDepth,
  activeSet: Set<string>,
  totalPortals: number,
  options?: { degradedMode?: boolean }
): Promise<'ok' | 'network_error' | 'other_error'> {
  activeSet.add(portal.name);
  updateActivePortalsState(activeSet);
  updatePortalHealth(portal.id, { status: 'scanning' });

  try {
    const scrapeResult = await scrapePortal(portal, { depth, degradedMode: options?.degradedMode });

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
    currentScanStatus.completedPortals++;
    currentScanStatus.progressPercent = Math.round((currentScanStatus.completedPortals / Math.max(1, totalPortals)) * 100);
    updateActivePortalsState(activeSet);
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
  options?: { depth?: ScanDepth; forceOnDegraded?: boolean }
): Promise<ScanStatus> {
  if (currentScanStatus.isScanning) {
    return currentScanStatus;
  }

  const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
  const net = await checkNetworkHealth();

  if (!canRunLightNetworkTask(net)) {
    if (!targetPortalId && depth === 'deep') {
      setDeepScanPending(true);
    }
    currentScanStatus.pausedReason = net.reason || 'No internet connection detected — scan paused';
    broadcastProgress();
    return currentScanStatus;
  }

  if (!canRunHeavyNetworkTask(net) && !targetPortalId && depth === 'deep' && !options?.forceOnDegraded) {
    setDeepScanPending(true);
    currentScanStatus.pausedReason = 'Slow network detected — deep scan held until connection is healthy (Quick Scan remains available)';
    broadcastProgress();
    return currentScanStatus;
  }

  const degradedMode = !canRunHeavyNetworkTask(net);
  const effectiveHttpConcurrency = degradedMode ? 1 : HTTP_PORTAL_CONCURRENCY;
  const allPortals = getActivePortalsList(targetPortalId);
  // In automated full scans, skip offline_broken portals unless explicitly triggered individually
  const portalsToScan = targetPortalId
    ? allPortals
    : allPortals.filter(p => p.accessMode !== 'offline_broken');

  currentScanStatus = {
    isScanning: true,
    currentPortal: null,
    activePortals: [],
    scanDepth: depth,
    progressPercent: 0,
    completedPortals: 0,
    totalPortals: portalsToScan.length,
    newTendersFound: 0,
    corrigendaFound: 0,
    heldForScope: 0,
    pausedReason: null,
    lastScanTimestamp: currentScanStatus.lastScanTimestamp
  };
  broadcastProgress();

  const scanExecution = async () => {
    // Per-scan document budget: time for upfront fetches and a Gemini Vision call cap (docs/13 §3.2).
    beginScanBudget();
    const activeSet = new Set<string>();
    let succeededPortals = 0;
    let networkFailedPortals = 0;
    try {
      const activeTracks = getAllDomainTracks().filter(t => t.is_active === 1);
      const total = portalsToScan.length;

      if (portalsToScan.length <= 1) {
        for (const portal of portalsToScan) {
          const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, { degradedMode });
          if (outcome === 'ok') succeededPortals++;
          else if (outcome === 'network_error') networkFailedPortals++;
        }
      } else {
        const runPortalPhase = async (phasePortals: typeof portalsToScan) => {
          const httpPortals = phasePortals.filter(p => p.tier !== 'playwright');
          const pwPortals = phasePortals.filter(p => p.tier === 'playwright');

          await Promise.all([
            runWithConcurrency(httpPortals, effectiveHttpConcurrency, async portal => {
              const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, { degradedMode });
              if (outcome === 'ok') succeededPortals++;
              else if (outcome === 'network_error') networkFailedPortals++;
              await crawlerDeps.sleep(getHumanJitterDelay(500, 1200));
            }),
            runWithConcurrency(pwPortals, PLAYWRIGHT_PORTAL_CONCURRENCY, async portal => {
              const outcome = await scanSinglePortal(portal, activeTracks, depth, activeSet, total, { degradedMode });
              if (outcome === 'ok') succeededPortals++;
              else if (outcome === 'network_error') networkFailedPortals++;
              await crawlerDeps.sleep(getHumanJitterDelay(500, 1200));
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
      currentScanStatus.documentsDeferred = budget?.documentsDeferred ?? 0;
      currentScanStatus.visionDeferred = budget?.visionDeferred ?? 0;
      currentScanStatus.isScanning = false;
      currentScanStatus.activePortals = [];
      currentScanStatus.currentPortal = null;
      currentScanStatus.lastScanTimestamp = new Date().toISOString();
      currentScanStatus.progressPercent = 100;
      if (!targetPortalId) {
        const allFailedFromNetwork =
          portalsToScan.length > 0 && succeededPortals === 0 && networkFailedPortals >= portalsToScan.length;
        if (!allFailedFromNetwork) {
          setAppSetting('last_full_scan_at', currentScanStatus.lastScanTimestamp);
          if (depth === 'deep') {
            setAppSetting('last_deep_scan_at', currentScanStatus.lastScanTimestamp);
            if (succeededPortals > 0) {
              setDeepScanPending(false);
            }
          }
        } else {
          currentScanStatus.pausedReason = 'All portals timed out or unreachable — catch-up scan will retry when network recovers';
          if (depth === 'deep') {
            setDeepScanPending(true);
          }
        }
      }
      broadcastProgress();
      if (crawlerDeps.onScanFinished) {
        try {
          crawlerDeps.onScanFinished();
        } catch {}
      }
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

function normalizeClosingDayForEarlyStop(value?: string | null): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const formatted = formatClosingDate(value);
  return formatted && /^\d{4}-\d{2}-\d{2}/.test(formatted) ? formatted.slice(0, 10) : value.trim().toLowerCase();
}

/**
 * Scrapes a portal via Playwright headless (if tier === 'playwright') with fallback to tolerant HTTP/Cheerio (Bug B1),
 * enhanced with Self-Healing Phase 2 (Adaptive AI Layout Extraction) and strictly gated Phase 3 (Auto-Healer on dead links only).
 */
export async function scrapePortal(
  portal: PortalDefinition & { sessionCookies?: string },
  options?: { depth?: ScanDepth; degradedMode?: boolean }
): Promise<ScrapeResult> {
  const usingRealTransport = crawlerDeps.fetchHtml === fetchHtmlWithTolerantAgent;

  // Sindh SPPRA (portalsindh.eprocure.gov.pk) serves its public tender board via the official EPADS WSO2 JSON API.
  if (portal.id === 'sppra') {
    const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
    const knownMap = depth === 'quick' ? getKnownTenderMapForPortal(portal.id) : null;
    const spResult = await scrapeSppraPortal(portal, {
      depth,
      knownMap,
      timeoutMs: options?.degradedMode ? 45000 : 20000
    });
    spResult.items = sanitizeScrapedItems(spResult.items, portal);
    return spResult;
  }

  // Khyber Pakhtunkhwa KPPRA & KP Portal serve active listings via the public REST API at mgn1.kp.gov.pk/api/tenders.
  if (portal.id === 'kppra') {
    const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
    const knownMap = depth === 'quick' ? getKnownTenderMapForPortal(portal.id) : null;
    const kpResult = await scrapeKpPortal(portal, {
      depth,
      knownMap,
      timeoutMs: options?.degradedMode ? 45000 : 20000
    });
    kpResult.items = sanitizeScrapedItems(kpResult.items, portal);
    return kpResult;
  }

  // Balochistan BPPRA (bpptwo.vdc.services:5451) uses Blazor Server pagination (Active Tenders, 100/page) + /RFP, /PreQualification, /EOI tabs.
  if (portal.id === 'bppra' && usingRealTransport && portal.tendersUrl.includes('bpptwo.vdc.services')) {
    const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
    const knownMap = depth === 'quick' ? getKnownTenderMapForPortal(portal.id) : null;
    const bpResult = await scrapeBppraPortal(portal, {
      depth,
      knownMap,
      timeoutMs: options?.degradedMode ? 45000 : 25000
    });
    bpResult.items = sanitizeScrapedItems(bpResult.items, portal);
    return bpResult;
  }

  const htmlTimeoutMs = options?.degradedMode
    ? (portal.tendersUrl.includes('epms.ppra.gov.pk') ? 55000 : 45000)
    : undefined;
  let html: string | null = null;
  let fetchError: any = null;
  let redirectedUrl: string | null = null;
  let responseCookies: string | undefined = portal.sessionCookies;
  let playwrightError: Error | null = null;

  if (portal.tier === 'playwright' && usingRealTransport) {
    try {
      const modName = 'playwright';
      const playwright: any = await (Function('m', 'return import(m)')(modName) as Promise<any>).catch(() => null);
      if (playwright && playwright.chromium) {
        let browser: any = null;
        try {
          browser = await playwright.chromium
            .launch({ headless: true, channel: 'chromium' })
            .catch(() => playwright.chromium.launch({ headless: true }))
            .catch(() => playwright.chromium.launch({ headless: true, channel: 'msedge' }));
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
        const fetched = await fetchHtmlSmart(portal.tendersUrl, portal.sessionCookies, htmlTimeoutMs);
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

  // Two-speed pagination (quick vs deep) + DB early-stop when page >= 2 repeats already-known unchanged notices
  const depth: ScanDepth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = portal.pagination
    ? (depth === 'deep'
        ? (portal.pagination.deepMaxPages ?? portal.pagination.maxPages)
        : (portal.pagination.quickMaxPages ?? portal.pagination.maxPages))
    : 1;
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
      } else if (portal.pagination.kind === 'path') {
        pageUrl = (portal.pagination.pathPattern || `${portal.tendersUrl}/{page}`).replace('{page}', String(page));
      } else if (portal.pagination.kind === 'postback') {
        postBody = buildAspNetPostBackBody(currentPageHtml, page);
        if (!postBody) break;
      } else {
        break;
      }

      try {
        await crawlerDeps.sleep(getHumanJitterDelay(1500, 3000));
        const pageFetched = postBody
          ? await postFormSmart(pageUrl, postBody, currentCookies, htmlTimeoutMs)
          : await fetchHtmlSmart(pageUrl, portal.id === 'epms_ppra' ? portal.sessionCookies : currentCookies, htmlTimeoutMs);
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
        let allKnownAndUnchanged = Boolean(knownMap && knownMap.size > 0);
        for (const item of cleanPageItems) {
          const key = (item.directUrl || item.title).toLowerCase();
          if (!seenUrls.has(key)) {
            seenUrls.add(key);
            result.items.push(item);
            newOnThisPage++;
          }
          if (allKnownAndUnchanged && knownMap) {
            const known = knownMap.get(key);
            if (!known || item.isCorrigendum) {
              allKnownAndUnchanged = false;
            } else {
              const incomingClosing = normalizeClosingDayForEarlyStop(item.closingDate);
              const storedClosing = normalizeClosingDayForEarlyStop(known.closing_date);
              if (incomingClosing !== storedClosing) {
                allKnownAndUnchanged = false;
              }
            }
          }
        }

        if (newOnThisPage === 0) {
          break; // Stop when page yields only items already seen
        }
        pagesScanned++;
        if (allKnownAndUnchanged) {
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
      referenceNo: 'EPMS-2026-SLR-041',
      title: 'Solarization of 150 Public Schools and Rural Health Centers in Southern Punjab (Phase-II)',
      organization: 'Punjab Energy Department / Punjab eProc',
      portalId: 'punjab_eproc',
      portalName: 'Punjab PPRA (eproc.punjab.gov.pk)',
      directUrl: 'https://eproc.punjab.gov.pk/ActiveTenders.aspx',
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
