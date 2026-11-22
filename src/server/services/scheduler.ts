import { getPktDateKey } from '../../shared/pktDate.js';
import {
  backupDatabase,
  updatePortalHealth,
  getScanningPortalIds,
  getLastSuccessfulScanTimestamp,
  releaseExpiredLeases,
  reconcileStaleTenderDocFetchStatuses,
  pruneAlreadyCachedPendingJobs,
  backfillExistingTenderDocumentJobs,
  getEarlierDeadlineReviewTenders,
  setTenderDeadline,
  clearTenderReviewFlag
} from '../db/index.js';
import { getAppSetting, setAppSetting, getAlertsDigest, getDigestSettings } from '../db/repositories/systemRepo.js';
import { ScanDepth, DigestSummary } from '../../shared/types.js';
import { startCrawlerScan, getActivePortalsList, currentScanStatus, crawlerDeps } from '../scrapers/crawlerEngine.js';
import { formatClosingDate } from '../scrapers/dateParser.js';
import { findSubmissionDeadlines } from './documentExtractor.js';
import { migrateDossierFilenames, reclassifyExistingDossiersFromText } from './dossierStore.js';
import { runRetentionCycle } from './retention.js';
import { backfillModelEmbeddings } from './embeddingBackfill.js';
import { drainDocumentQueue } from './ingestWorker.js';
import {
  checkNetworkHealth,
  getCachedNetworkStatus,
  canRunHeavyNetworkTask,
  canRunLightNetworkTask,
  isDeepScanPending,
  setDeepScanPending
} from './networkMonitor.js';

let schedulerInterval: NodeJS.Timeout | null = null;
let retentionInterval: NodeJS.Timeout | null = null;
let documentQueueInterval: NodeJS.Timeout | null = null;
let startupDocDrainTimer: NodeJS.Timeout | null = null;
let lastDailyHealthCheck: number = 0;

export const schedulerDeps = {
  startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, opts?: { depth?: ScanDepth }) =>
    startCrawlerScan(portalId, awaitCompletion, opts),
  backupDatabase: () => backupDatabase(),
  runRetentionCycle: (opts?: any) => runRetentionCycle(opts),
  backfillModelEmbeddings: (limit?: number) => backfillModelEmbeddings(limit),
  drainDocumentQueue: (opts?: { maxBatches?: number; batchSize?: number; concurrency?: number }) =>
    drainDocumentQueue(opts),
  reclassifyExistingDossiersFromText: () => reclassifyExistingDossiersFromText(),
  sendDigestWebhook: async (webhookUrl: string, payload: DigestSummary) => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error(`Digest webhook responded with HTTP ${res.status}`);
    }
  }
};

export { getPktDateKey };

/**
 * Re-runs local deadline parsing on flagged `deadline_moved_earlier` tenders whose stored
 * `extracted_text` already exists (for instance after a dateParser fix) and restores extended
 * deadlines while clearing stale review flags.
 */
export function recheckEarlierDeadlineReviewTenders(): number {
  let resolvedCount = 0;
  const rows = getEarlierDeadlineReviewTenders();
  for (const row of rows) {
    const deadlines = findSubmissionDeadlines(row.extracted_text);
    if (deadlines.length === 0) continue;
    const latestIso = deadlines[deadlines.length - 1];
    const latestMs = new Date(latestIso).getTime();
    const storedMs = row.closing_date ? new Date(row.closing_date).getTime() : NaN;
    if (Number.isFinite(latestMs) && (!Number.isFinite(storedMs) || latestMs > storedMs)) {
      const formatted = formatClosingDate(latestIso);
      const confidence = row.deadline_confidence || (deadlines.length === 1 ? 'high' : 'medium');
      setTenderDeadline(row.id, latestIso, formatted, row.deadline_source || 'corrigendum_doc', confidence);
      clearTenderReviewFlag(row.id);
      resolvedCount++;
    }
  }
  return resolvedCount;
}

function shouldRunDeepScanNow(nowMs: number = Date.now()): boolean {
  const lastDeepStr = getAppSetting('last_deep_scan_at');
  if (!lastDeepStr) return true;
  const lastDeepMs = new Date(lastDeepStr).getTime();
  return !Number.isFinite(lastDeepMs) || (nowMs - lastDeepMs) / (1000 * 60 * 60) >= 24;
}

