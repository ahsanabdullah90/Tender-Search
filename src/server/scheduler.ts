import { db, backupDatabase, getPortalHealthList, updatePortalHealth } from './db.js';
import { startCrawlerScan, getActivePortalsList } from './scrapers/crawlerEngine.js';
import { runRetentionCycle } from './retention.js';
import { backfillModelEmbeddings } from './embeddingBackfill.js';

let schedulerInterval: NodeJS.Timeout | null = null;
let retentionInterval: NodeJS.Timeout | null = null;
let lastDailyHealthCheck: number = 0;

export const schedulerDeps = {
  startCrawlerScan: (portalId?: string, awaitCompletion?: boolean) => startCrawlerScan(portalId, awaitCompletion),
  backupDatabase: () => backupDatabase(),
  runRetentionCycle: (opts?: any) => runRetentionCycle(opts),
  backfillModelEmbeddings: (limit?: number) => backfillModelEmbeddings(limit)
};

export function initStartupScheduler() {
  // 0. Reset any portals stuck in 'scanning' state from a previously interrupted process (Bug B3)
  try {
    const stuck = db.prepare("SELECT portal_id FROM portal_health WHERE status = 'scanning'").all() as { portal_id: string }[];
    for (const p of stuck) {
      updatePortalHealth(p.portal_id, {
        status: 'error',
        last_error_message: 'Previous scan was interrupted'
      });
    }
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Failed to reset stuck scanning portals:', err);
  }

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

  // 2. Check if a catch-up scan is required
  checkAndTriggerCatchUpScan();

  // 3. Daily check for broken/offline portals with operator advisement
  runDailyPortalHealthAdvisement();

  // 4. Periodic watchdog check every 30 minutes
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(() => {
    // Run backup check periodically so backups occur daily during long uptimes
    schedulerDeps.backupDatabase().catch(err => console.error('Periodic backup error:', err));
    checkAndTriggerCatchUpScan();

    // Check broken/offline links once every 24 hours
    if (Date.now() - lastDailyHealthCheck > 24 * 60 * 60 * 1000) {
      runDailyPortalHealthAdvisement();
    }
  }, 30 * 60 * 1000);
}

export function stopStartupScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }
}

function checkAndTriggerCatchUpScan() {
  try {
    const row = db.prepare("SELECT MAX(last_scan_at) as last_scan FROM portal_health WHERE status != 'error'").get() as any;
    const lastScanStr = row?.last_scan;

    if (!lastScanStr) {
      console.log('[Tender Tracker Scheduler] No previous scan recorded. Initiating background crawl...');
      schedulerDeps.startCrawlerScan();
      return;
    }

    const lastScan = new Date(lastScanStr).getTime();
    const now = Date.now();
    const hoursSinceLastScan = (now - lastScan) / (1000 * 60 * 60);

    // If more than 12 hours have elapsed since the last successful scan
    if (hoursSinceLastScan >= 12) {
      console.log(`[Tender Tracker Scheduler] Last scan was ${hoursSinceLastScan.toFixed(1)}h ago. Starting catch-up scan...`);
      schedulerDeps.startCrawlerScan();
    }
  } catch (err) {
    console.warn('[Tender Tracker Scheduler] Catch-up check failed:', err);
  }
}

/**
 * Daily health check for portals marked offline_broken or in error state.
 * Prevents continuous scan timeouts while keeping the operator advised daily.
 */
async function runDailyPortalHealthAdvisement() {
  lastDailyHealthCheck = Date.now();
  try {
    const portals = getActivePortalsList();
    const problemPortals = portals.filter(p => p.accessMode === 'offline_broken' || p.verifiedStatus.toLowerCase().includes('broken'));

    for (const portal of problemPortals) {
      // Test single portal scan quietly to see if authority restored domain (Bug B2)
      try {
        await schedulerDeps.startCrawlerScan(portal.id, true);
      } catch (err: any) {
        updatePortalHealth(portal.id, {
          last_error_message: `Daily health check: Portal remains unreachable (${err.message})`
        });
      }
    }
  } catch (e) {
    console.warn('[Tender Tracker Scheduler] Daily health advisement check note:', e);
  }
}
