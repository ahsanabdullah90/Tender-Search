import http from 'http';
import https from 'https';
import { HUMAN_CHROME_HEADERS, sslTolerantAgent, legacySslTolerantAgent, isTlsFallbackError, isStrictTlsHandshakeError } from './baseScraper.js';
import { isTransientNetworkError, reportNetworkOutcome, PASSIVE_SLOW_HTML_MS } from '../services/networkMonitor.js';

export interface HtmlFetchResult {
  html: string;
  finalUrl: string;
  cookies?: string;
}

export const LEGACY_TLS_TTL_MS = 30 * 60 * 1000;
const legacyTlsHosts = new Map<string, number>();

export function resetLegacyTlsHostsForTests(): void {
  legacyTlsHosts.clear();
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

function mergeCookies(existing?: string, setCookieHeaders?: string[]): string | undefined {
  const map = new Map<string, string>();
  for (const part of (existing || '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  for (const raw of setCookieHeaders || []) {
    const pair = raw.split(';')[0]?.trim() || '';
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  if (map.size === 0) return undefined;
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function requestHtmlWithMetadata(
  url: string,
  options: {
    method: 'GET' | 'POST';
    formBody?: string;
    cookieStr?: string;
    redirectCount: number;
    useLegacyTls: boolean;
    allowHttpDowngrade: boolean;
    timeoutMs?: number;
  }
): Promise<HtmlFetchResult> {
  const { method, formBody, cookieStr, redirectCount, useLegacyTls, allowHttpDowngrade, timeoutMs } = options;
  const startedAt = Date.now();
  const reportTopLevel = redirectCount === 0 && !useLegacyTls;
  let parsedUrlForTelemetry: URL | null = null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (val: HtmlFetchResult) => {
      if (settled) return;
      settled = true;
      if (reportTopLevel && parsedUrlForTelemetry) {
        reportNetworkOutcome(parsedUrlForTelemetry.hostname, true, {
          durationMs: Date.now() - startedAt,
          slowThresholdMs: PASSIVE_SLOW_HTML_MS
        });
      }
      resolve(val);
    };
    const finishReject = (err: any) => {
      if (settled) return;
      settled = true;
      if (reportTopLevel && parsedUrlForTelemetry && isTransientNetworkError(err)) {
        const isTimeout = /ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out/i.test(`${err?.code || ''} ${err?.message || ''}`);
        reportNetworkOutcome(parsedUrlForTelemetry.hostname, false, { isTimeout });
      }
      reject(err);
    };

    if (redirectCount > 5) {
      return finishReject(new Error('Too many redirects while loading portal page'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      parsedUrlForTelemetry = parsedUrl;
    } catch {
      return finishReject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const hostKey = parsedUrl.hostname.toLowerCase();
    const effectiveUseLegacyTls = useLegacyTls || (isHttps && isLegacyTlsHost(hostKey));
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...HUMAN_CHROME_HEADERS };
    if (cookieStr) {
      reqHeaders['Cookie'] = cookieStr;
    }
    if (method === 'POST' && formBody !== undefined) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(formBody));
      reqHeaders['Origin'] = parsedUrl.origin;
      reqHeaders['Referer'] = url;
      reqHeaders['sec-fetch-site'] = 'same-origin';
    }

    const reqOpts: https.RequestOptions = {
      agent: isHttps ? (effectiveUseLegacyTls ? legacySslTolerantAgent : sslTolerantAgent) : undefined,
      headers: reqHeaders,
      timeout: timeoutMs ?? (parsedUrl.hostname.includes('epms.ppra.gov.pk') ? 35000 : 25000)
    };

    const handleResponse = (res: http.IncomingMessage) => {
      const nextCookies = mergeCookies(cookieStr, res.headers?.['set-cookie']);

      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextHost = new URL(nextUrl).hostname.toLowerCase();
        // Never downgrade back to http:// if an http:// origin explicitly redirected us to https://
        const nextAllowDowngrade = allowHttpDowngrade && !(!isHttps && nextUrl.startsWith('https:'));
        return requestHtmlWithMetadata(nextUrl, {
          method: 'GET',
          cookieStr: nextCookies,
          redirectCount: redirectCount + 1,
          useLegacyTls: nextHost === hostKey ? effectiveUseLegacyTls : false,
          allowHttpDowngrade: nextAllowDowngrade,
          timeoutMs
        }).then(finishResolve).catch(finishReject);
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
            return finishResolve({ html: errBody, finalUrl: url, cookies: nextCookies });
          }
          const httpErr: any = new Error(`HTTP ${res.statusCode} from portal server`);
          httpErr.statusCode = res.statusCode;
          return finishReject(httpErr);
        });
        res.on('aborted', () => finishReject(new Error('Portal HTML stream aborted')));
        res.on('error', err => finishReject(err));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        if ((res as any).complete === false) {
          return finishReject(new Error('Portal HTML response truncated before completion'));
        }
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
        finishResolve({ html, finalUrl: url, cookies: nextCookies });
      });
      res.on('aborted', () => finishReject(new Error('Portal HTML stream aborted')));
      res.on('error', err => finishReject(err));
    };

    const req = method === 'POST'
      ? client.request(url, { ...reqOpts, method: 'POST' }, handleResponse)
      : client.get(url, reqOpts, handleResponse);

    req.on('error', (err: any) => {
      const msg = String(err?.message || '');
      // 1. Retry HTTPS TLS / cipher-record failures (including wrong version number) with legacySslTolerantAgent first
      if (isHttps && !effectiveUseLegacyTls && isTlsFallbackError(err)) {
        const shouldCacheHost = isStrictTlsHandshakeError(err);
        return requestHtmlWithMetadata(url, {
          ...options,
          useLegacyTls: true
        }).then((res) => {
          if (shouldCacheHost) {
            legacyTlsHosts.set(hostKey, Date.now());
          }
          finishResolve(res);
        }).catch(() => finishReject(err));
      }
      // 2. Only fall back to plain HTTP if legacy TLS already failed with wrong version number and we weren't redirected from HTTP
      if (isHttps && effectiveUseLegacyTls && allowHttpDowngrade && /wrong version number/i.test(msg)) {
        const httpUrl = url.replace(/^https:/i, 'http:');
        return requestHtmlWithMetadata(httpUrl, {
          ...options,
          redirectCount: redirectCount + 1,
          useLegacyTls: false,
          allowHttpDowngrade: false
        }).then(finishResolve).catch(() => finishReject(err));
      }
      finishReject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      finishReject(new Error('Connection timed out'));
    });

    if (method === 'POST' && formBody !== undefined) {
      req.write(formBody);
      req.end();
    }
  });
}

export function fetchHtmlWithMetadata(
  url: string,
  redirectCount: number = 0,
  cookieStr?: string,
  useLegacyTls: boolean = false,
  allowHttpDowngrade: boolean = true,
  timeoutMs?: number
): Promise<HtmlFetchResult> {
  return requestHtmlWithMetadata(url, {
    method: 'GET',
    cookieStr,
    redirectCount,
    useLegacyTls,
    allowHttpDowngrade,
    timeoutMs
  });
}

export function postFormWithMetadata(
  url: string,
  formBody: string,
  cookieStr?: string,
  timeoutMs?: number
): Promise<HtmlFetchResult> {
  return requestHtmlWithMetadata(url, {
    method: 'POST',
    formBody,
    cookieStr,
    redirectCount: 0,
    useLegacyTls: false,
    allowHttpDowngrade: false,
    timeoutMs
  });
}

export function fetchHtmlWithTolerantAgent(url: string, redirectCount: number = 0, cookieStr?: string): Promise<string> {
  return fetchHtmlWithMetadata(url, redirectCount, cookieStr).then(res => res.html);
}
