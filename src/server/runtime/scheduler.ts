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
import { ScanDepth, ScanStatus, DigestSummary } from '../../shared/types.js';
import {
  startCrawlerScan,
  getActivePortalsList,
  scanState,
  type ScanStateStore
} from '../scrapers/crawlerEngine.js';
import { formatClosingDate } from '../domain/dateParser.js';
import { findSubmissionDeadlines } from '../services/documentExtractor.js';
import { migrateDossierFilenames, reclassifyExistingDossiersFromText } from '../services/dossierStore.js';
import { runRetentionCycle } from '../services/retention.js';
import { backfillModelEmbeddings } from '../services/embeddingBackfill.js';
import { drainDocumentQueue, type WorkerReport } from './ingestWorker.js';
import { defaultNetworkMonitor, type NetworkMonitor } from '../services/networkMonitor.js';

export { getPktDateKey };

export interface SchedulerPorts {
  startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, opts?: { depth?: ScanDepth }) => Promise<ScanStatus>;
  backupDatabase: () => Promise<any>;
  runRetentionCycle: (opts?: any) => any;
  backfillModelEmbeddings: (limit?: number) => Promise<any>;
  drainDocumentQueue: (opts?: { maxBatches?: number; batchSize?: number; concurrency?: number }) => Promise<WorkerReport>;
  reclassifyExistingDossiersFromText: () => Promise<any>;
  sendDigestWebhook: (webhookUrl: string, payload: DigestSummary) => Promise<void>;
}

export interface SchedulerControllerOptions {
  scanState?: ScanStateStore;
  networkMonitor?: NetworkMonitor;
  ports?: Partial<SchedulerPorts>;
}

function filterDefinedSchedulerPorts(overrides?: Partial<SchedulerPorts>): Partial<SchedulerPorts> {
  if (!overrides) return {};
  return {
    ...(overrides.startCrawlerScan !== undefined ? { startCrawlerScan: overrides.startCrawlerScan } : {}),
    ...(overrides.backupDatabase !== undefined ? { backupDatabase: overrides.backupDatabase } : {}),
    ...(overrides.runRetentionCycle !== undefined ? { runRetentionCycle: overrides.runRetentionCycle } : {}),
    ...(overrides.backfillModelEmbeddings !== undefined
      ? { backfillModelEmbeddings: overrides.backfillModelEmbeddings }
      : {}),
    ...(overrides.drainDocumentQueue !== undefined ? { drainDocumentQueue: overrides.drainDocumentQueue } : {}),
    ...(overrides.reclassifyExistingDossiersFromText !== undefined
      ? { reclassifyExistingDossiersFromText: overrides.reclassifyExistingDossiersFromText }
      : {}),
    ...(overrides.sendDigestWebhook !== undefined ? { sendDigestWebhook: overrides.sendDigestWebhook } : {})
  };
}

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

export class SchedulerController {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private retentionInterval: NodeJS.Timeout | null = null;
  private documentQueueInterval: NodeJS.Timeout | null = null;
  private startupDocDrainTimer: NodeJS.Timeout | null = null;
  private lastDailyHealthCheck: number = 0;
  private unsubscribeScanFinished: (() => void) | null = null;
  private readonly scanState: ScanStateStore;
  private readonly networkMonitor: NetworkMonitor;
  private readonly initialPorts?: Partial<SchedulerPorts>;
  private ports: SchedulerPorts;

  constructor(options?: SchedulerControllerOptions) {
    this.scanState = options?.scanState ?? scanState;
    this.networkMonitor = options?.networkMonitor ?? defaultNetworkMonitor;
    this.initialPorts = options?.ports;
    this.ports = {
      ...this.createDefaultPorts(),
      ...filterDefinedSchedulerPorts(options?.ports)
    };
  }