export function initStartupScheduler() {
  // 0. Reset any portals stuck in 'scanning' state from a previously interrupted process (Bug B3)
  try {
    const stuckIds = getScanningPortalIds();
    for (const portalId of stuckIds) {
      updatePortalHealth(portalId, {
        status: 'error',
        last_error_message: 'Previous scan was interrupted'
      });
    }
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Failed to reset stuck scanning portals:', err);
  }

  // 0b. Recover expired leases, migrate filenames, recheck earlier deadlines, prune cached pending jobs & queue backfill
  try {
    const releasedLeases = releaseExpiredLeases();
    const { filesRenamed } = migrateDossierFilenames();
    const reviewedResolved = recheckEarlierDeadlineReviewTenders();
    const pruned = pruneAlreadyCachedPendingJobs();
    const reconciledStatuses = reconcileStaleTenderDocFetchStatuses();
    const backfilled = backfillExistingTenderDocumentJobs();
    if (releasedLeases > 0 || filesRenamed > 0 || reviewedResolved > 0 || pruned > 0 || reconciledStatuses > 0 || backfilled > 0) {
      console.log(
        `[Tender Tracker Scheduler] Document queue hygiene: released ${releasedLeases} expired lease(s), renamed ${filesRenamed} file(s), resolved ${reviewedResolved} corrigendum deadline(s), pruned ${pruned} already-cached job(s), reconciled ${reconciledStatuses} status(es), queued ${backfilled} backfill tender(s).`
      );
    }
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Document queue startup hygiene note:', err);
  }

  // 0c. Kick off prioritized document drain automatically whenever any crawl finishes
  crawlerDeps.onScanFinished = () => {
    void schedulerDeps.drainDocumentQueue().catch(err =>
      console.warn('[Tender Tracker Scheduler] Post-scan document drain error:', err)
    );
  };

  // 1. Run database backup on startup if needed
  schedulerDeps.backupDatabase().catch(err => console.error('Startup backup error:', err));

  // 2. Initial retention cycle & 5-minute interval for Pass-slimming and cleanup
  try {
    schedulerDeps.runRetentionCycle();
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Initial retention cycle error:', err);
  }
  if (retentionInterval) clearInterval(retentionInterval);
  retentionInterval = setInterval(() => {
    try {
      schedulerDeps.runRetentionCycle();
    } catch (err) {
      console.warn('[Tender Tracker Scheduler] Retention cycle error:', err);
    }
    // Upgrade vectors written while the model was unavailable or after edits (no-op if the model is not loaded)
    schedulerDeps.backfillModelEmbeddings(100).catch(err =>
      console.warn('[Tender Tracker Scheduler] Embedding backfill error:', err)
    );
  }, 5 * 60 * 1000);

  // 2b. Background document worker & deferred heavy-task recovery check every 2 minutes
  // (skips heavy network work when degraded/offline or while a scan is active).
  if (documentQueueInterval) clearInterval(documentQueueInterval);
  documentQueueInterval = setInterval(async () => {
    try {
      const net = await checkNetworkHealth();
      if (!canRunHeavyNetworkTask(net)) {
        return;
      }
      if (isDeepScanPending() && !currentScanStatus.isScanning) {
        setDeepScanPending(false);
        schedulerDeps.startCrawlerScan(undefined, false, { depth: 'deep' });
        return;
      }
      await schedulerDeps.drainDocumentQueue();
    } catch (err) {
      console.warn('[Tender Tracker Scheduler] Document queue error:', err);
    }
  }, 2 * 60 * 1000);

  // 2c. Short non-blocking startup drain so pending Inbox documents begin downloading within seconds
  if (startupDocDrainTimer) clearTimeout(startupDocDrainTimer);
  startupDocDrainTimer = setTimeout(async () => {
    startupDocDrainTimer = null;
    try {
      await schedulerDeps.reclassifyExistingDossiersFromText();
      if (currentScanStatus.isScanning) return;
      const net = await checkNetworkHealth();
      if (!canRunHeavyNetworkTask(net)) return;
      await schedulerDeps.drainDocumentQueue();
    } catch (err) {
      console.warn('[Tender Tracker Scheduler] Startup document drain error:', err);
    }
  }, 4000);

  // 2. Check if a catch-up scan is required; run daily health check after it finishes (docs/16 B7)
  const catchUpTask = checkAndTriggerCatchUpScan();
  if (catchUpTask && typeof (catchUpTask as any).then === 'function') {
    (catchUpTask as Promise<any>).then(() => {
      runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
    }).catch(err => {
      console.warn('[Scheduler] Catch-up scan error:', err);
      runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
    });
  } else {
    runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
  }

  // 3b. Opt-in once-per-PKT-day digest webhook dispatch
  maybeDispatchDailyDigest().catch(err => console.warn('[Tender Tracker Scheduler] Digest dispatch note:', err));

  // 4. Periodic watchdog check every 30 minutes
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(() => {
    // Run backup check periodically so backups occur daily during long uptimes
    schedulerDeps.backupDatabase().catch(err => console.error('Periodic backup error:', err));
    const catchUpStarted = checkAndTriggerCatchUpScan();
    if (!catchUpStarted && shouldRunDeepScanNow()) {
      schedulerDeps.startCrawlerScan(undefined, false, { depth: 'deep' });
    }
    maybeDispatchDailyDigest().catch(err => console.warn('[Tender Tracker Scheduler] Digest dispatch note:', err));

    // Check broken/offline links once every 24 hours
    if (Date.now() - lastDailyHealthCheck > 24 * 60 * 60 * 1000) {
      runDailyPortalHealthAdvisement();
    }
  }, 30 * 60 * 1000);
}

