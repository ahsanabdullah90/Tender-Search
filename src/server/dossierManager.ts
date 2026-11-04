import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { CachedDossier } from '../types.js';
import { DOSSIERS_DIR } from './db.js';

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

/**
 * Downloads a remote file, saves it to data/dossiers/{tenderId}/, and computes SHA-256
 */
export async function downloadAndCacheDossier(
  tenderId: string,
  remoteUrl: string,
  label: string,
  cookieHeader?: string,
  docIndex?: number
): Promise<CachedDossier | null> {
  const tenderDir = path.resolve(DOSSIERS_ROOT, tenderId);
  if (!fs.existsSync(tenderDir)) {
    fs.mkdirSync(tenderDir, { recursive: true });
  }

  // Derive smart label if passed label is generic or empty
  let effectiveLabel = label?.trim() || 'Bidding Document';
  if (!label || /^(bidding document|tender document|document|notice|tender notice image)$/i.test(label.trim())) {
    effectiveLabel = deriveDossierLabel(remoteUrl, label, docIndex);
  }

  // Derive a safe filename based on effectiveLabel
  let filename = effectiveLabel.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!filename.includes('.')) {
    const ext = path.extname(remoteUrl.split('?')[0]) || '.pdf';
    filename += ext;
  }

  const localFilePath = path.resolve(tenderDir, filename);

  try {
    const buffer = await fetchFileBuffer(remoteUrl, cookieHeader);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Check if file already exists with same or different hash
    let finalPath = localFilePath;
    let finalLabel = effectiveLabel;
    if (fs.existsSync(localFilePath)) {
      const existingBuffer = fs.readFileSync(localFilePath);
      const existingHash = crypto.createHash('sha256').update(existingBuffer).digest('hex');
      if (existingHash !== hash) {
        // Corrigendum: file was updated on the server! Save new version alongside old one
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}_v2_${Date.now()}${ext}`;
        finalPath = path.resolve(tenderDir, filename);
        if (!finalLabel.includes('Updated')) {
          finalLabel = `${finalLabel} (Updated)`;
        }
      }
    }

    fs.writeFileSync(finalPath, buffer);

    const mimeType = getMimeType(filename);
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

function fetchFileBuffer(url: string, cookie?: string, redirectCount: number = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects while downloading dossier'));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,application/octet-stream,*/*'
    };
    if (cookie) headers['Cookie'] = cookie;

    const req = client.get(url, {
      agent: isHttps ? sslTolerantAgent : undefined,
      headers,
      timeout: 20000
    }, res => {
      // Follow redirects cleanly
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchFileBuffer(nextUrl, cookie, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} loading file`));
      }

      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('File download timed out'));
    });
  });
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
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
