import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, getPortalHealthList, updatePortalHealth } from '../../src/server/db.js';
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
});
