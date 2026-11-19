import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkNetworkHealth,
  getCachedNetworkStatus,
  canRunHeavyNetworkTask,
  canRunLightNetworkTask,
  setDeepScanPending,
  isDeepScanPending,
  reportNetworkOutcome,
  isTransientNetworkError,
  resetNetworkMonitorForTests,
  networkMonitorDeps,
  NETWORK_PROBE_CACHE_TTL_MS,
  NETWORK_DEGRADED_RTT_MS,
  PASSIVE_SLOW_HTML_MS
} from '../../src/server/services/networkMonitor.js';

describe('networkMonitor', () => {
  beforeEach(() => {
    resetNetworkMonitorForTests();
  });

  it('classifies fast dual-endpoint responses as online and allows both heavy and light tasks', async () => {
    networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 120 });
    networkMonitorDeps.countPendingDocumentJobs = () => 4;

    const status = await checkNetworkHealth({ force: true });
    expect(status.state).toBe('online');
    expect(status.latencyMs).toBe(120);
    expect(status.reason).toBeNull();
    expect(status.heavyTasksPaused).toBe(false);
    expect(status.deferredHeavyTasks.pendingDocumentJobs).toBe(4);
    expect(canRunHeavyNetworkTask(status)).toBe(true);
    expect(canRunLightNetworkTask(status)).toBe(true);
  });

  it('classifies slow RTT (>= 1500ms) as degraded, pauses heavy tasks, and allows light tasks', async () => {
    networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: NETWORK_DEGRADED_RTT_MS + 250 });

    const status = await checkNetworkHealth({ force: true });
    expect(status.state).toBe('degraded');
    expect(status.heavyTasksPaused).toBe(true);
    expect(status.reason).toContain('Slow network detected');
    expect(canRunHeavyNetworkTask(status)).toBe(false);
    expect(canRunLightNetworkTask(status)).toBe(true);
  });

  it('classifies partial connectivity (1 of 2 probes failed) as degraded', async () => {
    let call = 0;
    networkMonitorDeps.probeEndpoint = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { ok: true, latencyMs: 90 } : { ok: false, latencyMs: null, error: 'Probe timed out' };
    });

    const status = await checkNetworkHealth({ force: true });
    expect(status.state).toBe('degraded');
    expect(status.latencyMs).toBe(90);
    expect(status.heavyTasksPaused).toBe(true);
    expect(canRunHeavyNetworkTask(status)).toBe(false);
    expect(canRunLightNetworkTask(status)).toBe(true);
  });

  it('classifies total probe failure as offline and pauses both heavy and light tasks', async () => {
    networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: false, latencyMs: null, error: 'ENETUNREACH' });

    const status = await checkNetworkHealth({ force: true });
    expect(status.state).toBe('offline');
    expect(status.latencyMs).toBeNull();
    expect(status.heavyTasksPaused).toBe(true);
    expect(status.reason).toContain('ENETUNREACH');
    expect(canRunHeavyNetworkTask(status)).toBe(false);
    expect(canRunLightNetworkTask(status)).toBe(false);
  });

  it('respects 45s TTL cache, supports { force: true }, and deduplicates concurrent probes', async () => {
    let currentTime = 1_000_000;
    networkMonitorDeps.now = () => currentTime;
    const probeSpy = vi.fn().mockResolvedValue({ ok: true, latencyMs: 45 });
    networkMonitorDeps.probeEndpoint = probeSpy;

    // Concurrent calls share one dual-endpoint probe batch (2 calls, not 4)
    const [a, b] = await Promise.all([checkNetworkHealth(), checkNetworkHealth()]);
    expect(a.state).toBe('online');
    expect(b.state).toBe('online');
    expect(probeSpy).toHaveBeenCalledTimes(2);

    // Within TTL: served from cache without calling probeEndpoint
    currentTime += NETWORK_PROBE_CACHE_TTL_MS - 1000;
    await checkNetworkHealth();
    expect(probeSpy).toHaveBeenCalledTimes(2);

    // Forced check bypasses TTL
    await checkNetworkHealth({ force: true });
    expect(probeSpy).toHaveBeenCalledTimes(4);

    // Past TTL: re-probes automatically
    currentTime += NETWORK_PROBE_CACHE_TTL_MS + 1000;
    await checkNetworkHealth();
    expect(probeSpy).toHaveBeenCalledTimes(6);
  });

  it('transitions to degraded via passive outcome tracking only across >= 2 distinct hosts', () => {
    let nowMs = 5_000_000;
    networkMonitorDeps.now = () => nowMs;

    // 3 timeouts on a SINGLE slow portal do NOT degrade the whole network
    reportNetworkOutcome('punjab_eproc', false, true);
    reportNetworkOutcome('punjab_eproc', false, true);
    reportNetworkOutcome('punjab_eproc', false, true);
    expect(getCachedNetworkStatus().state).toBe('online');

    // Timeouts across a second distinct host trip multi-host degradation
    reportNetworkOutcome('psdf.org.pk', false, true);
    const degraded = getCachedNetworkStatus();
    expect(degraded.state).toBe('degraded');
    expect(degraded.heavyTasksPaused).toBe(true);
    expect(degraded.reason).toContain('multiple portal timeouts');

    // Successful responses clear host timeouts cleanly
    reportNetworkOutcome('punjab_eproc', true);
    reportNetworkOutcome('psdf.org.pk', true);
  });

  it('tracks deepScanPending and pendingDocumentJobs counts on cached status', () => {
    networkMonitorDeps.countPendingDocumentJobs = () => 17;
    setDeepScanPending(true);
    expect(isDeepScanPending()).toBe(true);

    const cached = getCachedNetworkStatus();
    expect(cached.deferredHeavyTasks).toEqual({
      deepScanPending: true,
      pendingDocumentJobs: 17
    });

    setDeepScanPending(false);
    expect(getCachedNetworkStatus().deferredHeavyTasks.deepScanPending).toBe(false);
  });

  it('Refinement #1 & #4a: trips degraded on slow completions across >= 2 hosts and recovers immediately on forced fast probe', async () => {
    networkMonitorDeps.probeEndpoint = vi.fn().mockResolvedValue({ ok: true, latencyMs: 35 });

    // Local POP probe is fast, but 3 slow .gov.pk HTML fetches (>= 12s) occur across 2 hosts
    reportNetworkOutcome('epms.ppra.gov.pk', true, { durationMs: PASSIVE_SLOW_HTML_MS + 500, slowThresholdMs: PASSIVE_SLOW_HTML_MS });
    reportNetworkOutcome('epms.ppra.gov.pk', true, { durationMs: PASSIVE_SLOW_HTML_MS + 100, slowThresholdMs: PASSIVE_SLOW_HTML_MS });
    reportNetworkOutcome('psdf.org.pk', true, { durationMs: PASSIVE_SLOW_HTML_MS + 900, slowThresholdMs: PASSIVE_SLOW_HTML_MS });

    expect(getCachedNetworkStatus().state).toBe('degraded');
    expect(getCachedNetworkStatus().reason).toContain('slow portal responses');

    // Non-forced check inside 45s TTL remains degraded
    const cached = await checkNetworkHealth();
    expect(cached.state).toBe('degraded');

    // Forced re-check with fast probes clears passive timeouts immediately (no recovery deadlock)
    const recovered = await checkNetworkHealth({ force: true });
    expect(recovered.state).toBe('online');
    expect(recovered.heavyTasksPaused).toBe(false);
  });

  it('Refinement #3: isTransientNetworkError distinguishes transient network failures from HTTP 4xx/5xx or HTML rejections', () => {
    expect(isTransientNetworkError(new Error('connect ETIMEDOUT 65.21.235.75:443'))).toBe(true);
    expect(isTransientNetworkError(new Error('File download truncated before completion'))).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('HTTP 404'), { statusCode: 404 }))).toBe(false);
    expect(isTransientNetworkError(new Error('HTTP 500 from portal server'))).toBe(false);
    expect(isTransientNetworkError(new Error('Downloaded file is HTML (text/html), not a valid document'))).toBe(false);
  });
});
