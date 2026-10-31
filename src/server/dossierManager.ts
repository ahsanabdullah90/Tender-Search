import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { CachedDossier } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DOSSIERS_ROOT = path.resolve(PROJECT_ROOT, 'data', 'dossiers');
if (!fs.existsSync(DOSSIERS_ROOT)) {
  fs.mkdirSync(DOSSIERS_ROOT, { recursive: true });
}

// Tolerant agent for legacy .gov.pk SSL certificates
const sslTolerantAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Downloads a remote file, saves it to data/dossiers/{tenderId}/, and computes SHA-256
 */
export async function downloadAndCacheDossier(
  tenderId: string,
  remoteUrl: string,
  label: string,
  cookieHeader?: string
): Promise<CachedDossier | null> {
  const tenderDir = path.resolve(DOSSIERS_ROOT, tenderId);
  if (!fs.existsSync(tenderDir)) {
    fs.mkdirSync(tenderDir, { recursive: true });
  }

  // Derive a safe filename
  let filename = label.replace(/[^a-zA-Z0-9._-]/g, '_');
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
    if (fs.existsSync(localFilePath)) {
      const existingBuffer = fs.readFileSync(localFilePath);
      const existingHash = crypto.createHash('sha256').update(existingBuffer).digest('hex');
      if (existingHash !== hash) {
        // Corrigendum: file was updated on the server! Save new version alongside old one
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}_v2_${Date.now()}${ext}`;
        finalPath = path.resolve(tenderDir, filename);
      }
    }

    fs.writeFileSync(finalPath, buffer);

    const mimeType = getMimeType(filename);
    const webUrl = `/api/dossiers/${encodeURIComponent(tenderId)}/${encodeURIComponent(filename)}`;

    return {
      label,
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
