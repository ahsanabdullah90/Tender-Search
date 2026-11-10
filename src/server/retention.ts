import {
  getAppSetting,
  setAppSetting
} from './db/repositories/systemRepo.js';
import {
  getPassedTendersPendingSlim,
  getExpiredUnreviewedTenderIds,
  getAgedOutPassedTenderIds,
  cleanExpiredDeletedTenderRecords,
  slimPassedTenders,
  deleteTenders,
  releaseStaleStagingTenders
} from './db/repositories/tendersRepo.js';
import { releaseExpiredLeases } from './db/repositories/ingestJobsRepo.js';
import {
  retryPendingFilePurges,
  reconcileDossiers,
  ReconcileResult
} from './dossierStore.js';
import { db } from './db/connection.js';

export interface RetentionReport {
  slimmedCount: number;
  expiredDeletedCount: number;
  passedRetiredCount: number;
  purgesRetriedCount: number;
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
  lastRun: RetentionReport | null;
}

/**
 * Runs the automated lifecycle retention daemon
 */
export function runRetentionCycle(options: { dryRun?: boolean; forceAll?: boolean } = {}): RetentionReport {
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

  const graceDays = Math.max(1, parseInt(getAppSetting('retention_grace_days') || '2', 10));
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

  // 4. Clean expired suppression records
  if (!isDryRun) {
    cleanExpiredDeletedTenderRecords();
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
  const graceDays = Math.max(1, parseInt(getAppSetting('retention_grace_days') || '2', 10));
  const passedRetentionDays = Math.max(1, parseInt(getAppSetting('retention_passed_days') || '10', 10));

  const pendingSlim = getPassedTendersPendingSlim(2, 500);
  const expiredUnreviewed = getExpiredUnreviewedTenderIds(graceDays, 500);
  const agedOutPassed = getAgedOutPassedTenderIds(passedRetentionDays, 500);

  let pendingPurgesCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM pending_file_purges WHERE attempts < 10').get() as { c: number };
    pendingPurgesCount = row?.c || 0;
  } catch {}

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
    lastRun
  };
}
