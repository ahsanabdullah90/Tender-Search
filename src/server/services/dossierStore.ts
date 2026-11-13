import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DOSSIERS_DIR } from '../db/connection.js';
import {
  enqueuePendingFilePurge,
  getPendingFilePurges,
  deletePendingFilePurge,
  incrementPendingFilePurgeAttempt
} from '../db/repositories/systemRepo.js';
import {
  getAllTenderDossierRows,
  setTenderCachedDossiersRaw
} from '../db/repositories/tendersRepo.js';
import { CachedDossier } from '../../shared/types.js';

export const TRASH_DIR = path.resolve(DOSSIERS_DIR, '.trash');

// Ensure trash directory exists
if (!fs.existsSync(TRASH_DIR)) {
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
  } catch {}
}

export type DocType = 'notice' | 'bidding-document' | 'rfp' | 'boq' | 'tor' | 'drawings' | 'corrigendum' | 'clarification' | 'other';

/**
 * Standard portal file codes mapping
 */
export const PORTAL_FILE_CODES: Record<string, string> = {
  epms_ppra: 'FPPRA',
  epads: 'FPPRA',
  punjab_eproc: 'PPPRA',
  sppra: 'SPPRA',
  kppra: 'KPPRA',
  bppra: 'BPPRA',
  ndma: 'NDMA',
  fde: 'FDE',
  mofept: 'MOFEPT',
  gilgit: 'GB',
  psdf: 'PSDF',
  psda: 'PSDA',
  peef: 'PEEF',
  ungm: 'UNGM',
  giz: 'GIZ',
  tender_services: 'TSP',
  pid: 'PID',
  pseb: 'PSEB',
  ignite: 'IGNITE',
  manual: 'MAN'
};

export function getPortalFileCode(portalId?: string | null): string {
  if (!portalId) return 'GEN';
  const clean = portalId.toLowerCase().trim();
  if (PORTAL_FILE_CODES[clean]) return PORTAL_FILE_CODES[clean];
  return clean.replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase() || 'GEN';
}

/**
 * Determines document type from filename or label
 */
export function inferDocType(labelOrName: string = ''): DocType {
  const lower = labelOrName.toLowerCase();
  if (/(corrigendum|amendment|addendum|errat)/i.test(lower)) return 'corrigendum';
  if (/(boq|bill\s*of\s*quantit|pricing\s*schedule|schedule\s*of\s*requirements)/i.test(lower)) return 'boq';
  if (/\b(rfp|request\s*for\s*proposal)\b/i.test(lower)) return 'rfp';
  if (/\b(tor|terms\s*of\s*reference)\b/i.test(lower)) return 'tor';
  if (/(drawing|map|diagram|spec|layout)/i.test(lower)) return 'drawings';
  if (/(clarification|qa|query|response)/i.test(lower)) return 'clarification';
  if (/(bidding\s*doc|tender\s*doc|rfq|invitation|solicitation)/i.test(lower)) return 'bidding-document';
  if (/(notice|advertisement|banner|clipper|clipping|image)/i.test(lower)) return 'notice';
  return 'other';
}

/**
 * Derives reference slug or fallback title slug
 * - Ref: up to 40 chars
 * - No ref: first 6 words of title (up to 30 chars) + last 4 chars of tender id
 */