  private createDefaultPorts(): SchedulerPorts {
    return {
      startCrawlerScan: (portalId?: string, awaitCompletion?: boolean, opts?: { depth?: ScanDepth }) =>
        startCrawlerScan(portalId, awaitCompletion, {
          ...opts,
          scanState: this.scanState,
          networkMonitor: this.networkMonitor
        }),
      backupDatabase: () => backupDatabase(),
      runRetentionCycle: (opts?: any) => runRetentionCycle(opts),
      backfillModelEmbeddings: (limit?: number) => backfillModelEmbeddings(limit),
      drainDocumentQueue: (opts?: { maxBatches?: number; batchSize?: number; concurrency?: number }) =>
        drainDocumentQueue(opts, {
          scanState: this.scanState,
          networkMonitor: this.networkMonitor
        }),
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
  }

  getPorts(): Readonly<SchedulerPorts> {
    return { ...this.ports };
  }

  configurePorts(overrides: Partial<SchedulerPorts>): () => void {
    const previous: SchedulerPorts = { ...this.ports };
    this.ports = {
      ...this.ports,
      ...filterDefinedSchedulerPorts(overrides)
    };
    return () => {
      this.ports = previous;
    };
  }

  resetPorts(): void {
    this.ports = {
      ...this.createDefaultPorts(),
      ...filterDefinedSchedulerPorts(this.initialPorts)
    };
  }

  start(overrides?: Partial<SchedulerPorts>): void {
    if (overrides) {
      this.configurePorts(overrides);
    }

    // Ensure idempotency when start() is invoked repeatedly without an intervening stop()
    this.unsubscribeScanFinished?.();
    this.unsubscribeScanFinished = null;

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
    this.unsubscribeScanFinished = this.scanState.onScanFinished(() => {
      void this.ports.drainDocumentQueue().catch(err =>
        console.warn('[Tender Tracker Scheduler] Post-scan document drain error:', err)
      );
    });

    // 1. Run database backup on startup if needed
    this.ports.backupDatabase().catch(err => console.error('Startup backup error:', err));

    // 2. Initial retention cycle & 5-minute interval for Pass-slimming and cleanup
    try {
      this.ports.runRetentionCycle();
    } catch (err) {
      console.warn('[Tender Tracker Scheduler] Initial retention cycle error:', err);
    }
    if (this.retentionInterval) clearInterval(this.retentionInterval);
    this.retentionInterval = setInterval(() => {
      try {
        this.ports.runRetentionCycle();
      } catch (err) {
        console.warn('[Tender Tracker Scheduler] Retention cycle error:', err);
      }
      // Upgrade vectors written while the model was unavailable or after edits (no-op if the model is not loaded)
      this.ports.backfillModelEmbeddings(100).catch(err =>
        console.warn('[Tender Tracker Scheduler] Embedding backfill error:', err)
      );
    }, 5 * 60 * 1000);

    // 2b. Background document worker & deferred heavy-task recovery check every 2 minutes
    // (skips heavy network work when degraded/offline or while a scan is active).
    if (this.documentQueueInterval) clearInterval(this.documentQueueInterval);
    this.documentQueueInterval = setInterval(async () => {
      try {
        const net = await this.networkMonitor.checkHealth();
        if (!this.networkMonitor.canRunHeavyTask(net)) {
          return;
        }
        if (this.networkMonitor.isDeepScanPending() && !this.scanState.isScanning()) {
          this.networkMonitor.setDeepScanPending(false);
          this.ports.startCrawlerScan(undefined, false, { depth: 'deep' });
          return;
        }
        await this.ports.drainDocumentQueue();
      } catch (err) {
        console.warn('[Tender Tracker Scheduler] Document queue error:', err);
      }
    }, 2 * 60 * 1000);

    // 2c. Short non-blocking startup drain so pending Inbox documents begin downloading within seconds
    if (this.startupDocDrainTimer) clearTimeout(this.startupDocDrainTimer);
    this.startupDocDrainTimer = setTimeout(async () => {
      this.startupDocDrainTimer = null;
      try {
        await this.ports.reclassifyExistingDossiersFromText();
        if (this.scanState.isScanning()) return;
        const net = await this.networkMonitor.checkHealth();
        if (!this.networkMonitor.canRunHeavyTask(net)) return;
        await this.ports.drainDocumentQueue();
      } catch (err) {
        console.warn('[Tender Tracker Scheduler] Startup document drain error:', err);
      }
    }, 4000);

    // 2. Check if a catch-up scan is required; run daily health check after it finishes (docs/16 B7)
    const catchUpTask = this.checkAndTriggerCatchUpScan();
    if (catchUpTask && typeof (catchUpTask as any).then === 'function') {
      (catchUpTask as Promise<any>)
        .then(() => {
          this.runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
        })
        .catch(err => {
          console.warn('[Scheduler] Catch-up scan error:', err);
          this.runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
        });
    } else {
      this.runDailyPortalHealthAdvisement().catch(e => console.warn('[Scheduler] Health check error:', e));
    }

    // 3b. Opt-in once-per-PKT-day digest webhook dispatch
    this.maybeDispatchDailyDigest().catch(err => console.warn('[Tender Tracker Scheduler] Digest dispatch note:', err));

    // 4. Periodic watchdog check every 30 minutes
    if (this.schedulerInterval) clearInterval(this.schedulerInterval);
    this.schedulerInterval = setInterval(() => {
      // Run backup check periodically so backups occur daily during long uptimes
      this.ports.backupDatabase().catch(err => console.error('Periodic backup error:', err));
      const catchUpStarted = this.checkAndTriggerCatchUpScan();
      if (!catchUpStarted && shouldRunDeepScanNow()) {
        this.ports.startCrawlerScan(undefined, false, { depth: 'deep' });
      }
      this.maybeDispatchDailyDigest().catch(err => console.warn('[Tender Tracker Scheduler] Digest dispatch note:', err));

      // Check broken/offline links once every 24 hours
      if (Date.now() - this.lastDailyHealthCheck > 24 * 60 * 60 * 1000) {
        this.runDailyPortalHealthAdvisement();
      }
    }, 30 * 60 * 1000);
  }

  stop(): void {
    this.unsubscribeScanFinished?.();
    this.unsubscribeScanFinished = null;
    if (this.startupDocDrainTimer) {
      clearTimeout(this.startupDocDrainTimer);
      this.startupDocDrainTimer = null;
    }
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }
    if (this.documentQueueInterval) {
      clearInterval(this.documentQueueInterval);
      this.documentQueueInterval = null;
    }
    this.lastDailyHealthCheck = 0;
  }

