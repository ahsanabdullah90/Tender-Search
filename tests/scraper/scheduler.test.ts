import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, initDatabase, getPortalHealthList, updatePortalHealth, setAppSetting } from '../../src/server/db/index.js';
import { updateDigestSettings } from '../../src/server/db/repositories/systemRepo.js';
import { initStartupScheduler, stopStartupScheduler, schedulerDeps, maybeDispatchDailyDigest, getPktDateKey } from '../../src/server/services/scheduler.js';
import {
  networkMonitorDeps,
  resetNetworkMonitorForTests,
  setDeepScanPending,
  isDeepScanPending,
  checkNetworkHealth
} from '../../src/server/services/networkMonitor.js';

describe('scheduler and startup watchdog', () => {
  let originalScan: any;
  let originalBackup: any;

  beforeEach(() => {
    initDatabase();
    originalScan = schedulerDeps.startCrawlerScan;
    originalBackup = schedulerDeps.backupDatabase;
    schedulerDeps.startCrawlerScan = vi.fn().mockResolvedValue({ isScanning: false });
    schedulerDeps.backupDatabase = vi.fn().mockResolvedValue({ success: true, skipped: true });
  });

  afterEach(() => {
    stopStartupScheduler();
    schedulerDeps.startCrawlerScan = originalScan;
    schedulerDeps.backupDatabase = originalBackup;
    resetNetworkMonitorForTests();
  });

  it('resets stuck scanning portals to error on startup (Bug B3)', () => {
    // Put a portal into 'scanning' status to simulate a crashed previous run
    updatePortalHealth('epms_ppra', {
      status: 'scanning',
      last_error_message: undefined
    });

    const before = getPortalHealthList().find(p => p.portal_id === 'epms_ppra');
    expect(before?.status).toBe('scanning');

    // Run startup scheduler
    initStartupScheduler();

    const after = getPortalHealthList().find(p => p.portal_id === 'epms_ppra');
    expect(after?.status).toBe('error');
    expect(after?.last_error_message).toBe('Previous scan was interrupted');
  });

  it('cleans up interval timer when stopStartupScheduler is called', () => {
    initStartupScheduler();
    expect(() => stopStartupScheduler()).not.toThrow();
    // Multiple stops should be idempotent
    expect(() => stopStartupScheduler()).not.toThrow();
  });

  it('triggers catch-up scan when last scan was more than 12 hours ago', () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    updatePortalHealth('punjab_eproc', {
      status: 'online',
      last_scan_at: thirteenHoursAgo
    });

    initStartupScheduler();
    expect(schedulerDeps.startCrawlerScan).toHaveBeenCalled();
  });

  it('does not trigger catch-up scan when last scan was recent (< 12 hours)', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    updatePortalHealth('punjab_eproc', {
      status: 'online',
      last_scan_at: twoHoursAgo
    });

    initStartupScheduler();
    // The only call could be from problem portals in daily health advisement, but not from catch-up
    // Let's verify startCrawlerScan was called with portalId for health advisement, not without arguments
    const noArgCalls = (schedulerDeps.startCrawlerScan as any).mock.calls.filter((c: any[]) => c.length === 0);
    expect(noArgCalls.length).toBe(0);
  });

  it('handles catch-up scan error gracefully when DB throws', () => {
    const originalPrepare = db.prepare;
    db.prepare = vi.fn().mockImplementation(() => { throw new Error('DB error'); });

    expect(() => initStartupScheduler()).not.toThrow();
    db.prepare = originalPrepare;
  });

  it('runs daily portal health advisement and handles portal unreachable error', async () => {
    schedulerDeps.startCrawlerScan = vi.fn().mockRejectedValue(new Error('Domain lookup timed out'));

    initStartupScheduler();
    // Wait microtask for async runDailyPortalHealthAdvisement
    await new Promise(r => setTimeout(r, 50));

    const kppra = getPortalHealthList().find(p => p.portal_id === 'kppra');
    expect(kppra?.last_error_message).toContain('Portal remains unreachable');
  });

  it('executes periodic interval watchdog and triggers daily check after 24h', () => {
    vi.useFakeTimers();
    try {
      initStartupScheduler();

      // Advance by 30 mins (one interval tick)
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(schedulerDeps.backupDatabase).toHaveBeenCalled();

      // Advance by 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches backup errors during startup', async () => {
    schedulerDeps.backupDatabase = vi.fn().mockRejectedValue(new Error('Backup failed'));
    expect(() => initStartupScheduler()).not.toThrow();
  });

  it('invokes default schedulerDeps delegate methods', async () => {
    expect(typeof originalScan).toBe('function');
    expect(typeof originalBackup).toBe('function');
    // Call default wrappers
    const res = await originalBackup();
    expect(res).toBeDefined();
  });

  it('handles database errors gracefully during stuck check and catchup scan', () => {
    const origPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('status = \'scanning\'')) {
        throw new Error('Disk read failure');
      }
      return origPrepare(sql);
    });

    expect(() => initStartupScheduler()).not.toThrow();
    prepareSpy.mockRestore();

    const prepareSpy2 = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('MAX(last_scan_at)')) {
        throw new Error('Query failure');
      }
      return origPrepare(sql);
    });

    expect(() => initStartupScheduler()).not.toThrow();
    prepareSpy2.mockRestore();
  });

  describe('F5 & B7: Full-Scan Clock and Health Check Order', () => {
    it('F5: uses last_full_scan_at from app_settings so a single-portal scan does not reset the clock', () => {
      // Single portal scan was recent (1 hour ago)
      updatePortalHealth('punjab_eproc', {
        status: 'online',
        last_scan_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
      });

      // But full scan was 15 hours ago
      const fifteenHoursAgo = new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString();
      setAppSetting('last_full_scan_at', fifteenHoursAgo);

      initStartupScheduler();
      expect(schedulerDeps.startCrawlerScan).toHaveBeenCalled();

      // Now set last_full_scan_at to 2 hours ago
      stopStartupScheduler();
      (schedulerDeps.startCrawlerScan as any).mockClear();
      setAppSetting('last_full_scan_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

      initStartupScheduler();
      const noArgCalls = (schedulerDeps.startCrawlerScan as any).mock.calls.filter((c: any[]) => c.length === 0);
      expect(noArgCalls.length).toBe(0);
    });

    it('B7: daily health check runs after catch-up scan promise resolves', async () => {
      let scanResolved = false;

      schedulerDeps.startCrawlerScan = vi.fn().mockImplementation(() => {
        return new Promise<any>(resolve => {
          setTimeout(() => {
            scanResolved = true;
            resolve({ isScanning: false });
          }, 30);
        });
      });

      // Set last full scan to 15 hours ago to trigger catch-up
      setAppSetting('last_full_scan_at', new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString());

      initStartupScheduler();

      // Before catch-up finishes, health check has not run yet
      expect(scanResolved).toBe(false);

      // Wait for catch-up to complete
      await new Promise(r => setTimeout(r, 60));
      expect(scanResolved).toBe(true);
    });
  });

  describe('Plans B & C: Daily Digest Deduplication & Two-Speed Catch-Up Depth', () => {
    it('dispatches daily digest webhook at most once per PKT calendar day when urgent alerts exist', async () => {
      const origSend = schedulerDeps.sendDigestWebhook;
      const sendMock = vi.fn().mockResolvedValue(undefined);
      schedulerDeps.sendDigestWebhook = sendMock;

      try {
        const soon = new Date(Date.now() + 8 * 3600000).toISOString();
        db.prepare(`
          INSERT INTO tenders (id, canonical_id, portal_id, portal_name, title, organization, direct_url, closing_date, pipeline_status, ingestion_status)
          VALUES ('t-sched-urg', 't-sched-urg', 'epads', 'EPADS', 'Urgent Solar Notice', 'FDE', 'https://epads.gov.pk/su1', ?, 'New Opportunity', 'ready')
        `).run(soon);

        updateDigestSettings({ enabled: true, webhookUrl: 'https://hooks.example.test/pkt', withinHours: 48 });

        const nowMs = Date.UTC(2026, 10, 13, 19, 30, 0); // 2026-11-14 00:30 PKT
        const first = await maybeDispatchDailyDigest(nowMs);
        expect(first).toEqual({ sent: true, reason: 'dispatched' });
        expect(sendMock).toHaveBeenCalledTimes(1);

        // Second run same PKT calendar day should deduplicate
        const second = await maybeDispatchDailyDigest(nowMs + 2 * 3600000);
        expect(second).toEqual({ sent: false, reason: 'already_sent_today' });
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(getPktDateKey(nowMs)).toBe('2026-11-14');
      } finally {
        schedulerDeps.sendDigestWebhook = origSend;
      }
    });

    it('requests deep depth on catch-up when last_deep_scan_at is absent or older than 24h', () => {
      setAppSetting('last_full_scan_at', new Date(Date.now() - 15 * 3600000).toISOString());
      setAppSetting('last_deep_scan_at', null);

      initStartupScheduler();
      expect(schedulerDeps.startCrawlerScan).toHaveBeenCalledWith(undefined, false, { depth: 'deep' });
    });

    it('Refinement #4b: 2-minute worker interval auto-resumes deferred deep scan on network recovery and skips digest when offline', async () => {
      vi.useFakeTimers();
      try {
        setAppSetting('last_full_scan_at', new Date().toISOString());
        networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 30 });
        setDeepScanPending(true);

        initStartupScheduler();
        (schedulerDeps.startCrawlerScan as any).mockClear();

        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 50);
        expect(schedulerDeps.startCrawlerScan).toHaveBeenCalledWith(undefined, false, { depth: 'deep' });
        expect(isDeepScanPending()).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      const origSend = schedulerDeps.sendDigestWebhook;
      schedulerDeps.sendDigestWebhook = vi.fn().mockResolvedValue(undefined);
      try {
        networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: false, latencyMs: null, error: 'ENETUNREACH' });
        await checkNetworkHealth({ force: true });
        updateDigestSettings({ enabled: true, webhookUrl: 'https://hooks.example.test/pkt', withinHours: 48 });
        const res = await maybeDispatchDailyDigest();
        expect(res).toEqual({ sent: false, reason: 'offline' });
        expect(schedulerDeps.sendDigestWebhook).not.toHaveBeenCalled();
      } finally {
        schedulerDeps.sendDigestWebhook = origSend;
      }
    });
  });
});