export function deriveRefSlug(referenceNo?: string | null, title?: string | null, tenderId?: string | null): string {
  if (referenceNo && referenceNo.trim() && !/^(n\/a|nil|none|no\s*ref)/i.test(referenceNo.trim())) {
    const cleanRef = referenceNo.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (cleanRef) {
      return cleanRef.slice(0, 40);
    }
  }

  // Fallback to title slug + id suffix
  const cleanTitle = (title || 'tender')
    .split(/\s+/)
    .slice(0, 6)
    .join('-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);

  const idSuffix = (tenderId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4) || 'item';
  return `${cleanTitle}-${idSuffix}`;
}

export interface FilenameOptions {
  portalCode?: string;
  referenceNo?: string | null;
  title?: string | null;
  tenderId?: string | null;
  docType?: DocType;
  index?: number;
  buffer: Buffer;
  extension?: string;
}

/**
 * Formats canonical filename per standard:
 * {PORTAL}__{REF}__{type}-{n}__{hash8}.{ext}
 * Total length capped at 100 characters.
 */
export function generateCanonicalFilename(opts: FilenameOptions): { filename: string; sha256: string; hash8: string } {
  const sha256 = crypto.createHash('sha256').update(opts.buffer).digest('hex');
  const hash8 = sha256.slice(0, 8);

  const portal = (opts.portalCode || 'GEN').toUpperCase();
  const refSlug = deriveRefSlug(opts.referenceNo, opts.title, opts.tenderId);
  const type = opts.docType || 'bidding-document';
  const n = opts.index && opts.index > 0 ? opts.index : 1;

  let ext = opts.extension || '.pdf';
  if (!ext.startsWith('.')) ext = `.${ext}`;
  ext = ext.toLowerCase();

  const basePrefix = `${portal}__${refSlug}__${type}-${n}__${hash8}`;
  const maxBaseLen = 100 - ext.length;
  const safeBase = basePrefix.length > maxBaseLen ? basePrefix.slice(0, maxBaseLen) : basePrefix;

  return {
    filename: `${safeBase}${ext}`,
    sha256,
    hash8
  };
}

export function getMimeTypeFromExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc': return 'application/msword';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    case '.zip': return 'application/zip';
    case '.rar': return 'application/x-rar-compressed';
    default: return 'application/octet-stream';
  }
}

/**
 * Atomic and deduplicated document saver for dossiers
 */
export function saveTenderDocument(
  tenderId: string,
  buffer: Buffer,
  meta: {
    portalCode?: string;
    referenceNo?: string | null;
    title?: string | null;
    label?: string;
    originalUrl?: string;
    originalName?: string;
    docType?: DocType;
    index?: number;
    extension?: string;
    source?: 'portal_scrape' | 'manual_upload' | 'pasted_image';
  }
): CachedDossier {
  const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
  if (!fs.existsSync(tenderDir)) {
    fs.mkdirSync(tenderDir, { recursive: true });
  }

  const effectiveDocType = meta.docType || inferDocType(meta.originalName || meta.label || '');
  const ext = meta.extension || (meta.originalName ? path.extname(meta.originalName) : '') || '.pdf';

  const { filename, sha256 } = generateCanonicalFilename({
    portalCode: meta.portalCode,
    referenceNo: meta.referenceNo,
    title: meta.title,
    tenderId,
    docType: effectiveDocType,
    index: meta.index || 1,
    buffer,
    extension: ext
  });

  const finalPath = path.resolve(tenderDir, filename);

  // Write atomically
  const tempPath = path.resolve(tenderDir, `.${filename}.tmp-${Date.now()}`);
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, finalPath);

  const mimeType = getMimeTypeFromExt(filename);
  const webUrl = `/api/dossiers/${encodeURIComponent(tenderId)}/${encodeURIComponent(filename)}`;

  const friendlyLabel = meta.label?.trim() || meta.originalName || `${effectiveDocType.replace(/-/g, ' ')} ${meta.index || 1}`;

  return {
    label: friendlyLabel,
    localPath: webUrl,
    originalUrl: meta.originalUrl || '',
    originalName: meta.originalName || filename,
    mimeType,
    sha256,
    sizeBytes: buffer.length,
    docType: effectiveDocType,
    addedAt: new Date().toISOString(),
    source: meta.source || 'portal_scrape'
  };
}

/**
 * Moves tender folder to .trash with retry queue for Windows/Google Drive file locks
 */
export function purgeTenderFiles(tenderIds: string[]): { purged: string[]; queued: string[] } {
  const purged: string[] = [];
  const queued: string[] = [];

  for (const id of tenderIds) {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) continue;
    const dir = path.resolve(DOSSIERS_DIR, id);
    if (!fs.existsSync(dir)) continue;

    const trashTarget = path.resolve(TRASH_DIR, `${id}_${Date.now()}`);

    try {
      // 1. Move to trash folder (atomic operation on same drive)
      fs.renameSync(dir, trashTarget);

      // 2. Immediate deletion attempt from trash
      try {
        fs.rmSync(trashTarget, { recursive: true, force: true });
        purged.push(id);
      } catch (rmErr: any) {
        // Locked file in trash, enqueue for background purge
        enqueuePendingFilePurge(`purge-${id}-${Date.now()}`, trashTarget, rmErr.message);
        queued.push(id);
      }
    } catch (renameErr: any) {
      // Failed to rename (e.g. process holding active handle)
      enqueuePendingFilePurge(`purge-${id}-${Date.now()}`, dir, renameErr.message);
      queued.push(id);
    }
  }

  return { purged, queued };
}

