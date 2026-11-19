import https from 'https';

/**
 * Generates a randomized human-like reading pause between 4.0s and 8.5s
 */
export function getHumanJitterDelay(minMs: number = 4000, maxMs: number = 8500): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
 * Returns true when an HTTPS error indicates a TLS handshake or record-layer cipher mismatch
 * that should be retried with legacySslTolerantAgent.
 */
export function isTlsFallbackError(err: any): boolean {
  const info = `${err?.code || ''} ${err?.message || ''}`;
  return /wrong version number|EPROTO|ERR_SSL|TLSV1|UNSUPPORTED_PROTOCOL|ECONNRESET|socket hang up/i.test(info);
}

export const HUMAN_CHROME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ur;q=0.8',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'Upgrade-Insecure-Requests': '1'
};
