import { describe, it, expect, vi, afterEach } from 'vitest';
import { getHumanJitterDelay, sleep, sslTolerantAgent, legacySslTolerantAgent, LEGACY_TLS_CIPHERS, isTlsFallbackError, HUMAN_CHROME_HEADERS } from '../../src/server/scrapers/baseScraper.js';

describe('baseScraper utility module', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getHumanJitterDelay', () => {
    it('returns a delay within the default 4000ms to 8500ms range', () => {
      for (let i = 0; i < 20; i++) {
        const delay = getHumanJitterDelay();
        expect(delay).toBeGreaterThanOrEqual(4000);
        expect(delay).toBeLessThanOrEqual(8500);
      }
    });

    it('returns a delay within custom bounds', () => {
      for (let i = 0; i < 10; i++) {
        const delay = getHumanJitterDelay(500, 1000);
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(1000);
      }
    });

    it('handles identical min and max', () => {
      expect(getHumanJitterDelay(3000, 3000)).toBe(3000);
    });
  });

  describe('sleep', () => {
    it('resolves after the specified time using fake timers', async () => {
      vi.useFakeTimers();
      let resolved = false;

      const promise = sleep(2500).then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);
      vi.advanceTimersByTime(2499);
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(1);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('sslTolerantAgent', () => {
    it('is configured to tolerate self-signed and expired TLS certificates and legacy gov.pk ciphers', () => {
      expect(sslTolerantAgent).toBeDefined();
      expect((sslTolerantAgent as any).options.rejectUnauthorized).toBe(false);
      expect((sslTolerantAgent as any).options.keepAlive).toBe(false);
      expect((sslTolerantAgent as any).options.timeout).toBe(25000);

      expect(legacySslTolerantAgent).toBeDefined();
      expect((legacySslTolerantAgent as any).options.rejectUnauthorized).toBe(false);
      expect((legacySslTolerantAgent as any).options.ciphers).toBe(LEGACY_TLS_CIPHERS);
      expect(LEGACY_TLS_CIPHERS).toContain('!ECDHE-RSA-AES256-SHA384');
      expect(LEGACY_TLS_CIPHERS).toContain('!ECDHE-RSA-AES256-GCM-SHA384');
      expect((legacySslTolerantAgent as any).options.minVersion).toBe('TLSv1');
    });
  });

  describe('isTlsFallbackError', () => {
    it('detects wrong version number and TLS handshake errors', () => {
      expect(isTlsFallbackError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: 'ssl3_get_record:wrong version number' })).toBe(true);
      expect(isTlsFallbackError(new Error('EPROTO handshake failure'))).toBe(true);
      expect(isTlsFallbackError(new Error('socket hang up'))).toBe(true);
      expect(isTlsFallbackError(new Error('HTTP 404 Not Found'))).toBe(false);
    });
  });

  describe('HUMAN_CHROME_HEADERS', () => {
    it('exports standard human Chrome headers including Windows UA and Urdu language preference', () => {
      expect(HUMAN_CHROME_HEADERS['User-Agent']).toContain('Mozilla/5.0');
      expect(HUMAN_CHROME_HEADERS['User-Agent']).toContain('Windows NT 10.0');
      expect(HUMAN_CHROME_HEADERS['Accept-Language']).toContain('ur;');
      expect(HUMAN_CHROME_HEADERS['sec-ch-ua-platform']).toBe('"Windows"');
      expect(HUMAN_CHROME_HEADERS['sec-fetch-site']).toBe('none');
      expect(HUMAN_CHROME_HEADERS['Upgrade-Insecure-Requests']).toBe('1');
    });
  });
});
