export {
  sslTolerantAgent,
  LEGACY_TLS_CIPHERS,
  legacySslTolerantAgent,
  createSslTolerantDispatcher,
  sslTolerantDispatcher,
  isStrictTlsHandshakeError,
  isTlsFallbackError
} from '../domain/tlsTransport.js';

/**
 * Generates a randomized human-like reading pause between 4.0s and 8.5s
 */
export function getHumanJitterDelay(minMs: number = 4000, maxMs: number = 8500): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
