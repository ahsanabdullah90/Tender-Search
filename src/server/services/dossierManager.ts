import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { CachedDossier } from '../../shared/types.js';
import { DOSSIERS_DIR, getTenderById } from '../db/index.js';
import {
  formatDocTypeDisplayLabel,
  getPortalFileCode,
  inferDocType,
  saveTenderDocument
} from './dossierStore.js';
import { maxFileBytes } from './ingestBudget.js';
import { sslTolerantAgent, legacySslTolerantAgent, isTlsFallbackError } from '../scrapers/baseScraper.js';
import { isSppraDownloadUrl, parseSppraDownloadUrl, downloadSppraFileBuffer } from '../scrapers/sppraApi.js';
import { isTransientNetworkError, reportNetworkOutcome, PASSIVE_SLOW_DOC_MS } from './networkMonitor.js';

// Same folder the rest of the app uses (honours TENDER_DATA_DIR).
const DOSSIERS_ROOT = DOSSIERS_DIR;
if (!fs.existsSync(DOSSIERS_ROOT)) {
  fs.mkdirSync(DOSSIERS_ROOT, { recursive: true });
}

/**
 * Derives a human-readable document label from a remote URL.
 * Automatically decodes Laravel / Filament -meta<base64>- filenames,
 * humanizes standard URL slugs, and disambiguates generic labels with an index.
 */
export function deriveDossierLabel(remoteUrl: string, fallbackLabel?: string, index?: number): string {
  // 0. Check for Sindh SPPRA synthetic DMS download URL (?name=...)
  const spParams = parseSppraDownloadUrl(remoteUrl);
  if (spParams?.label) {
    const base = spParams.label.trim();
    if (typeof index === 'number' && index > 1 && !base.endsWith(` ${index}`)) {
      return `${base} ${index}`;
    }
    return base;
  }

  try {
    const rawFilename = path.basename(remoteUrl.split('?')[0]);

    // 1. Check for Laravel / Filament / Livewire -meta<base64>- pattern
    const metaMatch = rawFilename.match(/-meta([A-Za-z0-9+/=]+)-/i);
    if (metaMatch && metaMatch[1]) {
      try {
        const decoded = Buffer.from(metaMatch[1], 'base64').toString('utf8').trim();
        if (decoded && decoded.length > 3) {
          const cleanDecoded = decoded.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanDecoded.length > 2) {
            return cleanDecoded;
          }
        }
      } catch {}
    }

    // 1b. Check for EPMS PPRA ?file=<base64> pattern (e.g. tender_attachments/bidding-document_1_415.pdf)
    try {
      const fileParam = new URL(remoteUrl, 'https://localhost').searchParams.get('file');
      if (fileParam && /^[A-Za-z0-9+/=]{8,}$/.test(fileParam)) {
        const decodedPath = Buffer.from(fileParam, 'base64').toString('utf8').trim();
        if (/^[\w./-]+$/.test(decodedPath) && /\.(pdf|docx?|xlsx?|jpe?g|png|webp)$/i.test(decodedPath)) {
          const decodedBase = path.basename(decodedPath)
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (decodedBase.length > 2) {
            return decodedBase;
          }
        }
      }
    } catch {}

    // 2. Check if raw filename is meaningful (not an opaque hash or ID)
    const baseNameWithoutExt = rawFilename.replace(/\.[a-z0-9]+$/i, '');
    const isOpaqueHash = /^[0-9a-f]{20,}$/i.test(baseNameWithoutExt) ||
                         /^\d+$/.test(baseNameWithoutExt) ||
                         /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(baseNameWithoutExt) ||
                         /^[a-zA-Z0-9]{25,}$/.test(baseNameWithoutExt);
    if (!isOpaqueHash && baseNameWithoutExt.length > 3) {
      const humanized = decodeURIComponent(baseNameWithoutExt)
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (humanized.length > 3 && !/^(download|view|file|document|notice|tender|rfp)$/i.test(humanized)) {
        return humanized;
      }
    }
  } catch {}

  const urlInferred = inferDocType('', remoteUrl);
  const urlFallback = urlInferred !== 'other' ? formatDocTypeDisplayLabel(urlInferred) : 'Bidding Document';
  const isNoisyOrGeneric =
    !fallbackLabel ||
    !fallbackLabel.trim() ||
    /_Doc(\s+\d+)?$/i.test(fallbackLabel.trim()) ||
    /^(bidding document|tender document|document|notice|tender notice|tender notice image)(\s+\d+)?$/i.test(
      fallbackLabel.trim()
    );
  const base = isNoisyOrGeneric
    ? (fallbackLabel && /^(tender notice image)$/i.test(fallbackLabel.trim()) ? fallbackLabel.trim() : urlFallback)
    : fallbackLabel.trim();
  if (typeof index === 'number' && index > 1 && !base.endsWith(` ${index}`)) {
    return `${base} ${index}`;
  }
  return base;
}

