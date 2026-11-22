import {
  getAppSetting,
  setAppSetting,
  countPendingFilePurges,
  pruneOldDailyVisionCounters
} from '../db/repositories/systemRepo.js';
import {
  getPassedTendersPendingSlim,
  getExpiredUnreviewedTenderIds,
  getAgedOutPassedTenderIds,
  cleanExpiredDeletedTenderRecords,
  slimPassedTenders,
  deleteTenders,
  releaseStaleStagingTenders,
  getStaleAwaitingScopeTenderIds,
  countAwaitingScopeTenders
} from '../db/repositories/tendersRepo.js';
import { releaseExpiredLeases } from '../db/repositories/ingestJobsRepo.js';
import {
  retryPendingFilePurges,
  reconcileDossiers,
  ReconcileResult
} from './dossierStore.js';
import { canRunHeavyNetworkTask } from './networkMonitor.js';

export interface RetentionReport {
  slimmedCount: number;
  expiredDeletedCount: number;
  passedRetiredCount: number;
  purgesRetriedCount: number;
  staleAwaitingScopeDeletedCount?: number;
  reconcileResult: ReconcileResult;
  timestamp: string;
  dryRun: boolean;
  skipped?: boolean;
}

export interface RetentionStatus {
  enabled: boolean;
  graceDays: number;
  passedRetentionDays: number;
  pendingSlimCount: number;
  expiredUnreviewedCount: number;
  agedOutPassedCount: number;
  pendingPurgesCount: number;
  awaitingScopeCount?: number;
  lastRun: RetentionReport | null;
}

/**
 * Runs the automated lifecycle retention daemon
 */
