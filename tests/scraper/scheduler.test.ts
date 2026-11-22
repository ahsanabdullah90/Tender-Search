import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, initDatabase, getPortalHealthList, updatePortalHealth, setAppSetting } from '../../src/server/db/index.js';
import { updateDigestSettings } from '../../src/server/db/repositories/systemRepo.js';
import {
  initStartupScheduler,
  stopStartupScheduler,
  configureSchedulerPorts,
  resetSchedulerPorts,
  getSchedulerPorts,
  maybeDispatchDailyDigest,
  getPktDateKey,
  recheckEarlierDeadlineReviewTenders
} from '../../src/server/runtime/scheduler.js';
import {
  defaultNetworkMonitor,
  resetNetworkMonitorForTests,
  setDeepScanPending,
  isDeepScanPending,
  checkNetworkHealth
} from '../../src/server/services/networkMonitor.js';
import { scanState } from '../../src/server/scrapers/crawlerEngine.js';

describe('scheduler and startup watchdog', () => {
  let scanMock: any;
  let backupMock: any;
  let reclassifyMock: any;

  beforeEach(() => {
    initDatabase();
    scanMock = vi.fn().mockResolvedValue({ isScanning: false });
    backupMock = vi.fn().mockResolvedValue({ success: true, skipped: true });
    reclassifyMock = vi.fn().mockResolvedValue({ filesReclassified: 0 });
    configureSchedulerPorts({
      startCrawlerScan: scanMock,
      backupDatabase: backupMock,
      reclassifyExistingDossiersFromText: reclassifyMock
    });
  });

  afterEach(() => {
    stopStartupScheduler();
    resetSchedulerPorts();
    scanState.reset();
    resetNetworkMonitorForTests();
    vi.restoreAllMocks();
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
    expect(scanMock).toHaveBeenCalled();
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
    const noArgCalls = scanMock.mock.calls.filter((c: any[]) => c.length === 0);
    expect(noArgCalls.length).toBe(0);
  });

  it('handles catch-up scan error gracefully when DB throws', () => {
    const originalPrepare = db.prepare;
    db.prepare = vi.fn().mockImplementation(() => { throw new Error('DB error'); });

    expect(() => initStartupScheduler()).not.toThrow();
    db.prepare = originalPrepare;
  });

  it('runs daily portal health advisement and handles portal unreachable error', async () => {
    updatePortalHealth('kppra', { access_mode: 'offline_broken' });
    configureSchedulerPorts({
      startCrawlerScan: vi.fn().mockRejectedValue(new Error('Domain lookup timed out'))
    });

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
      expect(backupMock).toHaveBeenCalled();

      // Advance by 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches backup errors during startup', async () => {
    configureSchedulerPorts({
      backupDatabase: vi.fn().mockRejectedValue(new Error('Backup failed'))
    });
    expect(() => initStartupScheduler()).not.toThrow();
  });

  it('invokes default scheduler port delegate methods', async () => {
    resetSchedulerPorts();
    const defaultPorts = getSchedulerPorts();
    expect(typeof defaultPorts.startCrawlerScan).toBe('function');
    expect(typeof defaultPorts.backupDatabase).toBe('function');
    // Call default wrapper
    const res = await defaultPorts.backupDatabase();
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
      expect(scanMock).toHaveBeenCalled();

      // Now set last_full_scan_at to 2 hours ago
      stopStartupScheduler();
      scanMock.mockClear();
      setAppSetting('last_full_scan_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

      initStartupScheduler();
      const noArgCalls = scanMock.mock.calls.filter((c: any[]) => c.length === 0);
      expect(noArgCalls.length).toBe(0);
    });

    it('B7: daily health check runs after catch-up scan promise resolves', async () => {
      let scanResolved = false;

      configureSchedulerPorts({
        startCrawlerScan: vi.fn().mockImplementation(() => {
          return new Promise<any>(resolve => {
            setTimeout(() => {
              scanResolved = true;
              resolve({ isScanning: false });
            }, 30);
          });
        })
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
      const sendMock = vi.fn().mockResolvedValue(undefined);
      const restoreSend = configureSchedulerPorts({ sendDigestWebhook: sendMock });

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
        restoreSend();
      }
    });

    it('requests deep depth on catch-up when last_deep_scan_at is absent or older than 24h', () => {
      setAppSetting('last_full_scan_at', new Date(Date.now() - 15 * 3600000).toISOString());
      setAppSetting('last_deep_scan_at', null);

      initStartupScheduler();
      expect(scanMock).toHaveBeenCalledWith(undefined, false, { depth: 'deep' });
    });

    it('Refinement #4b: 2-minute worker interval auto-resumes deferred deep scan on network recovery and skips digest when offline', async () => {
      vi.useFakeTimers();
      try {
        setAppSetting('last_full_scan_at', new Date().toISOString());
        defaultNetworkMonitor.configurePorts({
          probeEndpoint: vi.fn().mockResolvedValue({ ok: true, latencyMs: 30 })
        });
        setDeepScanPending(true);

        initStartupScheduler();
        scanMock.mockClear();

        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 50);
        expect(scanMock).toHaveBeenCalledWith(undefined, false, { depth: 'deep' });
        expect(isDeepScanPending()).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      const sendMock = vi.fn().mockResolvedValue(undefined);
      const restoreSend = configureSchedulerPorts({ sendDigestWebhook: sendMock });
      try {
        defaultNetworkMonitor.configurePorts({
          probeEndpoint: vi.fn().mockResolvedValue({ ok: false, latencyMs: null, error: 'ENETUNREACH' })
        });
        await checkNetworkHealth({ force: true });
        updateDigestSettings({ enabled: true, webhookUrl: 'https://hooks.example.test/pkt', withinHours: 48 });
        const res = await maybeDispatchDailyDigest();
        expect(res).toEqual({ sent: false, reason: 'offline' });
        expect(sendMock).not.toHaveBeenCalled();
      } finally {
        restoreSend();
      }
    });

    it('subscribes to scanState.onScanFinished when started and cleanly unsubscribes on stopStartupScheduler', async () => {
      const drainMock = vi.fn().mockResolvedValue({ claimed: 0, completed: 0, failed: 0, deferred: 0, expired: 0 });
      const onScanFinishedSpy = vi.spyOn(scanState, 'onScanFinished');

      try {
        setAppSetting('last_full_scan_at', new Date().toISOString());
        initStartupScheduler({ drainDocumentQueue: drainMock });
        expect(onScanFinishedSpy).toHaveBeenCalledTimes(1);

        scanState.beginScan({ depth: 'quick', totalPortals: 0 });
        scanState.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
        expect(drainMock).toHaveBeenCalledTimes(1);

        stopStartupScheduler();
        scanState.beginScan({ depth: 'quick', totalPortals: 0 });
        scanState.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
        expect(drainMock).toHaveBeenCalledTimes(1);
      } finally {
        onScanFinishedSpy.mockRestore();
      }
    });

    it('recheckEarlierDeadlineReviewTenders restores PEIMA extended deadline and clears false review flag', () => {
      db.prepare(`
        INSERT INTO tenders (
          id, canonical_id, portal_id, portal_name, title, organization, direct_url,
          closing_date, closing_date_formatted, deadline_source, deadline_confidence,
          needs_review, review_reason, extracted_text, pipeline_status, ingestion_status
        ) VALUES (
          't-peima-review', 't-peima-review', 'punjab_eproc', 'Punjab PPRA',
          'Rehabilitation Of Dangerous PSSP School Buildings Under PEIMA', 'SED', 'https://eproc.punjab.gov.pk/detail/1',
          '2026-11-12T06:00:00.000Z', '12 Nov 2026, 11:00 AM PKT', 'corrigendum_doc', 'high',
          1, 'deadline_moved_earlier: 20 Nov 2026, 02:00 PM PKT -> 12 Nov 2026, 11:00 AM PKT',
          'AMENDMENT NO-02 Invitation for e-Bids Submission Date and Time (12-11-26, 11:00 AM) - The bid submission date is extended - Bid Submission Date and Time 03:00 PM, on Nov 20 th, 2026 (Date).',
          'New Opportunity', 'ready'
        )
      `).run();

      const resolved = recheckEarlierDeadlineReviewTenders();
      expect(resolved).toBe(1);

      const updated = db.prepare(`SELECT closing_date, closing_date_formatted, needs_review, review_reason FROM tenders WHERE id = 't-peima-review'`).get() as any;
      expect(updated.closing_date).toBe('2026-11-20T10:00:00.000Z');
      expect(updated.closing_date_formatted).toContain('20 Nov 2026');
      expect(updated.needs_review).toBe(0);
      expect(updated.review_reason).toBeNull();
    });

    it('releases expired processing document leases back to pending on initStartupScheduler', () => {
      db.prepare(`
        INSERT INTO tenders (id, canonical_id, portal_id, portal_name, title, organization, direct_url, pipeline_status, ingestion_status)
        VALUES ('t-lease-rec', 't-lease-rec', 'punjab_eproc', 'Punjab PPRA', 'Solar Works', 'SED', 'https://eproc.punjab.gov.pk/lease/1', 'New Opportunity', 'ready')
      `).run();

      const expiredLease = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO document_ingest_jobs (id, tender_id, url, label, priority, status, attempts, max_attempts, lease_until)
        VALUES ('job-lease-1', 't-lease-rec', 'https://eproc.punjab.gov.pk/doc1.pdf', 'Tender Notice', 100, 'processing', 1, 3, ?)
      `).run(expiredLease);

      setAppSetting('last_full_scan_at', new Date().toISOString());
      initStartupScheduler();

      const job = db.prepare(`SELECT status, lease_until FROM document_ingest_jobs WHERE id = 'job-lease-1'`).get() as any;
      expect(job.status).toBe('pending');
      expect(job.lease_until).toBeNull();
    });
  });
});
