import fs from 'fs';
import path from 'path';
import type { DocType } from '../../shared/types.js';
import { isCorrigendumLabel, safeDecodeURIComponent } from '../../shared/documentUtils.js';

export function getPathSizeBytes(targetPath: string): number {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const st = fs.statSync(targetPath);
    if (!st.isDirectory()) return st.size || 0;
    let total = 0;
    for (const child of fs.readdirSync(targetPath)) {
      total += getPathSizeBytes(path.resolve(targetPath, child));
    }
    return total;
  } catch {
    return 0;
  }
}

export function getMimeTypeFromExt(filenameOrExt: string): string {
  const clean = (filenameOrExt || '').trim();
  const ext = (
    clean.startsWith('.') && !clean.includes('/') && !clean.includes('\\')
      ? clean
      : path.extname(clean)
  ).toLowerCase();

  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc': return 'application/msword';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    case '.zip': return 'application/zip';
    case '.rar': return 'application/x-rar-compressed';
    default: return 'application/octet-stream';
  }
}

export function hasValidImageMagicBytes(buf: Buffer): boolean {
  if (!buf || buf.length < 12) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // TIFF: II* / MM*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return true;
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

export function detectExtensionAndMime(
  buffer: Buffer,
  contentTypeHeader?: string,
  urlOrFilename?: string
): { ext: string; mimeType: string } {
  // 1. Magic bytes (highest authority)
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { ext: '.pdf', mimeType: 'application/pdf' };
  }
  if (buffer.length >= 12) {
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return { ext: '.webp', mimeType: 'image/webp' };
    }
  }
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { ext: '.png', mimeType: 'image/png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { ext: '.jpg', mimeType: 'image/jpeg' };
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return { ext: '.gif', mimeType: 'image/gif' };
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
      case 'image/webp': return { ext: '.webp', mimeType: 'image/webp' };
      case 'image/gif': return { ext: '.gif', mimeType: 'image/gif' };
      case 'application/msword': return { ext: '.doc', mimeType: 'application/msword' };
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return { ext: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      case 'application/vnd.ms-excel': return { ext: '.xls', mimeType: 'application/vnd.ms-excel' };
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return { ext: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      case 'application/zip': return { ext: '.zip', mimeType: 'application/zip' };
    }
  }

  // 3. Remote URL or filename extension
  if (urlOrFilename) {
    let targetPath = urlOrFilename.trim();
    try {
      if (/^https?:\/\//i.test(targetPath)) {
        targetPath = new URL(targetPath).pathname;
      }
    } catch {}
    const fileExt = path.extname(targetPath.split('?')[0]).toLowerCase();
    if (fileExt && /^\.[a-z0-9]{2,5}$/.test(fileExt)) {
      return { ext: fileExt, mimeType: getMimeTypeFromExt(fileExt) };
    }
  }

  return { ext: '.pdf', mimeType: 'application/pdf' };
}

export function isPdfBuffer(buf: Buffer, mimeType?: string): boolean {
  return mimeType === 'application/pdf' || (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-');
}

export function isDocxBuffer(buf: Buffer, mimeType?: string): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b && /word|docx/i.test(mimeType || ''))
  );
}

function extractUrlClues(remoteUrl?: string | null): string {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return '';
  const parts: string[] = [];
  try {
    const parsed = new URL(remoteUrl);
    parts.push(safeDecodeURIComponent(parsed.pathname));
    parts.push(safeDecodeURIComponent(parsed.search));

    const fileParam = parsed.searchParams.get('file');
    if (fileParam && /^[A-Za-z0-9+/=]{8,}$/.test(fileParam)) {
      try {
        const decoded = Buffer.from(fileParam, 'base64').toString('utf8').trim();
        if (/^[\w./-\s]+$/.test(decoded)) parts.push(decoded);
      } catch {}
    }

    const baseName = path.basename(parsed.pathname);
    const metaMatch = baseName.match(/-meta([A-Za-z0-9+/=]+)-/i);
    if (metaMatch?.[1]) {
      try {
        const decoded = Buffer.from(metaMatch[1], 'base64').toString('utf8').trim();
        if (decoded) parts.push(decoded);
      } catch {}
    }
  } catch {
    parts.push(safeDecodeURIComponent(remoteUrl));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Determines document type from filename, label, and optional remote URL path/query.
 */
export function inferDocType(labelOrName: string = '', remoteUrl?: string | null): DocType {
  const combined = `${labelOrName || ''} ${extractUrlClues(remoteUrl)}`.toLowerCase();
  if (isCorrigendumLabel(combined)) return 'corrigendum';
  if (/(?:^|[^a-z0-9])boq(?:[^a-z0-9]|$)|\/boqmanual\/|bill[\s_-]*of[\s_-]*quantit|pricing[\s_-]*schedule|schedule[\s_-]*of[\s_-]*requirement/i.test(combined)) return 'boq';
  if (/(?:^|[^a-z0-9])rfp(?:[^a-z0-9]|$)|request[\s_-]*for[\s_-]*proposal/i.test(combined)) return 'rfp';
  if (/(?:^|[^a-z0-9])tor(?:[^a-z0-9]|$)|terms[\s_-]*of[\s_-]*reference/i.test(combined)) return 'tor';
  if (/(drawing|blueprint|diagram|(?:^|[^a-z0-9])map(?:[^a-z0-9]|$)|layout)/i.test(combined)) return 'drawings';
  if (/(?:^|[^a-z0-9])(?:qa|q\s*&\s*a)(?:[^a-z0-9]|$)|clarification|pre[-\s]?bid[\s_-]*minutes|\bquery\b/i.test(combined)) return 'clarification';
  if (/bidding[\s_-]*doc|\/biddingdocuments\/|standard[\s_-]*bidding|tender[\s_-]*doc|(?:^|[^a-z0-9])rfq(?:[^a-z0-9]|$)|solicitation/i.test(combined)) {
    return 'bidding-document';
  }
  if (/notice|advertisement|\/advertisement_docs\/|\/tenders\/|(?:^|[^a-z0-9])(?:nit|ifb|eoi)(?:[^a-z0-9]|$)|invitation|banner|clipp(?:er|ing)|image/i.test(combined)) {
    return 'notice';
  }
  return 'other';
}

/**
 * Moves tender folders to .trash and deletes them, calling `onPurgeFailure` when a Windows/Drive file lock holds a handle.
 */
export function purgeTenderDirsOnDisk(
  dossiersDir: string,
  trashDir: string,
  tenderIds: string[],
  onPurgeFailure?: (id: string, folderPath: string, errorMessage: string) => void
): { purged: string[]; queued: string[] } {
  const purged: string[] = [];
  const queued: string[] = [];

  if (!fs.existsSync(trashDir)) {
    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {}
  }

  for (const id of tenderIds) {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) continue;
    const dir = path.resolve(dossiersDir, id);
    if (!fs.existsSync(dir)) continue;

    const trashTarget = path.resolve(trashDir, `${id}_${Date.now()}`);

    try {
      fs.renameSync(dir, trashTarget);

      try {
        fs.rmSync(trashTarget, { recursive: true, force: true });
        purged.push(id);
      } catch (rmErr: any) {
        onPurgeFailure?.(id, trashTarget, rmErr?.message || String(rmErr));
        queued.push(id);
      }
    } catch (renameErr: any) {
      onPurgeFailure?.(id, dir, renameErr?.message || String(renameErr));
      queued.push(id);
    }
  }

  return { purged, queued };
}