export function runRetentionCycle(options: { dryRun?: boolean; forceAll?: boolean; graceDays?: number } = {}): RetentionReport {
  const isDryRun = Boolean(options.dryRun);
  const enabled = getAppSetting('retention_auto_clean') !== 'false';

  const report: RetentionReport = {
    slimmedCount: 0,
    expiredDeletedCount: 0,
    passedRetiredCount: 0,
    purgesRetriedCount: 0,
    reconcileResult: {
      orphanFoldersCount: 0,
      orphanFolders: [],
      missingFilesRemovedFromTenders: 0,
      trashCleanedBytes: 0
    },
    timestamp: new Date().toISOString(),
    dryRun: isDryRun
  };

  if (!enabled && !options.forceAll) {
    report.skipped = true;
    return report;
  }

  const configuredGrace = parseInt(getAppSetting('retention_grace_days') || '2', 10);
  const graceDays = options.graceDays !== undefined
    ? Math.max(0, options.graceDays)
    : (isNaN(configuredGrace) ? 2 : Math.max(0, configuredGrace));
  const passedRetentionDays = Math.max(1, parseInt(getAppSetting('retention_passed_days') || '10', 10));
  const batchCap = 200;

  // 0. Release tenders stuck in 'staging' (e.g. the process died mid-ingest) so they become
  // visible and subject to the expiry rules below.
  if (!isDryRun) {
    releaseStaleStagingTenders(60);
    // Return document jobs whose worker died mid-download to the queue.
    releaseExpiredLeases();
  }

  // 1. Slim Passed tenders (undo window: 2 minutes)
  const pendingSlim = getPassedTendersPendingSlim(2, batchCap);
  if (pendingSlim.length > 0) {
    if (!isDryRun) {
      const slimResult = slimPassedTenders(pendingSlim);
      report.slimmedCount = slimResult.slimmedCount;
    } else {
      report.slimmedCount = pendingSlim.length;
    }
  }

  // 2. Delete expired unreviewed New Opportunities (closing date + graceDays is past)
  const expiredUnreviewed = getExpiredUnreviewedTenderIds(graceDays, batchCap);
  if (expiredUnreviewed.length > 0) {
    if (!isDryRun) {
      const deleteResult = deleteTenders(expiredUnreviewed, 'auto-expired');
      report.expiredDeletedCount = deleteResult.deletedCount;
    } else {
      report.expiredDeletedCount = expiredUnreviewed.length;
    }
  }

  // 2b. Clean up stale awaiting_scope tenders older than 3 days (held for documents that never arrived or matched).
  // Never purge awaiting_scope rows while heavy document tasks are paused due to slow/offline network (G1).
  if (canRunHeavyNetworkTask()) {
    const staleAwaitingScope = getStaleAwaitingScopeTenderIds(3, batchCap);
    if (staleAwaitingScope.length > 0) {
      if (!isDryRun) {
        const deleteResult = deleteTenders(staleAwaitingScope, 'no-track-match');
        report.staleAwaitingScopeDeletedCount = deleteResult.deletedCount;
      } else {
        report.staleAwaitingScopeDeletedCount = staleAwaitingScope.length;
      }
    }
  }

  // 3. Retire aged-out slim Passed records (closing_date / passed_at + 10 days is past)
  const agedOutPassed = getAgedOutPassedTenderIds(passedRetentionDays, batchCap);
  if (agedOutPassed.length > 0) {
    if (!isDryRun) {
      const retireResult = deleteTenders(agedOutPassed, 'passed-aged-out');
      report.passedRetiredCount = retireResult.deletedCount;
    } else {
      report.passedRetiredCount = agedOutPassed.length;
    }
  }

  // 4. Clean expired suppression records & old daily Vision counters
  if (!isDryRun) {
    cleanExpiredDeletedTenderRecords();
    pruneOldDailyVisionCounters(7);
  }

  // 5. Retry pending locked-file purges
  if (!isDryRun) {
    report.purgesRetriedCount = retryPendingFilePurges();
  }

  // 6. Reconcile dossiers on disk with DB
  report.reconcileResult = reconcileDossiers({
    dryRun: isDryRun,
    graceMinutes: 60
  });

  // Save last run metadata
  if (!isDryRun) {
    setAppSetting('last_retention_run', JSON.stringify(report));
    console.log(
      `[Retention] Cycle completed: ${report.slimmedCount} slimmed, ${report.expiredDeletedCount} expired deleted, ` +
      `${report.passedRetiredCount} passed retired, ${report.purgesRetriedCount} purges retried, ` +
      `${report.reconcileResult.orphanFoldersCount} orphan folders checked.`
    );
  }

  return report;
}

/**
 * Returns current retention system status, configuration, and pending item counts
 */
export function getRetentionStatus(): RetentionStatus {
  const enabled = getAppSetting('retention_auto_clean') !== 'false';
  const rawGrace = parseInt(getAppSetting('retention_grace_days') || '2', 10);
  const graceDays = Number.isFinite(rawGrace) ? Math.max(1, rawGrace) : 2;
  const rawPassed = parseInt(getAppSetting('retention_passed_days') || '10', 10);
  const passedRetentionDays = Number.isFinite(rawPassed) ? Math.max(1, rawPassed) : 10;

  const pendingSlim = getPassedTendersPendingSlim(2, 500);
  const expiredUnreviewed = getExpiredUnreviewedTenderIds(graceDays, 500);
  const agedOutPassed = getAgedOutPassedTenderIds(passedRetentionDays, 500);

  const pendingPurgesCount = countPendingFilePurges(10);

  let lastRun: RetentionReport | null = null;
  const lastRunRaw = getAppSetting('last_retention_run');
  if (lastRunRaw) {
    try {
      lastRun = JSON.parse(lastRunRaw);
    } catch {}
  }

  return {
    enabled,
    graceDays,
    passedRetentionDays,
    pendingSlimCount: pendingSlim.length,
    expiredUnreviewedCount: expiredUnreviewed.length,
    agedOutPassedCount: agedOutPassed.length,
    pendingPurgesCount,
    awaitingScopeCount: countAwaitingScopeTenders(),
    lastRun
  };
}
