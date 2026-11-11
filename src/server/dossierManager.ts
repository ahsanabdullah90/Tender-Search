import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { CachedDossier } from '../types.js';
import { DOSSIERS_DIR, getTenderById } from './db.js';
import { maxFileBytes } from './ingestBudget.js';

// Same folder the rest of the app uses (honours TENDER_DATA_DIR).
const DOSSIERS_ROOT = DOSSIERS_DIR;
if (!fs.existsSync(DOSSIERS_ROOT)) {
  fs.mkdirSync(DOSSIERS_ROOT, { recursive: true });
}

// Tolerant agent for legacy .gov.pk SSL certificates
const sslTolerantAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Derives a human-readable document label from a remote URL.
 * Automatically decodes Laravel / Filament -meta<base64>- filenames,
 * humanizes standard URL slugs, and disambiguates generic labels with an index.
 */
export function deriveDossierLabel(remoteUrl: string, fallbackLabel?: string, index?: number): string {
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

  const base = fallbackLabel && fallbackLabel.trim() ? fallbackLabel.trim() : 'Bidding Document';
  if (typeof index === 'number' && index > 1) {
    return `${base} ${index}`;
  }
  return base;
}

export interface DownloadDossierOptions {
  signal?: AbortSignal;
  maxBytes?: number;
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
  const tenderDir = path.resolve(DOSSIERS_ROOT, tenderId);

  // Derive smart label if passed label is generic or empty
  let effectiveLabel = label?.trim() || 'Bidding Document';
  if (!label || /^(bidding document|tender document|document|notice|tender notice image)$/i.test(label.trim())) {
    effectiveLabel = deriveDossierLabel(remoteUrl, label, docIndex);
  }

  try {
    const buffer = await fetchFileBuffer(remoteUrl, cookieHeader, 0, options);
    if (options?.signal?.aborted) return null;

    const ctHeader = (buffer as any)?.contentType;
    if (isHtmlContent(buffer, ctHeader)) {
      console.warn(`[DossierManager] Rejected HTML content from ${remoteUrl}`);
      return null;
    }

    if (!fs.existsSync(tenderDir)) {
      fs.mkdirSync(tenderDir, { recursive: true });
    }
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Extension is chosen strictly from magic bytes, Content-Type, or URL (never the label) (B4)
    const { ext, mimeType } = detectExtensionAndMime(buffer, ctHeader, remoteUrl);

    // Build base name from effectiveLabel without taking extension from label
    const cleanBase = effectiveLabel.replace(/\.[a-zA-Z0-9]{2,5}$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'document';
    let filename = `${cleanBase}${ext}`;
    let finalPath = path.resolve(tenderDir, filename);
    let finalLabel = effectiveLabel;

    if (fs.existsSync(finalPath)) {
      const existingBuffer = fs.readFileSync(finalPath);
      const existingHash = crypto.createHash('sha256').update(existingBuffer).digest('hex');
      if (existingHash !== hash) {
        // Only mark (Updated) when the SAME URL returns different bytes (B4)
        let isSameUrl = false;
        try {
          const t = getTenderById(tenderId);
          if (t && Array.isArray(t.cached_dossiers)) {
            const match = t.cached_dossiers.find(d => d.originalUrl === remoteUrl);
            if (match && match.sha256 !== hash) {
              isSameUrl = true;
            }
          } else if (!t) {
            isSameUrl = true;
          }
        } catch {
          isSameUrl = true;
        }

        if (isSameUrl) {
          filename = `${cleanBase}_v2_${Date.now()}${ext}`;
          finalPath = path.resolve(tenderDir, filename);
          if (!finalLabel.includes('Updated')) {
            finalLabel = `${finalLabel} (Updated)`;
          }
        } else {
          // Different URL collision: disambiguate with index, no "(Updated)"
          let counter = 2;
          while (fs.existsSync(path.resolve(tenderDir, `${cleanBase}_${counter}${ext}`))) {
            counter++;
          }
          filename = `${cleanBase}_${counter}${ext}`;
          finalPath = path.resolve(tenderDir, filename);
          if (!finalLabel.includes(String(counter))) {
            finalLabel = `${finalLabel} ${counter}`;
          }
        }
      }
    }

    fs.writeFileSync(finalPath, buffer);

    const webUrl = `/api/dossiers/${encodeURIComponent(tenderId)}/${encodeURIComponent(filename)}`;

    return {
      label: finalLabel,
      localPath: webUrl,
      originalUrl: remoteUrl,
      mimeType,
      sha256: hash,
      sizeBytes: buffer.length
    };
  } catch (err) {
    console.warn(`Failed to download dossier from ${remoteUrl}:`, (err as any)?.message || err);
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
  const tenderDir = path.resolve(DOSSIERS_ROOT, tenderId);
  if (!fs.existsSync(tenderDir)) {
    fs.mkdirSync(tenderDir, { recursive: true });
  }

  let safeFilename = (originalFilename || 'attachment.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeFilename.includes('.')) {
    const ext = explicitMimeType === 'application/pdf' ? '.pdf' : explicitMimeType === 'image/png' ? '.png' : '.jpg';
    safeFilename += ext;
  }

  let finalPath = path.resolve(tenderDir, safeFilename);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  if (fs.existsSync(finalPath)) {
    const ext = path.extname(safeFilename);
    const base = path.basename(safeFilename, ext);
    safeFilename = `${base}_${Date.now()}${ext}`;
    finalPath = path.resolve(tenderDir, safeFilename);
  }

  fs.writeFileSync(finalPath, buffer);

  const mimeType = explicitMimeType || getMimeType(safeFilename);
  const webUrl = `/api/dossiers/${encodeURIComponent(tenderId)}/${encodeURIComponent(safeFilename)}`;

  return {
    label: label?.trim() || path.basename(safeFilename, path.extname(safeFilename)).replace(/[_-]+/g, ' '),
    localPath: webUrl,
    originalUrl: webUrl,
    mimeType,
    sha256: hash,
    sizeBytes: buffer.length
  };
}

export function fetchFileBuffer(
  url: string,
  cookie?: string,
  redirectCount: number = 0,
  options?: DownloadDossierOptions
): Promise<Buffer> {
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
      agent: isHttps ? sslTolerantAgent : undefined,
      headers,
      timeout: 45000
    }, res => {
      // Follow redirects cleanly
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return finish(() => {
          fetchFileBuffer(nextUrl, cookie, redirectCount + 1, options).then(resolve).catch(reject);
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
        const fullBuf = Buffer.concat(chunks);
        if (isHtmlContent(fullBuf, contentType)) {
          return reject(new Error('Downloaded file content is HTML, not a valid document'));
        }
        (fullBuf as any).contentType = contentType;
        (fullBuf as any).contentDisposition = contentDisposition;
        resolve(fullBuf);
      }));
      res.on('error', err => finish(() => reject(err)));
    });

    const onAbort = () => {
      req.destroy();
      finish(() => reject(new Error('File download aborted')));
    };
    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', err => finish(() => reject(err)));
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
