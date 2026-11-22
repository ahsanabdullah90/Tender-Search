import https from 'https';
import { Agent as UndiciAgent } from 'undici';

// Agent socket timeout ceiling (90s) sits above per-request timeouts (35s EPMS, 45s-90s PDFs)
// so individual request timeouts control slow-network cutoffs rather than agent pooling.
export const sslTolerantAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
  timeout: 90000
});

/**
 * Legacy cipher list excluding ECDHE-RSA-AES256-SHA384 / ECDHE-RSA-AES256-GCM-SHA384,
 * which trigger record-layer failures (ERR_SSL_WRONG_VERSION_NUMBER / ECONNRESET)
 * on older IIS 7.5 endpoints such as eproc.punjab.gov.pk.
 */
export const LEGACY_TLS_CIPHERS = 'DEFAULT:!ECDHE-RSA-AES256-SHA384:!ECDHE-RSA-AES256-GCM-SHA384:@SECLEVEL=0';

export const legacySslTolerantAgent = new https.Agent({
  rejectUnauthorized: false,
  ciphers: LEGACY_TLS_CIPHERS,
  minVersion: 'TLSv1',
  keepAlive: false,
  timeout: 90000
});

/**
 * Creates a fresh Undici dispatcher for native fetch()-based API scrapers,
 * tolerating self-signed or expired public procurement TLS certificates while keeping
 * keep-alive pooling enabled.
 */
export function createSslTolerantDispatcher(): UndiciAgent {
  return new UndiciAgent({
    connect: { rejectUnauthorized: false }
  });
}

/**
 * Shared Undici dispatcher singleton for native fetch()-based API scrapers and portal auth.
 */
export const sslTolerantDispatcher = createSslTolerantDispatcher();

/**
 * Returns true when an HTTPS error specifically indicates a TLS handshake or record-layer cipher mismatch
 * (not a transient socket reset), making the host eligible for TTL-bounded legacy TLS caching.
 */
export function isStrictTlsHandshakeError(err: any): boolean {
  const info = `${err?.code || ''} ${err?.message || ''}`;
  return /wrong version number|EPROTO|ERR_SSL|TLSV1|UNSUPPORTED_PROTOCOL/i.test(info);
}

/**
 * Returns true when an HTTPS error indicates a TLS handshake mismatch or transient socket reset
 * that should be retried once with legacySslTolerantAgent.
 */
export function isTlsFallbackError(err: any): boolean {
  if (isStrictTlsHandshakeError(err)) return true;
  const info = `${err?.code || ''} ${err?.message || ''}`;
  return /ECONNRESET|socket hang up/i.test(info);
}

export const LEGACY_TLS_TTL_MS = 30 * 60 * 1000;
const legacyTlsHosts = new Map<string, number>();

export function resetLegacyTlsHostsForTests(): void {
  legacyTlsHosts.clear();
}

export function markLegacyTlsHost(hostname: string): void {
  if (!hostname) return;
  legacyTlsHosts.set(hostname.toLowerCase(), Date.now());
}

export function isLegacyTlsHost(hostname: string): boolean {
  const key = hostname.toLowerCase();
  const cachedAt = legacyTlsHosts.get(key);
  if (cachedAt === undefined) return false;
  if (Date.now() - cachedAt > LEGACY_TLS_TTL_MS) {
    legacyTlsHosts.delete(key);
    return false;
  }
  return true;
}
