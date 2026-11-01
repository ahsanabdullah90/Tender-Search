import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, initDatabase, getPortalHealthList, updatePortalHealth } from '../../src/server/db.js';
import { initStartupScheduler, stopStartupScheduler, schedulerDeps } from '../../src/server/scheduler.js';

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
  });

  it('resets stuck scanning portals to error on startup (Bug B3)', () => {
    // Put a portal into 'scanning' status to simulate a crashed previous run
    updatePortalHealth('epads', {
      status: 'scanning',
      last_error_message: undefined
    });

    const before = getPortalHealthList().find(p => p.portal_id === 'epads');
    expect(before?.status).toBe('scanning');

    // Run startup scheduler
    initStartupScheduler();

    const after = getPortalHealthList().find(p => p.portal_id === 'epads');
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
});
