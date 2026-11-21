import http from 'http';
import https from 'https';
import { NetworkState, NetworkStatus } from '../../shared/types.js';
import { countPendingDocumentJobs } from '../db/index.js';

export const NETWORK_PROBE_ENDPOINTS = [
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://1.1.1.1/cdn-cgi/trace'
] as const;

export const NETWORK_PROBE_CACHE_TTL_MS = 45_000;
export const NETWORK_PROBE_TIMEOUT_MS = 4_500;
export const NETWORK_DEGRADED_RTT_MS = 1_500;
export const PASSIVE_WINDOW_MS = 2 * 60 * 1000;
export const PASSIVE_DEGRADED_MIN_TIMEOUTS = 3;
export const PASSIVE_DEGRADED_MIN_HOSTS = 2;
export const PASSIVE_SLOW_HTML_MS = 22_000;
export const PASSIVE_SLOW_DOC_MS = 30_000;

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

interface PassiveTimeoutEvent {
  host: string;
  at: number;
}

let cachedStatus: NetworkStatus | null = null;
let lastCheckedMs: number | null = null;
let inFlightProbe: Promise<NetworkStatus> | null = null;
let deepScanPending = false;
let passiveTimeouts: PassiveTimeoutEvent[] = [];

function defaultProbeEndpoint(url: string, timeoutMs: number): Promise<ProbeResult> {
  // Never make real internet requests inside automated Vitest runs (QA-3).
  if (process.env.VITEST) {
    return Promise.resolve({ ok: true, latencyMs: 12 });
  }

  return new Promise(resolve => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, latencyMs: null, error: 'Invalid probe URL' });
    }

    const startedAt = networkMonitorDeps.now();
    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let hardTimer: NodeJS.Timeout | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };

    const req = client.request(
      parsed,
      { method: 'HEAD', agent: false, timeout: timeoutMs },
      res => {
        res.resume();
        const status = res.statusCode ?? 0;
        const latencyMs = Math.max(0, networkMonitorDeps.now() - startedAt);
        finish({
          ok: status > 0 && status < 500,
          latencyMs,
          error: status >= 500 ? `HTTP ${status}` : undefined
        });
      }
    );

    hardTimer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish({ ok: false, latencyMs: null, error: 'Probe timed out' });
    }, timeoutMs + 250);

    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      finish({ ok: false, latencyMs: null, error: 'Probe timed out' });
    });

    req.on('error', (err: any) => {
      finish({ ok: false, latencyMs: null, error: err?.code || err?.message || 'Network error' });
    });

    req.end();
  });
}

export const networkMonitorDeps = {
  probeEndpoint: (url: string, timeoutMs: number) => defaultProbeEndpoint(url, timeoutMs),
  now: () => Date.now(),
  countPendingDocumentJobs: () => {
    try {
      return countPendingDocumentJobs();
    } catch {
      return 0;
    }
  }
};

function prunePassiveTimeouts(nowMs: number): void {
  passiveTimeouts = passiveTimeouts.filter(ev => nowMs - ev.at <= PASSIVE_WINDOW_MS);
}

function hasMultiHostPassiveTimeouts(nowMs: number): boolean {
  prunePassiveTimeouts(nowMs);
  if (passiveTimeouts.length < PASSIVE_DEGRADED_MIN_TIMEOUTS) return false;
  const hosts = new Set(passiveTimeouts.map(ev => ev.host));
  return hosts.size >= PASSIVE_DEGRADED_MIN_HOSTS;
}

function withCurrentCounts(base: NetworkStatus): NetworkStatus {
  return {
    ...base,
    deferredHeavyTasks: {
      deepScanPending,
      pendingDocumentJobs: networkMonitorDeps.countPendingDocumentJobs()
    }
  };
}

function buildStatus(state: NetworkState, latencyMs: number | null, checkedAt: string | null, reason: string | null): NetworkStatus {
  return {
    state,
    latencyMs,
    checkedAt,
    reason,
    heavyTasksPaused: state !== 'online',
    deferredHeavyTasks: {
      deepScanPending,
      pendingDocumentJobs: networkMonitorDeps.countPendingDocumentJobs()
    }
  };
}

/**
 * Probes network reachability & latency against dual lightweight endpoints (45s TTL cache).
 */