/**
 * Retries queued file purges from pending_file_purges table
 */
export function retryPendingFilePurges(): number {
  let cleared = 0;
  try {
    const pending = getPendingFilePurges(10);
    for (const item of pending) {
      if (fs.existsSync(item.folder_path)) {
        try {
          fs.rmSync(item.folder_path, { recursive: true, force: true });
          deletePendingFilePurge(item.id);
          cleared++;
        } catch (e: any) {
          incrementPendingFilePurgeAttempt(item.id, e.message);
        }
      } else {
        deletePendingFilePurge(item.id);
        cleared++;
      }
    }
  } catch {}
  return cleared;
}

export interface ReconcileResult {
  orphanFoldersCount: number;
  orphanFolders: { id: string; sizeBytes: number }[];
  missingFilesRemovedFromTenders: number;
  trashCleanedBytes: number;
}

/**
 * Reconciles dossiers on disk with SQLite database
 */
export function reconcileDossiers(options: { dryRun?: boolean; graceMinutes?: number } = {}): ReconcileResult {
  const graceMinutes = options.graceMinutes ?? 60;
  const now = Date.now();
  const graceMs = graceMinutes * 60 * 1000;

  const result: ReconcileResult = {
    orphanFoldersCount: 0,
    orphanFolders: [],
    missingFilesRemovedFromTenders: 0,
    trashCleanedBytes: 0
  };

  if (!fs.existsSync(DOSSIERS_DIR)) return result;

  // 1. Find all active and passed tender IDs in SQLite
  const existingRows = getAllTenderDossierRows();
  const existingIdSet = new Set(existingRows.map(r => r.id));

  // 2. Scan dossiers folder on disk for orphan folders
  const entries = fs.readdirSync(DOSSIERS_DIR);
  for (const entry of entries) {
    if (entry === '.trash' || entry.startsWith('.')) continue;

    const fullPath = path.resolve(DOSSIERS_DIR, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (!existingIdSet.has(entry)) {
          // Check grace period (bypassed if graceMs <= 0)
          if (graceMs <= 0 || now - stat.mtimeMs >= graceMs) {
            let size = 0;
            try {
              const files = fs.readdirSync(fullPath);
              for (const f of files) {
                try { size += fs.statSync(path.resolve(fullPath, f)).size; } catch {}
              }
            } catch {}

            result.orphanFoldersCount++;
            result.orphanFolders.push({ id: entry, sizeBytes: size });

            if (!options.dryRun) {
              purgeTenderFiles([entry]);
            }
          }
        }
      }
    } catch {}
  }

  // 3. Drop cached_dossiers entries pointing to missing files on disk
  if (!options.dryRun) {
    for (const row of existingRows) {
      try {
        const dossiers: CachedDossier[] = JSON.parse(row.cached_dossiers || '[]');
        if (dossiers.length === 0) continue;

        const validDossiers = dossiers.filter(doc => {
          const filename = decodeURIComponent(path.basename(doc.localPath));
          const diskPath = path.resolve(DOSSIERS_DIR, row.id, filename);
          return fs.existsSync(diskPath);
        });

        if (validDossiers.length !== dossiers.length) {
          result.missingFilesRemovedFromTenders += (dossiers.length - validDossiers.length);
          setTenderCachedDossiersRaw(row.id, JSON.stringify(validDossiers));
        }
      } catch {}
    }
  }

  // 4. Age out .trash/ contents older than 24 hours
  if (fs.existsSync(TRASH_DIR)) {
    try {
      const trashItems = fs.readdirSync(TRASH_DIR);
      for (const item of trashItems) {
        const itemPath = path.resolve(TRASH_DIR, item);
        try {
          const stat = fs.statSync(itemPath);
          if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            result.trashCleanedBytes += stat.size || 0;
            if (!options.dryRun) {
              fs.rmSync(itemPath, { recursive: true, force: true });
            }
          }
        } catch {}
      }
    } catch {}
  }

  return result;
}