export function stopStartupScheduler() {
  crawlerDeps.onScanFinished = null;
  if (startupDocDrainTimer) {
    clearTimeout(startupDocDrainTimer);
    startupDocDrainTimer = null;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }
  if (documentQueueInterval) {
    clearInterval(documentQueueInterval);
    documentQueueInterval = null;
  }
}

function checkAndTriggerCatchUpScan(): Promise<any> | void {
  try {
    const lastFullScan = getAppSetting('last_full_scan_at');
    const lastScanStr = lastFullScan || getLastSuccessfulScanTimestamp();
    const net = getCachedNetworkStatus();

    if (!lastScanStr) {
      const depth: ScanDepth = shouldRunDeepScanNow() ? 'deep' : 'quick';
      if (!canRunLightNetworkTask(net) || (depth === 'deep' && !canRunHeavyNetworkTask(net))) {
        if (depth === 'deep') setDeepScanPending(true);
        console.log(`[Tender Tracker Scheduler] Deferring initial ${depth} scan while network is ${net.state}.`);
        return;
      }
      console.log('[Tender Tracker Scheduler] No previous scan recorded. Initiating background crawl...');
      return schedulerDeps.startCrawlerScan(undefined, false, { depth });
    }

    const lastScan = new Date(lastScanStr).getTime();
    const now = Date.now();
    const hoursSinceLastScan = (now - lastScan) / (1000 * 60 * 60);

    // If more than 12 hours have elapsed since the last full successful scan (docs/15 F5)
    if (hoursSinceLastScan >= 12) {
      const depth: ScanDepth = shouldRunDeepScanNow(now) ? 'deep' : 'quick';
      if (!canRunLightNetworkTask(net) || (depth === 'deep' && !canRunHeavyNetworkTask(net))) {
        if (depth === 'deep') setDeepScanPending(true);
        console.log(`[Tender Tracker Scheduler] Deferring catch-up ${depth} scan while network is ${net.state}.`);
        return;
      }
      console.log(`[Tender Tracker Scheduler] Last scan was ${hoursSinceLastScan.toFixed(1)}h ago. Starting ${depth} catch-up scan...`);
      return schedulerDeps.startCrawlerScan(undefined, false, { depth });
    }
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Catch-up check failed:', err);
  }
}

/**
 * Dispatches an opt-in webhook digest once per Pakistan calendar day (Asia/Karachi)
 * when closingSoon <= withinHours or unacknowledged corrigenda exist.
 */
export async function maybeDispatchDailyDigest(nowMs: number = Date.now()): Promise<{ sent: boolean; reason: string }> {
  const settings = getDigestSettings();
  if (!settings.enabled) {
    return { sent: false, reason: 'disabled' };
  }
  if (!settings.webhookUrl) {
    return { sent: false, reason: 'no_webhook_url' };
  }
  const net = await checkNetworkHealth();
  if (!canRunLightNetworkTask(net)) {
    return { sent: false, reason: 'offline' };
  }
  const todayPkt = getPktDateKey(nowMs);
  if (settings.lastSentDatePkt === todayPkt) {
    return { sent: false, reason: 'already_sent_today' };
  }

  const summary = getAlertsDigest(settings.withinHours);
  if (summary.closingSoonCount === 0 && summary.unacknowledgedCorrigendaCount === 0) {
    return { sent: false, reason: 'no_urgent_alerts' };
  }

  await schedulerDeps.sendDigestWebhook(settings.webhookUrl, summary);
  setAppSetting('last_digest_sent_at', todayPkt);
  return { sent: true, reason: 'dispatched' };
}

/**
 * Daily health check for portals marked offline_broken or in error state.
 * Prevents continuous scan timeouts while keeping the operator advised daily.
 */
async function runDailyPortalHealthAdvisement() {
  try {
    const net = await checkNetworkHealth();
    if (!canRunHeavyNetworkTask(net)) {
      return;
    }
    const portals = getActivePortalsList();
    const problemPortals = portals.filter(p => p.accessMode === 'offline_broken' || p.verifiedStatus.toLowerCase().includes('broken'));
    let checkedCount = 0;

    for (const portal of problemPortals) {
      // Test single portal scan quietly to see if authority restored domain (Bug B2)
      try {
        await schedulerDeps.startCrawlerScan(portal.id, true);
        checkedCount++;
      } catch (err: any) {
        checkedCount++;
        updatePortalHealth(portal.id, {
          last_error_message: `Daily health check: Portal remains unreachable (${err.message})`
        });
      }
    }

    // Set lastDailyHealthCheck only after portals were actually checked (docs/16 B7)
    if (checkedCount > 0 || problemPortals.length === 0) {
      lastDailyHealthCheck = Date.now();
    }
  } catch (e) {
    console.warn('[Tender Tracker Scheduler] Daily health advisement check note:', e);
  }
}