export async function checkNetworkHealth(options: { force?: boolean } = {}): Promise<NetworkStatus> {
  const nowMs = networkMonitorDeps.now();
  if (!options.force && cachedStatus && lastCheckedMs !== null && nowMs - lastCheckedMs < NETWORK_PROBE_CACHE_TTL_MS) {
    return withCurrentCounts(cachedStatus);
  }

  if (!options.force && inFlightProbe) {
    return inFlightProbe;
  }

  const runProbe = async (): Promise<NetworkStatus> => {
    const results = await Promise.all(
      NETWORK_PROBE_ENDPOINTS.map(ep => networkMonitorDeps.probeEndpoint(ep, NETWORK_PROBE_TIMEOUT_MS))
    );
    const doneAtMs = networkMonitorDeps.now();
    const checkedAt = new Date(doneAtMs).toISOString();
    const okResults = results.filter(r => r.ok);

    let next: NetworkStatus;
    if (okResults.length === 0) {
      const errDetail = results.map(r => r.error).filter(Boolean)[0];
      next = buildStatus(
        'offline',
        null,
        checkedAt,
        errDetail ? `No internet connectivity detected (${errDetail})` : 'No internet connectivity detected'
      );
    } else if (okResults.length < results.length) {
      const latency = typeof okResults[0].latencyMs === 'number' ? okResults[0].latencyMs : null;
      next = buildStatus('degraded', latency, checkedAt, 'Unstable network (partial connectivity probe timeout)');
    } else {
      const latencies = okResults
        .map(r => r.latencyMs)
        .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
      const latencyMs = latencies.length > 0 ? Math.min(...latencies) : 0;

      if (latencyMs >= NETWORK_DEGRADED_RTT_MS) {
        next = buildStatus('degraded', latencyMs, checkedAt, `Slow network detected (${latencyMs}ms latency)`);
      } else {
        // Explicit force re-check on a fast link clears stale passive timeout memory (no recovery deadlock)
        if (options.force) {
          passiveTimeouts = [];
        }
        if (hasMultiHostPassiveTimeouts(doneAtMs)) {
          next = buildStatus('degraded', latencyMs, checkedAt, 'Slow network detected (multiple portal timeouts)');
        } else {
          next = buildStatus('online', latencyMs, checkedAt, null);
        }
      }
    }

    cachedStatus = next;
    lastCheckedMs = doneAtMs;
    return withCurrentCounts(next);
  };

  const promise = runProbe().finally(() => {
    if (inFlightProbe === promise) {
      inFlightProbe = null;
    }
  });
  inFlightProbe = promise;
  return promise;
}

export function getCachedNetworkStatus(): NetworkStatus {
  if (cachedStatus) {
    return withCurrentCounts(cachedStatus);
  }
  return buildStatus('online', null, null, null);
}

export function canRunHeavyNetworkTask(status?: NetworkStatus): boolean {
  return (status ?? getCachedNetworkStatus()).state === 'online';
}

export function canRunLightNetworkTask(status?: NetworkStatus): boolean {
  return (status ?? getCachedNetworkStatus()).state !== 'offline';
}

export function setDeepScanPending(pending: boolean): void {
  deepScanPending = Boolean(pending);
}

export function isDeepScanPending(): boolean {
  return deepScanPending;
}

export interface NetworkOutcomeOptions {
  isTimeout?: boolean;
  durationMs?: number;
  slowThresholdMs?: number;
}

/**
 * Distinguishes transient connectivity/timeout/truncation failures (which should pause or defer
 * without exhausting job retries) from deterministic HTTP 4xx/5xx or invalid-file failures.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const anyErr = err as any;
  const status = Number(anyErr?.statusCode ?? anyErr?.status ?? 0);
  if (status >= 400 && status < 600) return false;

  const info = `${anyErr?.code ?? ''} ${anyErr?.name ?? ''} ${anyErr?.message ?? err ?? ''}`;
  if (/HTTP\s*[45]\d{2}|text\/html|exceeds maximum limit|Invalid URL|Too many redirects/i.test(info)) {
    return false;
  }

  return /\b(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|AbortError)\b|timed out|timeout|socket hang up|truncated|aborted by remote host|stream aborted|fetch failed|connection closed/i.test(info);
}

/**
 * Passive runtime feedback from portal HTML and dossier downloads.
 * Transitions cached status immediately to 'degraded' if multiple distinct hosts time out or
 * complete slowly inside a short sliding window.
 */
export function reportNetworkOutcome(
  host: string,
  ok: boolean,
  options: boolean | NetworkOutcomeOptions = false
): void {
  const normHost = (host || '').trim().toLowerCase();
  if (!normHost || normHost === '127.0.0.1' || normHost === 'localhost' || normHost === '::1') return;

  const opts: NetworkOutcomeOptions = typeof options === 'boolean' ? { isTimeout: options } : (options || {});
  const isSlow =
    ok &&
    typeof opts.durationMs === 'number' &&
    typeof opts.slowThresholdMs === 'number' &&
    opts.durationMs >= opts.slowThresholdMs;

  const nowMs = networkMonitorDeps.now();
  prunePassiveTimeouts(nowMs);

  if (ok && !isSlow) {
    passiveTimeouts = passiveTimeouts.filter(ev => ev.host !== normHost);
    return;
  }

  if ((!ok && opts.isTimeout) || isSlow) {
    passiveTimeouts.push({ host: normHost, at: nowMs });
    if (hasMultiHostPassiveTimeouts(nowMs)) {
      cachedStatus = buildStatus(
        'degraded',
        cachedStatus?.latencyMs ?? null,
        new Date(nowMs).toISOString(),
        isSlow ? 'Slow network detected (multiple slow portal responses)' : 'Slow network detected (multiple portal timeouts)'
      );
      lastCheckedMs = nowMs;
    }
  }
}

export function resetNetworkMonitorForTests(): void {
  cachedStatus = null;
  lastCheckedMs = null;
  inFlightProbe = null;
  deepScanPending = false;
  passiveTimeouts = [];
  networkMonitorDeps.probeEndpoint = (url: string, timeoutMs: number) => defaultProbeEndpoint(url, timeoutMs);
  networkMonitorDeps.now = () => Date.now();
  networkMonitorDeps.countPendingDocumentJobs = () => {
    try {
      return countPendingDocumentJobs();
    } catch {
      return 0;
    }
  };
}
