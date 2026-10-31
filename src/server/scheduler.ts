import { db, backupDatabase } from './db.js';
import { startCrawlerScan } from './scrapers/crawlerEngine.js';

let schedulerInterval: NodeJS.Timeout | null = null;

export function initStartupScheduler() {
  // 1. Run database backup on startup if needed
  backupDatabase().catch(err => console.error('Startup backup error:', err));

  // 2. Check if a catch-up scan is required
  checkAndTriggerCatchUpScan();

  // 3. Periodic watchdog check every 30 minutes
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(() => {
    checkAndTriggerCatchUpScan();
  }, 30 * 60 * 1000);
}

function checkAndTriggerCatchUpScan() {
  try {
    const row = db.prepare('SELECT MAX(last_scan_at) as last_scan FROM portal_health').get() as any;
    const lastScanStr = row?.last_scan;

    if (!lastScanStr) {
      // First boot - trigger initial scan
      console.log('[Sentinel Scheduler] No previous scan recorded. Initiating background crawl...');
      startCrawlerScan();
      return;
    }

    const lastScan = new Date(lastScanStr).getTime();
    const now = Date.now();
    const hoursSinceLastScan = (now - lastScan) / (1000 * 60 * 60);

    // If more than 12 hours have elapsed since the last scan
    if (hoursSinceLastScan >= 12) {
      console.log(`[Sentinel Scheduler] Last scan was ${hoursSinceLastScan.toFixed(1)}h ago. Starting catch-up scan...`);
      startCrawlerScan();
    }
  } catch (err) {
    console.warn('[Sentinel Scheduler] Catch-up check failed:', err);
  }
}
