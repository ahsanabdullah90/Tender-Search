import http from 'http';
import https from 'https';
import { HUMAN_CHROME_HEADERS, sslTolerantAgent, legacySslTolerantAgent } from './baseScraper.js';

export function fetchHtmlWithMetadata(
  url: string,
  redirectCount: number = 0,
  cookieStr?: string,
  useLegacyTls: boolean = false
): Promise<{ html: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects while loading portal page'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...HUMAN_CHROME_HEADERS };
    if (cookieStr) {
      reqHeaders['Cookie'] = cookieStr;
    }

    const req = client.get(url, {
      agent: isHttps ? (useLegacyTls ? legacySslTolerantAgent : sslTolerantAgent) : undefined,
      headers: reqHeaders,
      timeout: 25000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchHtmlWithMetadata(nextUrl, redirectCount + 1, cookieStr, useLegacyTls).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        const errChunks: Buffer[] = [];
        res.on('data', chunk => errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const errBody = Buffer.concat(errChunks).toString('utf8');
          if (
            (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) &&
            (errBody.includes('cloudflare') || errBody.includes('Just a moment') || errBody.includes('challenge'))
          ) {
            // Return challenge HTML so parsePortalHtml flags hitlRequired (Bug B4)
            return resolve({ html: errBody, finalUrl: url });
          }
          const httpErr: any = new Error(`HTTP ${res.statusCode} from portal server`);
          httpErr.statusCode = res.statusCode;
          return reject(httpErr);
        });
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const fullBuf = Buffer.concat(chunks);
        let charset: BufferEncoding = 'utf8';
        const ct = String(res.headers?.['content-type'] || '');
        const m = /charset=([^\s;]+)/i.exec(ct);
        const rawCharset = (m?.[1] || '').replace(/['"]/g, '').toLowerCase().trim();
        if (rawCharset === 'iso-8859-1' || rawCharset === 'latin1' || rawCharset === 'windows-1252') {
          charset = 'latin1';
        } else if (rawCharset === 'utf-16le' || rawCharset === 'ucs-2') {
          charset = 'utf16le';
        } else if (rawCharset === 'ascii') {
          charset = 'ascii';
        } else {
          // Check <meta charset="..."> in first 1024 bytes
          const sample = fullBuf.subarray(0, 1024).toString('ascii');
          const metaMatch = /<meta[^>]+charset=['"]?([a-zA-Z0-9_-]+)/i.exec(sample);
          const mc = (metaMatch?.[1] || '').toLowerCase().trim();
          if (mc === 'iso-8859-1' || mc === 'latin1' || mc === 'windows-1252') {
            charset = 'latin1';
          }
        }
        let html: string;
        try {
          html = fullBuf.toString(charset);
        } catch {
          html = fullBuf.toString('utf8');
        }
        resolve({ html, finalUrl: url });
      });
    });

    req.on('error', (err: any) => {
      const msg = String(err?.message || '');
      const code = String(err?.code || '');
      // Automatic fallback 1: If server speaks plain HTTP on an HTTPS URL ("wrong version number"), retry over http://
      if (isHttps && /wrong version number/i.test(msg)) {
        const httpUrl = url.replace(/^https:/i, 'http:');
        return fetchHtmlWithMetadata(httpUrl, redirectCount + 1, cookieStr, false).then(resolve).catch(() => reject(err));
      }
      // Automatic fallback 2: If modern TLS handshake fails on legacy .gov.pk server, retry once with legacySslTolerantAgent (SECLEVEL=0, TLSv1)
      if (
        isHttps &&
        !useLegacyTls &&
        (/EPROTO|ERR_SSL|TLSV1|UNSUPPORTED_PROTOCOL|ECONNRESET|socket hang up/i.test(`${code} ${msg}`))
      ) {
        return fetchHtmlWithMetadata(url, redirectCount, cookieStr, true).then(resolve).catch(() => reject(err));
      }
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

export function fetchHtmlWithTolerantAgent(url: string, redirectCount: number = 0, cookieStr?: string): Promise<string> {
  return fetchHtmlWithMetadata(url, redirectCount, cookieStr).then(res => res.html);
}
