import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, setAppSetting } from '../../src/server/db/index.js';
import { ScanStateStore, scanState } from '../../src/server/scrapers/scanState.js';
import { NetworkMonitor, defaultNetworkMonitor } from '../../src/server/services/networkMonitor.js';
import { defaultPlaywrightManager } from '../../src/server/scrapers/playwrightEngine.js';
import { defaultScheduler } from '../../src/server/runtime/scheduler.js';
import { createRuntimeContext, getDefaultRuntimeContext } from '../../src/server/runtime/context.js';

describe('RuntimeContext, ScanStateStore & NetworkMonitor isolation', () => {
  beforeEach(() => {
    initDatabase();
    scanState.reset({ clearListeners: false });
    defaultNetworkMonitor.reset();
  });

  afterEach(() => {
    scanState.reset({ clearListeners: false });
    defaultNetworkMonitor.reset();
    vi.restoreAllMocks();
  });

  describe('ScanStateStore transitions, immutability, doc fetches & listeners', () => {
    it('manages start lock, scan lifecycle, budget/tender counters, and finishScan', () => {
      const store = new ScanStateStore();
      const events: Array<{ type: string | undefined; isScanning: boolean; progress: number; current: string | null }> = [];
      const unsub = store.subscribe((status, eventType) => {
        events.push({
          type: eventType,
          isScanning: status.isScanning,
          progress: status.progressPercent,
          current: status.currentPortal
        });
      });

      expect(store.isStartingOrScanning()).toBe(false);
      expect(store.tryAcquireStart()).toBe(true);
      expect(store.isStartingOrScanning()).toBe(true);
      expect(store.tryAcquireStart()).toBe(false); // already locked

      store.beginScan({ depth: 'deep', totalPortals: 2 });
      store.releaseStartLock();
      expect(store.isScanning()).toBe(true);
      expect(store.isStartingOrScanning()).toBe(true);
      expect(store.tryAcquireStart()).toBe(false); // scanning

      store.setActivePortals(['Portal A', 'Portal B']);
      let snap = store.getSnapshot();
      expect(snap.activePortals).toEqual(['Portal A', 'Portal B']);
      expect(snap.currentPortal).toBe('Portal A');

      store.recordBudgetCounts(3, 2);
      store.recordTenderResult({ isNew: true, hasCorrigendum: true, awaitingScope: false });
      store.recordTenderResult({ isNew: false, hasCorrigendum: false, awaitingScope: true });
      store.completePortal(2, ['Portal B']);

      snap = store.getSnapshot();
      expect(snap.completedPortals).toBe(1);
      expect(snap.progressPercent).toBe(50);
      expect(snap.currentPortal).toBe('Portal B');
      expect(snap.newTendersFound).toBe(1);
      expect(snap.corrigendaFound).toBe(1);
      expect(snap.heldForScope).toBe(1);
      expect(snap.documentsDeferred).toBe(3);
      expect(snap.visionDeferred).toBe(2);

      const finishedTs = '2026-11-22T12:00:00.000Z';
      const finalSnap = store.finishScan({
        documentsDeferred: 4,
        visionDeferred: 1,
        timestamp: finishedTs,
        pausedReason: null
      });
      expect(finalSnap.isScanning).toBe(false);
      expect(finalSnap.progressPercent).toBe(100);
      expect(finalSnap.currentPortal).toBeNull();
      expect(finalSnap.activePortals).toEqual([]);
      expect(finalSnap.documentsDeferred).toBe(4);
      expect(finalSnap.visionDeferred).toBe(1);
      expect(finalSnap.lastScanTimestamp).toBe(finishedTs);
      expect(finalSnap.pausedReason).toBeNull();

      unsub();
      store.pauseScan('Offline pause test');
      expect(store.getSnapshot().pausedReason).toBe('Offline pause test');
      // After unsubscribe, pauseScan should not appear in events
      expect(events.some(e => e.type === 'scan_progress')).toBe(true);
      expect(events).toHaveLength(4); // beginScan, setActivePortals, completePortal, finishScan
    });

    it('returns immutable cloned snapshots and syncs lastFullScanTimestamp', () => {
      const store = new ScanStateStore();
      setAppSetting('last_full_scan_at', '2026-11-21T08:00:00.000Z');
      store.beginScan({ depth: 'quick', totalPortals: 1 });
      store.setActivePortals(['PPRA']);
      store.updateDocQueueStatus({
        isFetching: true,
        readyPending: 2,
        awaitingScopePending: 1,
        totalPending: 3,
        processing: 1,
        processingTenders: 1,
        activeTenderIds: ['tender-1'],
        completedInRun: 0,
        lastUpdatedAt: null
      });

      const snap = store.getSnapshot();
      expect(snap.lastFullScanTimestamp).toBe('2026-11-21T08:00:00.000Z');
      snap.isScanning = false;
      snap.activePortals!.push('Tampered');
      snap.docQueue!.activeTenderIds!.push('tampered-id');

      const fresh = store.getSnapshot();
      expect(fresh.isScanning).toBe(true);
      expect(fresh.activePortals).toEqual(['PPRA']);
      expect(fresh.docQueue?.activeTenderIds).toEqual(['tender-1']);

      const queueCopy = store.getDocQueue()!;
      queueCopy.activeTenderIds!.push('tampered-2');
      expect(store.getDocQueue()?.activeTenderIds).toEqual(['tender-1']);
    });

    it('tracks nested beginDocFetch / endDocFetch counts and merges with live docQueue', () => {
      const store = new ScanStateStore();
      const events: Array<{ eventType?: string; activeIds?: string[]; isFetching?: boolean }> = [];
      store.subscribe((s, ev) => {
        events.push({
          eventType: ev,
          activeIds: s.docQueue?.activeTenderIds,
          isFetching: s.docQueue?.isFetching
        });
      });

      store.beginDocFetch('t-1');
      store.beginDocFetch('t-1');
      store.beginDocFetch('t-2');
      expect(store.getInFlightDocFetchTenderIds()).toEqual(['t-1', 't-2']);

      const merged = store.mergeLiveDocQueueStatus({
        isFetching: false,
        readyPending: 0,
        awaitingScopePending: 0,
        totalPending: 0,
        processing: 0,
        processingTenders: 0,
        activeTenderIds: [],
        completedInRun: 0,
        lastUpdatedAt: null
      });
      expect(merged.isFetching).toBe(true);
      expect(merged.processing).toBe(2);
      expect(merged.processingTenders).toBe(2);
      expect(merged.activeTenderIds).toEqual(['t-1', 't-2']);

      store.endDocFetch('t-1');
      expect(store.getInFlightDocFetchTenderIds()).toEqual(['t-1', 't-2']); // nested ref count still 1

      store.endDocFetch('t-1');
      store.endDocFetch('t-2');
      expect(store.getInFlightDocFetchTenderIds()).toEqual([]);

      store.updateDocQueueStatus(
        {
          isFetching: false,
          readyPending: 0,
          awaitingScopePending: 0,
          totalPending: 0,
          completedInRun: 2,
          lastUpdatedAt: '2026-11-22T01:00:00.000Z'
        },
        { documentsUpdated: true }
      );
      expect(events.some(e => e.eventType === 'doc_queue_progress')).toBe(true);
      expect(events[events.length - 1].eventType).toBe('documents_updated');
    });

    it('isolates listener errors and supports unsubscribe on progress & onScanFinished', () => {
      const store = new ScanStateStore();
      const received: string[] = [];

      const badProgressListener = () => {
        throw new Error('SSE client disconnected');
      };
      const goodProgressListener = (_s: any, ev?: string) => {
        received.push(`progress:${ev}`);
      };

      const unsubBad = store.subscribe(badProgressListener);
      store.subscribe(goodProgressListener);

      const finishedCalls: string[] = [];
      const unsubBadFin = store.onScanFinished(() => {
        throw new Error('Post-scan hook failure');
      });
      const unsubGoodFin = store.onScanFinished(() => {
        finishedCalls.push('done');
      });

      store.beginScan({ depth: 'quick', totalPortals: 1 });
      store.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });

      expect(received).toEqual(['progress:scan_progress', 'progress:scan_progress']);
      expect(finishedCalls).toEqual(['done']);

      // Unsubscribe removes listeners cleanly
      unsubBad();
      store.unsubscribe(goodProgressListener);
      unsubBadFin();
      unsubGoodFin();

      store.beginScan({ depth: 'quick', totalPortals: 1 });
      store.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
      expect(received).toHaveLength(2);
      expect(finishedCalls).toHaveLength(1);

      // reset({ clearListeners: true }) clears remaining listeners too
      const extraListener = vi.fn();
      store.subscribe(extraListener);
      store.reset({ clearListeners: false });
      store.pauseScan('still subscribed');
      expect(extraListener).toHaveBeenCalledTimes(1);

      store.reset({ clearListeners: true });
      store.pauseScan('cleared');
      expect(extraListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('NetworkMonitor instance isolation', () => {
    it('isolates cache, deepScanPending, passive timeouts, and ports between NetworkMonitor instances', async () => {
      const monA = new NetworkMonitor({
        probeEndpoint: vi.fn().mockResolvedValue({ ok: false, latencyMs: null, error: 'ENETUNREACH' }),
        countPendingDocumentJobs: () => 5
      });
      const monB = new NetworkMonitor({
        probeEndpoint: vi.fn().mockResolvedValue({ ok: true, latencyMs: 25 }),
        countPendingDocumentJobs: () => 12
      });

      monA.setDeepScanPending(true);
      const statusA = await monA.checkHealth({ force: true });
      const statusB = await monB.checkHealth({ force: true });

      expect(statusA.state).toBe('offline');
      expect(statusA.deferredHeavyTasks).toEqual({ deepScanPending: true, pendingDocumentJobs: 5 });
      expect(monA.canRunLightTask(statusA)).toBe(false);

      expect(statusB.state).toBe('online');
      expect(statusB.deferredHeavyTasks).toEqual({ deepScanPending: false, pendingDocumentJobs: 12 });
      expect(monB.canRunHeavyTask(statusB)).toBe(true);

      // Default global singleton remains unaffected
      expect(defaultNetworkMonitor.isDeepScanPending()).toBe(false);
      expect(defaultNetworkMonitor.getCachedStatus().state).toBe('online');

      // configurePorts returns restore closure
      const restoreB = monB.configurePorts({
        probeEndpoint: vi.fn().mockResolvedValue({ ok: true, latencyMs: 2000 })
      });
      const degradedB = await monB.checkHealth({ force: true });
      expect(degradedB.state).toBe('degraded');
      restoreB();
      const restoredB = await monB.checkHealth({ force: true });
      expect(restoredB.state).toBe('online');
    });
  });

  describe('RuntimeContext isolation and default context', () => {
    it('returns a lazy singleton from getDefaultRuntimeContext backed by process defaults', () => {
      const ctx1 = getDefaultRuntimeContext();
      const ctx2 = getDefaultRuntimeContext();

      expect(ctx1).toBe(ctx2);
      expect(ctx1.scanState).toBe(scanState);
      expect(ctx1.networkMonitor).toBe(defaultNetworkMonitor);
      expect(ctx1.playwright).toBe(defaultPlaywrightManager);
      expect(ctx1.scheduler).toBe(defaultScheduler);
    });

    it('creates two independent createRuntimeContext() instances with zero shared mutable state', async () => {
      const ctxA = createRuntimeContext();
      const ctxB = createRuntimeContext();

      try {
        expect(ctxA.scanState).not.toBe(ctxB.scanState);
        expect(ctxA.scanState).not.toBe(scanState);
        expect(ctxA.networkMonitor).not.toBe(ctxB.networkMonitor);
        expect(ctxA.networkMonitor).not.toBe(defaultNetworkMonitor);
        expect(ctxA.playwright).not.toBe(ctxB.playwright);
        expect(ctxA.playwright).not.toBe(defaultPlaywrightManager);
        expect(ctxA.scheduler).not.toBe(ctxB.scheduler);
        expect(ctxA.scheduler).not.toBe(defaultScheduler);

        // 1. Scan state & worker gating isolation
        ctxA.scanState.setScanningForTest(true);
        ctxB.networkMonitor.configurePorts({
          probeEndpoint: vi.fn().mockResolvedValue({ ok: true, latencyMs: 20 })
        });
        ctxA.networkMonitor.setDeepScanPending(true);

        const reportA = await ctxA.processDocumentQueue(5);
        const reportB = await ctxB.processDocumentQueue(5);
        expect(reportA.skipped).toBe('scan_running');
        expect(reportB.skipped).toBeUndefined();
        expect(ctxB.scanState.isScanning()).toBe(false);
        expect(ctxB.networkMonitor.isDeepScanPending()).toBe(false);
        expect(scanState.isScanning()).toBe(false);

        // 2. Shutdown handler isolation
        const handlerA = vi.fn();
        const handlerB = vi.fn();
        ctxA.setShutdownHandler(handlerA);
        ctxB.setShutdownHandler(handlerB);
        expect(ctxA.getShutdownHandler()).toBe(handlerA);
        expect(ctxB.getShutdownHandler()).toBe(handlerB);
        ctxA.setShutdownHandler(null);
        expect(ctxA.getShutdownHandler()).toBeNull();
        expect(ctxB.getShutdownHandler()).toBe(handlerB);

        // 3. Scheduler -> scanState wiring isolation
        const drainA = vi.fn().mockResolvedValue({ claimed: 0, completed: 0, failed: 0, deferred: 0, expired: 0 });
        setAppSetting('last_full_scan_at', new Date().toISOString());
        ctxA.scheduler.start({
          drainDocumentQueue: drainA,
          backupDatabase: vi.fn().mockResolvedValue({ success: true }),
          runRetentionCycle: vi.fn(),
          reclassifyExistingDossiersFromText: vi.fn().mockResolvedValue({ filesReclassified: 0 }),
          startCrawlerScan: vi.fn().mockResolvedValue(ctxA.scanState.getSnapshot())
        });

        // Finishing a scan on ctxB or global scanState must NOT trigger ctxA's drain
        ctxB.scanState.beginScan({ depth: 'quick', totalPortals: 0 });
        ctxB.scanState.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
        scanState.beginScan({ depth: 'quick', totalPortals: 0 });
        scanState.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
        expect(drainA).not.toHaveBeenCalled();

        // Finishing a scan on ctxA triggers ctxA's drain
        ctxA.scanState.beginScan({ depth: 'quick', totalPortals: 0 });
        ctxA.scanState.finishScan({ documentsDeferred: 0, visionDeferred: 0, timestamp: new Date().toISOString() });
        expect(drainA).toHaveBeenCalledTimes(1);
      } finally {
        ctxA.scheduler.stop();
        ctxB.scheduler.stop();
      }
    });
  });
});