export interface DownloadDossierOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  onError?: (err: Error, meta: { isTransientNetwork: boolean }) => void;
  tenderMeta?: {
    portalId?: string | null;
    referenceNo?: string | null;
    title?: string | null;
  };
}

export function isHtmlContent(buffer: Buffer, contentTypeHeader?: string): boolean {
  if (contentTypeHeader) {
    const cleanCt = contentTypeHeader.split(';')[0].trim().toLowerCase();
    if (cleanCt === 'text/html' || cleanCt === 'application/xhtml+xml') return true;
  }
  const prefix = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<head');
}

export function detectExtensionAndMime(buffer: Buffer, contentTypeHeader?: string, url?: string): { ext: string; mimeType: string } {
  // 1. Magic bytes (highest authority)
  if (buffer.length >= 4) {
    if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
      return { ext: '.pdf', mimeType: 'application/pdf' };
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { ext: '.png', mimeType: 'image/png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { ext: '.jpg', mimeType: 'image/jpeg' };
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      const slice = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('binary');
      if (slice.includes('word/')) {
        return { ext: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      }
      if (slice.includes('xl/')) {
        return { ext: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      }
      return { ext: '.zip', mimeType: 'application/zip' };
    }
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      return { ext: '.doc', mimeType: 'application/msword' };
    }
  }

  // 2. Content-Type header
  if (contentTypeHeader) {
    const cleanCt = contentTypeHeader.split(';')[0].trim().toLowerCase();
    switch (cleanCt) {
      case 'application/pdf': return { ext: '.pdf', mimeType: 'application/pdf' };
      case 'image/png': return { ext: '.png', mimeType: 'image/png' };
      case 'image/jpeg':
      case 'image/jpg': return { ext: '.jpg', mimeType: 'image/jpeg' };
      case 'application/msword': return { ext: '.doc', mimeType: 'application/msword' };
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return { ext: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      case 'application/vnd.ms-excel': return { ext: '.xls', mimeType: 'application/vnd.ms-excel' };
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return { ext: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
  }

  // 3. Remote URL extension
  if (url) {
    try {
      const urlPath = new URL(url).pathname;
      const urlExt = path.extname(urlPath).toLowerCase();
      if (urlExt && /^\.[a-z0-9]{2,5}$/.test(urlExt)) {
        return { ext: urlExt, mimeType: getMimeType(urlExt) };
      }
    } catch {}
  }

  return { ext: '.pdf', mimeType: 'application/pdf' };
}

/**
 * Downloads a remote file, saves it to data/dossiers/{tenderId}/, and computes SHA-256
 */
export async function downloadAndCacheDossier(
  tenderId: string,
  remoteUrl: string,
  label: string,
  cookieHeader?: string,
  docIndex?: number,
  options?: DownloadDossierOptions
): Promise<CachedDossier | null> {
  // Derive smart label if passed label is generic, empty, or legacy *_Doc fallback
  let effectiveLabel = label?.trim() || 'Bidding Document';
  if (
    !label ||
    /_Doc(\s+\d+)?$/i.test(label.trim()) ||
    /^(bidding document|tender document|document|notice|tender notice|tender notice image)(\s+\d+)?$/i.test(label.trim())
  ) {
    effectiveLabel = deriveDossierLabel(remoteUrl, label, docIndex);
  }

  let hostForTelemetry = '';
  try { hostForTelemetry = new URL(remoteUrl).hostname; } catch {}
  const startedAt = Date.now();

  try {
    const buffer = await fetchFileBuffer(remoteUrl, cookieHeader, 0, options);
    if (options?.signal?.aborted) return null;

    if (hostForTelemetry) {
      reportNetworkOutcome(hostForTelemetry, true, {
        durationMs: Date.now() - startedAt,
        slowThresholdMs: PASSIVE_SLOW_DOC_MS
      });
    }

    const ctHeader = (buffer as any)?.contentType;
    if (isHtmlContent(buffer, ctHeader)) {
      console.warn(`[DossierManager] Rejected HTML content from ${remoteUrl}`);
      return null;
    }

    // Extension is chosen strictly from magic bytes, Content-Type, or URL (never the label) (B4)
    const { ext, mimeType } = detectExtensionAndMime(buffer, ctHeader, remoteUrl);
    const cdHeader = (buffer as any)?.contentDisposition as string | undefined;

    let tender: ReturnType<typeof getTenderById> | undefined;
    try {
      tender = getTenderById(tenderId);
    } catch {}

    const portalId = tender?.portal_id ?? options?.tenderMeta?.portalId ?? null;
    const referenceNo = tender?.reference_no ?? options?.tenderMeta?.referenceNo ?? null;
    const title = tender?.title ?? options?.tenderMeta?.title ?? null;

    let remoteBasename: string | undefined;
    try {
      const candidateName = path.basename(new URL(remoteUrl).pathname);
      if (candidateName && candidateName !== '/' && !/^download$/i.test(candidateName)) {
        remoteBasename = decodeURIComponent(candidateName);
      }
    } catch {}

    return saveTenderDocument(tenderId, buffer, {
      portalCode: portalId ? getPortalFileCode(portalId) : undefined,
      referenceNo,
      title,
      label: effectiveLabel,
      originalUrl: remoteUrl,
      originalName: remoteBasename,
      contentDisposition: cdHeader,
      extension: ext,
      mimeType,
      index: docIndex,
      existingDossiers: Array.isArray(tender?.cached_dossiers) ? tender.cached_dossiers : undefined,
      source: 'portal_scrape'
    });
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const transient = isTransientNetworkError(errObj);
    if (hostForTelemetry && transient) {
      reportNetworkOutcome(hostForTelemetry, false, { isTimeout: true });
    }
    try { options?.onError?.(errObj, { isTransientNetwork: transient }); } catch {}
    console.warn(`Failed to download dossier from ${remoteUrl}:`, errObj.message || err);
    return null;
  }
}

/**
 * Saves an uploaded or pasted file buffer directly to data/dossiers/{tenderId}/
 */
export function saveManualDossier(
  tenderId: string,
  originalFilename: string,
  buffer: Buffer,
  label?: string,
  explicitMimeType?: string
): CachedDossier {
  let tender: ReturnType<typeof getTenderById> | undefined;
  try {
    tender = getTenderById(tenderId);
  } catch {}

  const rawExt = path.extname(originalFilename || '');
  const ext =
    rawExt ||
    (explicitMimeType === 'application/pdf'
      ? '.pdf'
      : explicitMimeType === 'image/png'
        ? '.png'
        : explicitMimeType === 'image/webp'
          ? '.webp'
          : '.jpg');

  const doc = saveTenderDocument(tenderId, buffer, {
    portalCode: tender?.portal_id ? getPortalFileCode(tender.portal_id) : undefined,
    referenceNo: tender?.reference_no ?? null,
    title: tender?.title ?? null,
    label: label?.trim(),
    originalName: originalFilename || `attachment${ext}`,
    extension: ext,
    mimeType: explicitMimeType,
    existingDossiers: Array.isArray(tender?.cached_dossiers) ? tender.cached_dossiers : undefined,
    source: 'manual_upload'
  });

  return {
    ...doc,
    originalUrl: doc.originalUrl || doc.localPath
  };
}

export function fetchFileBuffer(
  url: string,
  cookie?: string,
  redirectCount: number = 0,
  options?: DownloadDossierOptions,
  useLegacyTls: boolean = false
): Promise<Buffer> {
  if (isSppraDownloadUrl(url)) {
    return downloadSppraFileBuffer(url, options);
  }
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      return reject(new Error('File download aborted'));
    }
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects while downloading dossier'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const limitBytes = options?.maxBytes ?? maxFileBytes();
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,application/octet-stream,*/*'
    };
    if (cookie) headers['Cookie'] = cookie;

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (options?.signal) options.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const req = client.get(url, {
      agent: isHttps ? (useLegacyTls ? legacySslTolerantAgent : sslTolerantAgent) : undefined,
      headers,
      timeout: options?.timeoutMs ?? 45000
    }, res => {
      // Follow redirects cleanly
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return finish(() => {
          fetchFileBuffer(nextUrl, cookie, redirectCount + 1, options, useLegacyTls).then(resolve).catch(reject);
        });
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return finish(() => reject(new Error(`HTTP ${res.statusCode} loading file`)));
      }

      const contentType = String(res.headers?.['content-type'] || '');
      const contentDisposition = String(res.headers?.['content-disposition'] || '');
      if (contentType.toLowerCase().includes('text/html') || contentType.toLowerCase().includes('application/xhtml+xml')) {
        res.resume();
        req.destroy();
        return finish(() => reject(new Error('Downloaded file is HTML (text/html), not a valid document')));
      }

      const contentLength = parseInt(String(res.headers?.['content-length'] || ''), 10);
      if (Number.isFinite(contentLength) && limitBytes > 0 && contentLength > limitBytes) {
        res.resume();
        req.destroy();
        return finish(() => reject(new Error(`File size (${contentLength} bytes) exceeds maximum limit (${limitBytes} bytes)`)));
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      res.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (limitBytes > 0 && receivedBytes > limitBytes) {
          req.destroy();
          finish(() => reject(new Error(`File download exceeded maximum size limit (${limitBytes} bytes)`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(() => {
        if ((res as any).complete === false) {
          return reject(new Error('File download truncated before completion'));
        }
        const fullBuf = Buffer.concat(chunks);
        if (Number.isFinite(contentLength) && contentLength > 0 && fullBuf.length < contentLength) {
          return reject(new Error(`File download truncated (received ${fullBuf.length} of ${contentLength} bytes)`));
        }
        if (isHtmlContent(fullBuf, contentType)) {
          return reject(new Error('Downloaded file content is HTML, not a valid document'));
        }
        (fullBuf as any).contentType = contentType;
        (fullBuf as any).contentDisposition = contentDisposition;
        resolve(fullBuf);
      }));
      res.on('aborted', () => finish(() => reject(new Error('File download aborted by remote host'))));
      res.on('error', err => finish(() => reject(err)));
    });

    const onAbort = () => {
      req.destroy();
      finish(() => reject(new Error('File download aborted')));
    };
    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', err => {
      if (isHttps && !useLegacyTls && isTlsFallbackError(err)) {
        return finish(() => {
          fetchFileBuffer(url, cookie, redirectCount, options, true).then(resolve).catch(() => reject(err));
        });
      }
      finish(() => reject(err));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(() => reject(new Error('File download timed out')));
    });
  });
}

function getMimeType(filename: string): string {
  const ext = filename.startsWith('.') ? filename.toLowerCase() : path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}