  private checkAndTriggerCatchUpScan(): Promise<any> | void {
    try {
      const lastFullScan = getAppSetting('last_full_scan_at');
      const lastScanStr = lastFullScan || getLastSuccessfulScanTimestamp();
      const net = this.networkMonitor.getCachedStatus();

      if (!lastScanStr) {
        const depth: ScanDepth = shouldRunDeepScanNow() ? 'deep' : 'quick';
        if (
          !this.networkMonitor.canRunLightTask(net) ||
          (depth === 'deep' && !this.networkMonitor.canRunHeavyTask(net))
        ) {
          if (depth === 'deep') this.networkMonitor.setDeepScanPending(true);
          console.log(`[Tender Tracker Scheduler] Deferring initial ${depth} scan while network is ${net.state}.`);
          return;
        }
        console.log('[Tender Tracker Scheduler] No previous scan recorded. Initiating background crawl...');
        return this.ports.startCrawlerScan(undefined, false, { depth });
      }

      const lastScan = new Date(lastScanStr).getTime();
      const now = Date.now();
      const hoursSinceLastScan = (now - lastScan) / (1000 * 60 * 60);

      // If more than 12 hours have elapsed since the last full successful scan (docs/15 F5)
      if (hoursSinceLastScan >= 12) {
        const depth: ScanDepth = shouldRunDeepScanNow(now) ? 'deep' : 'quick';
        if (
          !this.networkMonitor.canRunLightTask(net) ||
          (depth === 'deep' && !this.networkMonitor.canRunHeavyTask(net))
        ) {
          if (depth === 'deep') this.networkMonitor.setDeepScanPending(true);
          console.log(`[Tender Tracker Scheduler] Deferring catch-up ${depth} scan while network is ${net.state}.`);
          return;
        }
        console.log(`[Tender Tracker Scheduler] Last scan was ${hoursSinceLastScan.toFixed(1)}h ago. Starting ${depth} catch-up scan...`);
        return this.ports.startCrawlerScan(undefined, false, { depth });
      }
    } catch (err) {
      console.warn('[Tender Tracker Scheduler] Catch-up check failed:', err);
    }
  }

  /**
   * Dispatches an opt-in webhook digest once per Pakistan calendar day (Asia/Karachi)
   * when closingSoon <= withinHours or unacknowledged corrigenda exist.
   */
  async maybeDispatchDailyDigest(
    nowMs: number = Date.now(),
    overrides?: Partial<SchedulerPorts>
  ): Promise<{ sent: boolean; reason: string }> {
    const effectivePorts = overrides
      ? { ...this.ports, ...filterDefinedSchedulerPorts(overrides) }
      : this.ports;

    const settings = getDigestSettings();
    if (!settings.enabled) {
      return { sent: false, reason: 'disabled' };
    }
    if (!settings.webhookUrl) {
      return { sent: false, reason: 'no_webhook_url' };
    }
    const net = await this.networkMonitor.checkHealth();
    if (!this.networkMonitor.canRunLightTask(net)) {
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

    await effectivePorts.sendDigestWebhook(settings.webhookUrl, summary);
    setAppSetting('last_digest_sent_at', todayPkt);
    return { sent: true, reason: 'dispatched' };
  }

  /**
   * Daily health check for portals marked offline_broken or in error state.
   * Prevents continuous scan timeouts while keeping the operator advised daily.
   */
  private async runDailyPortalHealthAdvisement() {
    try {
      const net = await this.networkMonitor.checkHealth();
      if (!this.networkMonitor.canRunHeavyTask(net)) {
        return;
      }
      const portals = getActivePortalsList();
      const problemPortals = portals.filter(p => p.accessMode === 'offline_broken' || p.verifiedStatus.toLowerCase().includes('broken'));
      let checkedCount = 0;

      for (const portal of problemPortals) {
        // Test single portal scan quietly to see if authority restored domain (Bug B2)
        try {
          await this.ports.startCrawlerScan(portal.id, true);
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
        this.lastDailyHealthCheck = Date.now();
      }
    } catch (e) {
      console.warn('[Tender Tracker Scheduler] Daily health advisement check note:', e);
    }
  }
}

export const defaultScheduler = new SchedulerController();

export function initStartupScheduler(overrides?: Partial<SchedulerPorts>): void {
  defaultScheduler.start(overrides);
}

export function stopStartupScheduler(): void {
  defaultScheduler.stop();
}

export function configureSchedulerPorts(overrides: Partial<SchedulerPorts>): () => void {
  return defaultScheduler.configurePorts(overrides);
}

export function resetSchedulerPorts(): void {
  defaultScheduler.resetPorts();
}

export function getSchedulerPorts(): Readonly<SchedulerPorts> {
  return defaultScheduler.getPorts();
}

export async function maybeDispatchDailyDigest(
  nowMs: number = Date.now(),
  overrides?: Partial<SchedulerPorts>
): Promise<{ sent: boolean; reason: string }> {
  return defaultScheduler.maybeDispatchDailyDigest(nowMs, overrides);
}
