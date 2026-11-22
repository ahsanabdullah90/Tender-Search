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

export interface NetworkMonitorPorts {
  probeEndpoint: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  now: () => number;
  countPendingDocumentJobs: () => number;
}

export interface NetworkOutcomeOptions {
  isTimeout?: boolean;
  durationMs?: number;
  slowThresholdMs?: number;
}

interface PassiveTimeoutEvent {
  host: string;
  at: number;
}

function defaultProbeEndpoint(
  url: string,
  timeoutMs: number,
  nowFn: () => number = () => Date.now()
): Promise<ProbeResult> {
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

    const startedAt = nowFn();
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
        const latencyMs = Math.max(0, nowFn() - startedAt);
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

function filterDefinedPorts(overrides?: Partial<NetworkMonitorPorts>): Partial<NetworkMonitorPorts> {
  if (!overrides) return {};
  return {
    ...(overrides.probeEndpoint !== undefined ? { probeEndpoint: overrides.probeEndpoint } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.countPendingDocumentJobs !== undefined
      ? { countPendingDocumentJobs: overrides.countPendingDocumentJobs }
      : {})
  };
}

export class NetworkMonitor {
  private cachedStatus: NetworkStatus | null = null;
  private lastCheckedMs: number | null = null;
  private inFlightProbe: Promise<NetworkStatus> | null = null;
  private deepScanPending = false;
  private passiveTimeouts: PassiveTimeoutEvent[] = [];
  private readonly initialPorts?: Partial<NetworkMonitorPorts>;
  private ports: NetworkMonitorPorts;

  constructor(initialPorts?: Partial<NetworkMonitorPorts>) {
    this.initialPorts = initialPorts;
    this.ports = {
      ...this.createDefaultPorts(),
      ...filterDefinedPorts(initialPorts)
    };
  }

  private createDefaultPorts(): NetworkMonitorPorts {
    return {
      probeEndpoint: (url: string, timeoutMs: number) =>
        defaultProbeEndpoint(url, timeoutMs, () => this.ports.now()),
      now: () => Date.now(),
      countPendingDocumentJobs: () => {
        try {
          return countPendingDocumentJobs();
        } catch {
          return 0;
        }
      }
    };
  }

  private prunePassiveTimeouts(nowMs: number): void {
    this.passiveTimeouts = this.passiveTimeouts.filter(ev => nowMs - ev.at <= PASSIVE_WINDOW_MS);
  }

  private hasMultiHostPassiveTimeouts(nowMs: number): boolean {
    this.prunePassiveTimeouts(nowMs);
    if (this.passiveTimeouts.length < PASSIVE_DEGRADED_MIN_TIMEOUTS) return false;
    const hosts = new Set(this.passiveTimeouts.map(ev => ev.host));
    return hosts.size >= PASSIVE_DEGRADED_MIN_HOSTS;
  }

  private withCurrentCounts(base: NetworkStatus): NetworkStatus {
    return {
      ...base,
      deferredHeavyTasks: {
        deepScanPending: this.deepScanPending,
        pendingDocumentJobs: this.ports.countPendingDocumentJobs()
      }
    };
  }

  private buildStatus(
    state: NetworkState,
    latencyMs: number | null,
    checkedAt: string | null,
    reason: string | null
  ): NetworkStatus {
    return {
      state,
      latencyMs,
      checkedAt,
      reason,
      heavyTasksPaused: state !== 'online',
      deferredHeavyTasks: {
        deepScanPending: this.deepScanPending,
        pendingDocumentJobs: this.ports.countPendingDocumentJobs()
      }
    };
  }

  configurePorts(overrides: Partial<NetworkMonitorPorts>): () => void {
    const previous: NetworkMonitorPorts = { ...this.ports };
    this.ports = {
      ...this.ports,
      ...filterDefinedPorts(overrides)
    };
    return () => {
      this.ports = previous;
    };
  }

  getPorts(): Readonly<NetworkMonitorPorts> {
    return { ...this.ports };
  }

  reset(): void {
    this.cachedStatus = null;
    this.lastCheckedMs = null;
    this.inFlightProbe = null;
    this.deepScanPending = false;
    this.passiveTimeouts = [];
    this.ports = {
      ...this.createDefaultPorts(),
      ...filterDefinedPorts(this.initialPorts)
    };
  }

  /**
   * Probes network reachability & latency against dual lightweight endpoints (45s TTL cache).
   */
  async checkHealth(options: { force?: boolean } = {}): Promise<NetworkStatus> {
    const nowMs = this.ports.now();
    if (
      !options.force &&
      this.cachedStatus &&
      this.lastCheckedMs !== null &&
      nowMs - this.lastCheckedMs < NETWORK_PROBE_CACHE_TTL_MS
    ) {
      return this.withCurrentCounts(this.cachedStatus);
    }

    if (!options.force && this.inFlightProbe) {
      return this.inFlightProbe;
    }

    const runProbe = async (): Promise<NetworkStatus> => {
      const results = await Promise.all(
        NETWORK_PROBE_ENDPOINTS.map(ep => this.ports.probeEndpoint(ep, NETWORK_PROBE_TIMEOUT_MS))
      );
      const doneAtMs = this.ports.now();
      const checkedAt = new Date(doneAtMs).toISOString();
      const okResults = results.filter(r => r.ok);

      let next: NetworkStatus;
      if (okResults.length === 0) {
        const errDetail = results.map(r => r.error).filter(Boolean)[0];
        next = this.buildStatus(
          'offline',
          null,
          checkedAt,
          errDetail ? `No internet connectivity detected (${errDetail})` : 'No internet connectivity detected'
        );
      } else if (okResults.length < results.length) {
        const latency = typeof okResults[0].latencyMs === 'number' ? okResults[0].latencyMs : null;
        next = this.buildStatus('degraded', latency, checkedAt, 'Unstable network (partial connectivity probe timeout)');
      } else {
        const latencies = okResults
          .map(r => r.latencyMs)
          .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
        const latencyMs = latencies.length > 0 ? Math.min(...latencies) : 0;

        if (latencyMs >= NETWORK_DEGRADED_RTT_MS) {
          next = this.buildStatus('degraded', latencyMs, checkedAt, `Slow network detected (${latencyMs}ms latency)`);
        } else {
          // Explicit force re-check on a fast link clears stale passive timeout memory (no recovery deadlock)
          if (options.force) {
            this.passiveTimeouts = [];
          }
          if (this.hasMultiHostPassiveTimeouts(doneAtMs)) {
            next = this.buildStatus('degraded', latencyMs, checkedAt, 'Slow network detected (multiple portal timeouts)');
          } else {
            next = this.buildStatus('online', latencyMs, checkedAt, null);
          }
        }
      }

      this.cachedStatus = next;
      this.lastCheckedMs = doneAtMs;
      return this.withCurrentCounts(next);
    };

    const promise = runProbe().finally(() => {
      if (this.inFlightProbe === promise) {
        this.inFlightProbe = null;
      }
    });
    this.inFlightProbe = promise;
    return promise;
  }

  getCachedStatus(): NetworkStatus {
    if (this.cachedStatus) {
      return this.withCurrentCounts(this.cachedStatus);
    }
    return this.buildStatus('online', null, null, null);
  }

  canRunHeavyTask(status?: NetworkStatus): boolean {
    return (status ?? this.getCachedStatus()).state === 'online';
  }

  canRunLightTask(status?: NetworkStatus): boolean {
    return (status ?? this.getCachedStatus()).state !== 'offline';
  }

  setDeepScanPending(pending: boolean): void {
    this.deepScanPending = Boolean(pending);
  }

  isDeepScanPending(): boolean {
    return this.deepScanPending;
  }

  /**
   * Passive runtime feedback from portal HTML and dossier downloads.
   * Transitions cached status immediately to 'degraded' if multiple distinct hosts time out or
   * complete slowly inside a short sliding window.
   */
  reportOutcome(
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

    const nowMs = this.ports.now();
    this.prunePassiveTimeouts(nowMs);

    if (ok && !isSlow) {
      this.passiveTimeouts = this.passiveTimeouts.filter(ev => ev.host !== normHost);
      return;
    }

    if ((!ok && opts.isTimeout) || isSlow) {
      this.passiveTimeouts.push({ host: normHost, at: nowMs });
      if (this.hasMultiHostPassiveTimeouts(nowMs)) {
        this.cachedStatus = this.buildStatus(
          'degraded',
          this.cachedStatus?.latencyMs ?? null,
          new Date(nowMs).toISOString(),
          isSlow
            ? 'Slow network detected (multiple slow portal responses)'
            : 'Slow network detected (multiple portal timeouts)'
        );
        this.lastCheckedMs = nowMs;
      }
    }
  }
}

export const defaultNetworkMonitor = new NetworkMonitor();

export async function checkNetworkHealth(options: { force?: boolean } = {}): Promise<NetworkStatus> {
  return defaultNetworkMonitor.checkHealth(options);
}

export function getCachedNetworkStatus(): NetworkStatus {
  return defaultNetworkMonitor.getCachedStatus();
}

export function canRunHeavyNetworkTask(status?: NetworkStatus): boolean {
  return defaultNetworkMonitor.canRunHeavyTask(status);
}

export function canRunLightNetworkTask(status?: NetworkStatus): boolean {
  return defaultNetworkMonitor.canRunLightTask(status);
}

export function setDeepScanPending(pending: boolean): void {
  defaultNetworkMonitor.setDeepScanPending(pending);
}

export function isDeepScanPending(): boolean {
  return defaultNetworkMonitor.isDeepScanPending();
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

export function reportNetworkOutcome(
  host: string,
  ok: boolean,
  options: boolean | NetworkOutcomeOptions = false
): void {
  defaultNetworkMonitor.reportOutcome(host, ok, options);
}

export function resetNetworkMonitorForTests(): void {
  defaultNetworkMonitor.reset();
}
