import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DOSSIERS_DIR } from '../db/connection.js';
import { PORTAL_DEFINITIONS } from '../scrapers/portalList.js';
import {
  safeDecodeURIComponent,
  isGenericDossierLabel
} from '../../shared/documentUtils.js';
import {
  getMimeTypeFromExt,
  getPathSizeBytes,
  inferDocType,
  purgeTenderDirsOnDisk
} from './fileUtils.js';
import {
  getAppSetting,
  setAppSetting
} from '../db/repositories/systemRepo.js';
import {
  enqueuePendingFilePurge,
  getPendingFilePurges,
  deletePendingFilePurge,
  incrementPendingFilePurgeAttempt,
  getTenderById,
  getAllTenderDossierRows,
  getAllTendersWithDossiers,
  setTenderCachedDossiersRaw
} from '../db/repositories/tendersRepo.js';
import { CachedDossier, DocType, Tender } from '../../shared/types.js';

export type { DocType };
export { getMimeTypeFromExt, inferDocType };

export const TRASH_DIR = path.resolve(DOSSIERS_DIR, '.trash');

// Ensure trash directory exists
if (!fs.existsSync(TRASH_DIR)) {
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
  } catch {}
}

const DOC_TYPE_FILENAME_TOKENS: Record<DocType, string> = {
  'bidding-document': 'Bidding-Document',
  corrigendum: 'Corrigendum',
  notice: 'Tender-Notice',
  rfp: 'RFP',
  boq: 'BOQ',
  tor: 'TOR',
  drawings: 'Drawings',
  clarification: 'Clarification',
  other: 'Document'
};

const DOC_TYPE_DISPLAY_LABELS: Record<DocType, string> = {
  'bidding-document': 'Bidding Document',
  corrigendum: 'Corrigendum',
  notice: 'Tender Notice',
  rfp: 'RFP',
  boq: 'BOQ',
  tor: 'TOR',
  drawings: 'Drawings',
  clarification: 'Clarification',
  other: 'Tender Document'
};

export function formatDocTypeForFilename(docType: DocType): string {
  return DOC_TYPE_FILENAME_TOKENS[docType] || 'Document';
}

export function formatDocTypeDisplayLabel(docType: DocType, index?: number): string {
  const base = DOC_TYPE_DISPLAY_LABELS[docType] || 'Tender Document';
  return typeof index === 'number' && index > 1 ? `${base} ${index}` : base;
}

/**
 * Standard portal file codes mapping derived from PORTAL_DEFINITIONS
 */
export const PORTAL_FILE_CODES: Record<string, string> = {
  ...Object.fromEntries(
    PORTAL_DEFINITIONS
      .filter((p): p is typeof p & { fileCode: string } => Boolean(p.fileCode))
      .map(p => [p.id, p.fileCode])
  ),
  manual: 'MAN'
};

export function getPortalFileCode(portalId?: string | null): string {
  if (!portalId) return 'GEN';
  const clean = portalId.toLowerCase().trim();
  if (PORTAL_FILE_CODES[clean]) return PORTAL_FILE_CODES[clean];
  return clean.replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase() || 'GEN';
}

const GENERIC_TITLE_SLUGS = new Set(['tender', 'tender-notice', 'notice', 'corrigendum', 'document', 'item']);

/**
 * Derives a clean, human-readable reference or title slug trimmed on word boundaries:
 * - Ref: up to 45 chars (capped at maxLen)
 * - No ref: clean word-boundary title slug (up to maxLen), appending id suffix only for generic/empty titles.
 */
export function deriveRefSlug(
  referenceNo?: string | null,
  title?: string | null,
  tenderId?: string | null,
  maxLen: number = 60
): string {
  const limit = Math.max(12, maxLen);
  if (referenceNo && referenceNo.trim() && !/^(n\/a|nil|none|no\s*ref)/i.test(referenceNo.trim())) {
    const cleanRef = referenceNo
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (cleanRef) {
      return cleanRef.slice(0, Math.min(limit, 45)).replace(/-+$/g, '') || cleanRef.slice(0, limit);
    }
  }

  const normalized = (title || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const idSuffix = (tenderId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4) || 'item';
  if (!normalized) {
    return `tender-${idSuffix}`.slice(0, limit);
  }

  let slug = normalized;
  if (slug.length > limit) {
    const cut = slug.slice(0, limit);
    const lastDash = cut.lastIndexOf('-');
    slug = lastDash >= Math.min(12, Math.floor(limit * 0.4)) ? cut.slice(0, lastDash) : cut;
    slug = slug.replace(/-+$/g, '');
  }

  if (GENERIC_TITLE_SLUGS.has(slug.toLowerCase())) {
    const suffix = `-${idSuffix}`;
    const trimmedBase = slug.slice(0, Math.max(4, limit - suffix.length)).replace(/-+$/g, '') || 'tender';
    return `${trimmedBase}${suffix}`;
  }

  return slug || `tender-${idSuffix}`;
}

export interface FilenameOptions {
  portalCode?: string;
  referenceNo?: string | null;
  title?: string | null;
  tenderId?: string | null;
  docType?: DocType;
  index?: number;
  version?: number;
  buffer?: Buffer;
  extension?: string;
}

/**
 * Formats canonical filename per unified rule:
 * {PORTAL}_{Ref_or_Title}_{DocType}-{N}{-vK}.{ext}
 * Total length capped at 100 characters while keeping prefix & suffix intact.
 */
export function generateCanonicalFilename(opts: FilenameOptions): { filename: string; sha256: string; hash8: string } {
  const sha256 = opts.buffer ? crypto.createHash('sha256').update(opts.buffer).digest('hex') : '';
  const hash8 = sha256 ? sha256.slice(0, 8) : '';

  const portal = (opts.portalCode || 'GEN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'GEN';
  const typeToken = formatDocTypeForFilename(opts.docType || 'bidding-document');
  const n = opts.index && opts.index > 0 ? opts.index : 1;
  const versionSuffix = opts.version && opts.version > 1 ? `-v${opts.version}` : '';

  let ext = opts.extension || '.pdf';
  if (!ext.startsWith('.')) ext = `.${ext}`;
  ext = ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.pdf';

  const fixedOverhead = portal.length + 1 + 1 + typeToken.length + 1 + String(n).length + versionSuffix.length + ext.length;
  const availableSlugLen = Math.max(12, 100 - fixedOverhead);
  const refSlug = deriveRefSlug(opts.referenceNo, opts.title, opts.tenderId, availableSlugLen);

  let filename = `${portal}_${refSlug}_${typeToken}-${n}${versionSuffix}${ext}`;
  if (filename.length > 100) {
    const maxSlug = Math.max(8, 100 - fixedOverhead);
    const trimmed = refSlug.slice(0, maxSlug).replace(/-+$/g, '') || 'tender';
    filename = `${portal}_${trimmed}_${typeToken}-${n}${versionSuffix}${ext}`;
  }

  return {
    filename,
    sha256,
    hash8
  };
}

function parseContentDispositionFilename(header?: string): string {
  if (!header) return '';
  const utfMatch = header.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i);
  if (utfMatch?.[1]) {
    return path.basename(safeDecodeURIComponent(utfMatch[1].trim().replace(/^["']|["']$/g, '')));
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
  if (plainMatch?.[1]) {
    return path.basename(safeDecodeURIComponent(plainMatch[1].trim()));
  }
  return '';
}

function fallbackTitleFromLabel(label?: string, originalName?: string): string | null {
  for (const raw of [label, originalName]) {
    if (!raw) continue;
    const cleaned = raw
      .trim()
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/_Doc(?:\s+\d+)?$/i, '')
      .trim();
    if (!cleaned) continue;
    if (/^(bidding document|tender document|tender notice|tender notice image|document|notice|corrigendum)(?:\s+\d+)?$/i.test(cleaned)) {
      continue;
    }
    return cleaned;
  }
  return null;
}

function isGenericOrNoisyLabel(label?: string | null): boolean {
  if (isGenericDossierLabel(label)) return true;
  const trimmed = (label || '').trim();
  return /^(bidding document|tender document|tender notice|tender notice image|document|notice|file|download)(?:\s+\d+)?(?:\s*\(Updated\))?$/i.test(trimmed);
}

function computeFileSha256(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function safeRenameFile(srcPath: string, destPath: string): boolean {
  if (srcPath === destPath) return true;
  if (!fs.existsSync(srcPath)) return false;
  const sameCaseInsensitive = srcPath.toLowerCase() === destPath.toLowerCase();
  if (!sameCaseInsensitive && fs.existsSync(destPath)) {
    return false;
  }
  try {
    if (sameCaseInsensitive) {
      const midPath = `${srcPath}.ren-${process.pid}-${Date.now()}.tmp`;
      fs.renameSync(srcPath, midPath);
      fs.renameSync(midPath, destPath);
    } else {
      fs.renameSync(srcPath, destPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic and deduplicated document saver for dossiers using unified canonical naming:
 * `{PORTAL}_{Ref_or_Title}_{DocType}-{N}.{ext}`
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
    contentDisposition?: string;
    docType?: DocType;
    mimeType?: string;
    index?: number;
    extension?: string;
    existingDossiers?: CachedDossier[];
    source?: 'portal_scrape' | 'manual_upload';
  }
): CachedDossier {
  const tenderDir = path.resolve(DOSSIERS_DIR, tenderId);
  if (!fs.existsSync(tenderDir)) {
    fs.mkdirSync(tenderDir, { recursive: true });
  }

  const needsTenderLookup =
    meta.portalCode === undefined ||
    meta.referenceNo === undefined ||
    meta.title === undefined ||
    meta.existingDossiers === undefined;
  let tender: ReturnType<typeof getTenderById> | undefined;
  if (needsTenderLookup) {
    try {
      tender = getTenderById(tenderId);
    } catch {}
  }

  const portalCode = meta.portalCode || (tender?.portal_id ? getPortalFileCode(tender.portal_id) : 'GEN');
  const referenceNo = meta.referenceNo !== undefined ? meta.referenceNo : tender?.reference_no ?? null;
  const titleForSlug = meta.title || tender?.title || fallbackTitleFromLabel(meta.label, meta.originalName) || tenderId;

  const cdFilename = parseContentDispositionFilename(meta.contentDisposition);
  const originalName = meta.originalName || cdFilename || undefined;
  const combinedHint = [originalName, meta.label, cdFilename].filter(Boolean).join(' ');
  const effectiveDocType = meta.docType || inferDocType(combinedHint, meta.originalUrl);

  const rawExt =
    meta.extension ||
    (originalName ? path.extname(originalName) : '') ||
    (cdFilename ? path.extname(cdFilename) : '') ||
    '.pdf';
  const ext = (rawExt.startsWith('.') ? rawExt : `.${rawExt}`).toLowerCase();

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existingDossiers =
    meta.existingDossiers ??
    (Array.isArray(tender?.cached_dossiers) ? tender.cached_dossiers : []);

  const exactHashMatch = existingDossiers.find(d => d.sha256 === sha256);
  if (exactHashMatch) {
    const existingDiskName = safeDecodeURIComponent(path.basename(exactHashMatch.localPath || ''));
    const existingDiskPath = existingDiskName ? path.resolve(tenderDir, existingDiskName) : '';
    if (existingDiskPath && fs.existsSync(existingDiskPath)) {
      return {
        ...exactHashMatch,
        originalUrl: exactHashMatch.originalUrl || meta.originalUrl || ''
      };
    }
  }

  const startIdx = meta.index && meta.index > 0 ? meta.index : 1;
  let resolvedIdx = startIdx;
  let version: number | undefined;
  let filename = '';
  let alreadyExistsWithSameBytes = false;

  for (let idx = startIdx; idx < startIdx + 50; idx++) {
    const candidate = generateCanonicalFilename({
      portalCode,
      referenceNo,
      title: titleForSlug,
      tenderId,
      docType: effectiveDocType,
      index: idx,
      buffer,
      extension: ext
    }).filename;
    const candidatePath = path.resolve(tenderDir, candidate);

    if (!fs.existsSync(candidatePath)) {
      filename = candidate;
      resolvedIdx = idx;
      break;
    }

    const diskHash = computeFileSha256(candidatePath);
    if (diskHash === sha256) {
      filename = candidate;
      resolvedIdx = idx;
      alreadyExistsWithSameBytes = true;
      break;
    }

    const ownerDossier = existingDossiers.find(
      d => safeDecodeURIComponent(path.basename(d.localPath || '')).toLowerCase() === candidate.toLowerCase()
    );
    const hasTenderContext = Boolean(tender || meta.existingDossiers !== undefined);
    const isSameUrl =
      Boolean(meta.originalUrl) &&
      ((ownerDossier && ownerDossier.originalUrl === meta.originalUrl) || (!ownerDossier && !hasTenderContext));

    if (isSameUrl) {
      for (let v = 2; v <= 20; v++) {
        const versioned = generateCanonicalFilename({
          portalCode,
          referenceNo,
          title: titleForSlug,
          tenderId,
          docType: effectiveDocType,
          index: idx,
          version: v,
          buffer,
          extension: ext
        }).filename;
        const versionedPath = path.resolve(tenderDir, versioned);
        if (!fs.existsSync(versionedPath)) {
          filename = versioned;
          resolvedIdx = idx;
          version = v;
          break;
        }
        if (computeFileSha256(versionedPath) === sha256) {
          filename = versioned;
          resolvedIdx = idx;
          version = v;
          alreadyExistsWithSameBytes = true;
          break;
        }
      }
      if (filename) break;
    }
  }

  if (!filename) {
    filename = generateCanonicalFilename({
      portalCode,
      referenceNo,
      title: titleForSlug,
      tenderId,
      docType: effectiveDocType,
      index: startIdx + Date.now() % 1000,
      buffer,
      extension: ext
    }).filename;
  }

  const finalPath = path.resolve(tenderDir, filename);
  if (!alreadyExistsWithSameBytes) {
    const tempPath = path.resolve(tenderDir, `.${filename}.tmp-${Date.now()}`);
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
  }

  const mimeType = meta.mimeType || getMimeTypeFromExt(filename);
  const webUrl = `/api/dossiers/${encodeURIComponent(tenderId)}/${encodeURIComponent(filename)}`;

  let friendlyLabel = isGenericOrNoisyLabel(meta.label)
    ? formatDocTypeDisplayLabel(effectiveDocType, resolvedIdx)
    : meta.label!.trim();
  if (version && version > 1 && !/\bupdated\b/i.test(friendlyLabel)) {
    friendlyLabel = `${friendlyLabel} (Updated)`;
  }

  return {
    label: friendlyLabel,
    localPath: webUrl,
    originalUrl: meta.originalUrl || '',
    originalName: originalName || filename,
    mimeType,
    sha256,
    sizeBytes: buffer.length,
    docType: effectiveDocType,
    addedAt: new Date().toISOString(),
    source: meta.source || 'portal_scrape'
  };
}

/** True when document-text inspection provides a strictly more specific/important docType. */
export function shouldUpgradeDocType(currentType: DocType | undefined, extractedType: DocType): boolean {
  if (extractedType === 'corrigendum' && currentType !== 'corrigendum') return true;
  if ((!currentType || currentType === 'other') && extractedType !== 'other') return true;
  if (
    currentType === 'notice' &&
    (extractedType === 'boq' ||
      extractedType === 'rfp' ||
      extractedType === 'tor' ||
      extractedType === 'clarification' ||
      extractedType === 'bidding-document')
  ) {
    return true;
  }
  return false;
}

/**
 * Renames an already-saved dossier on disk to match a newly discovered `docType`
 * under `{PORTAL}_{Ref_or_Title}_{DocType}-{N}.{ext}` while avoiding sibling collisions.
 */
export function renameDossierToCanonical(
  tender: { id: string; portal_id?: string | null; reference_no?: string | null; title?: string | null },
  dossier: CachedDossier,
  nextDocType: DocType,
  allDossiers: CachedDossier[]
): { dossier: CachedDossier; renamed: boolean } {
  const tenderDir = path.resolve(DOSSIERS_DIR, tender.id);
  const currentFilename = safeDecodeURIComponent(path.basename(dossier.localPath || ''));
  if (!currentFilename || !fs.existsSync(tenderDir)) {
    return { dossier: { ...dossier, docType: nextDocType }, renamed: false };
  }

  const srcPath = path.resolve(tenderDir, currentFilename);
  if (!srcPath.startsWith(tenderDir + path.sep) || !fs.existsSync(srcPath)) {
    return { dossier: { ...dossier, docType: nextDocType }, renamed: false };
  }

  const portalCode = getPortalFileCode(tender.portal_id);
  const ext = path.extname(currentFilename).toLowerCase() || '.pdf';
  const version = /\bupdated\b/i.test(dossier.label || '') ? 2 : undefined;

  const siblingNames = new Set<string>();
  try {
    for (const f of fs.readdirSync(tenderDir)) {
      if (f.toLowerCase() !== currentFilename.toLowerCase()) siblingNames.add(f.toLowerCase());
    }
  } catch {}
  for (const other of allDossiers) {
    if (other === dossier || other.localPath === dossier.localPath) continue;
    const otherName = safeDecodeURIComponent(path.basename(other.localPath || ''));
    if (otherName && otherName.toLowerCase() !== currentFilename.toLowerCase()) {
      siblingNames.add(otherName.toLowerCase());
    }
  }

  let chosenIdx = 1;
  let targetFilename = currentFilename;
  for (let idx = 1; idx <= 50; idx++) {
    const candidate = generateCanonicalFilename({
      portalCode,
      referenceNo: tender.reference_no ?? null,
      title: tender.title || dossier.label || tender.id,
      tenderId: tender.id,
      docType: nextDocType,
      index: idx,
      version,
      extension: ext
    }).filename;
    if (!siblingNames.has(candidate.toLowerCase())) {
      targetFilename = candidate;
      chosenIdx = idx;
      break;
    }
  }

  const destPath = path.resolve(tenderDir, targetFilename);
  let renamed = false;
  if (currentFilename !== targetFilename) {
    renamed = safeRenameFile(srcPath, destPath);
  }

  const finalFilename = renamed || currentFilename === targetFilename ? targetFilename : currentFilename;
  const nextLabel = isGenericOrNoisyLabel(dossier.label)
    ? `${formatDocTypeDisplayLabel(nextDocType, chosenIdx)}${version ? ' (Updated)' : ''}`
    : dossier.label;

  return {
    renamed,
    dossier: {
      ...dossier,
      docType: nextDocType,
      label: nextLabel,
      localPath: `/api/dossiers/${encodeURIComponent(tender.id)}/${encodeURIComponent(finalFilename)}`
    }
  };
}

export function upgradeDossierDocTypeIfNeeded(
  tender: Pick<Tender, 'id' | 'portal_id' | 'reference_no' | 'title'>,
  doc: CachedDossier,
  extractedDocType: DocType | undefined,
  dossiers: CachedDossier[]
): { upgraded: boolean; dossiers: CachedDossier[]; index: number } {
  const index = dossiers.findIndex(
    d => d === doc || d.localPath === doc.localPath || (Boolean(doc.sha256) && d.sha256 === doc.sha256)
  );
  if (!extractedDocType || !shouldUpgradeDocType(doc.docType as DocType | undefined, extractedDocType) || index < 0) {
    return { upgraded: false, dossiers, index };
  }
  const updated = [...dossiers];
  const renamed = renameDossierToCanonical(tender, updated[index], extractedDocType, updated);
  updated[index] = renamed.dossier;
  return { upgraded: true, dossiers: updated, index };
}

/**
 * Idempotently migrates existing cached dossier filenames on disk (e.g. legacy `*_Doc.pdf` or
 * `PORTAL__REF__type-1__hash8.pdf`) to the unified `{PORTAL}_{Slug}_{DocType}-{N}.{ext}` rule.
 */
export function migrateDossierFilenames(): { tendersUpdated: number; filesRenamed: number } {
  let tendersUpdated = 0;
  let filesRenamed = 0;
  if (!fs.existsSync(DOSSIERS_DIR)) return { tendersUpdated, filesRenamed };

  const rows = getAllTendersWithDossiers();
  for (const row of rows) {
    let dossiers: CachedDossier[];
    try {
      dossiers = JSON.parse(row.cached_dossiers || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(dossiers) || dossiers.length === 0) continue;

    const tenderDir = path.resolve(DOSSIERS_DIR, row.id);
    if (!fs.existsSync(tenderDir)) continue;

    const portalCode = getPortalFileCode(row.portal_id);
    const usedNames = new Set<string>();
    const currentNames = dossiers.map(d => safeDecodeURIComponent(path.basename(d.localPath || '')));
    // Seed usedNames with non-dossier files present in tenderDir so we never clobber them
    try {
      const currentSet = new Set(currentNames.map(n => n.toLowerCase()));
      for (const diskFile of fs.readdirSync(tenderDir)) {
        if (!currentSet.has(diskFile.toLowerCase())) {
          usedNames.add(diskFile.toLowerCase());
        }
      }
    } catch {}

    let rowChanged = false;
    const updatedDossiers: CachedDossier[] = dossiers.map(doc => {
      const srcFilename = safeDecodeURIComponent(path.basename(doc.localPath || ''));
      if (!srcFilename) return doc;
      const srcPath = path.resolve(tenderDir, srcFilename);
      if (!srcPath.startsWith(tenderDir + path.sep) || !fs.existsSync(srcPath)) {
        return doc;
      }

      const inferred = inferDocType(`${doc.originalName || ''} ${doc.label || ''}`, doc.originalUrl);
      const docType: DocType =
        doc.docType && doc.docType !== 'other'
          ? (inferred === 'corrigendum' ? 'corrigendum' : (doc.docType as DocType))
          : inferred;
      const ext = path.extname(srcFilename).toLowerCase() || '.pdf';
      const version = /\bupdated\b/i.test(doc.label || '') ? 2 : undefined;

      let chosenIdx = 1;
      let targetFilename = srcFilename;
      for (let idx = 1; idx <= 50; idx++) {
        const candidate = generateCanonicalFilename({
          portalCode,
          referenceNo: row.reference_no,
          title: row.title,
          tenderId: row.id,
          docType,
          index: idx,
          version,
          extension: ext
        }).filename;

        if (!usedNames.has(candidate.toLowerCase())) {
          const destPath = path.resolve(tenderDir, candidate);
          const blockedByOtherDiskFile =
            candidate.toLowerCase() !== srcFilename.toLowerCase() && fs.existsSync(destPath);
          if (!blockedByOtherDiskFile) {
            targetFilename = candidate;
            chosenIdx = idx;
            break;
          }
        }
      }

      usedNames.add(targetFilename.toLowerCase());

      let nextFilename = srcFilename;
      if (srcFilename !== targetFilename) {
        const destPath = path.resolve(tenderDir, targetFilename);
        if (safeRenameFile(srcPath, destPath)) {
          nextFilename = targetFilename;
          filesRenamed++;
          rowChanged = true;
        }
      }

      const nextLocalPath = `/api/dossiers/${encodeURIComponent(row.id)}/${encodeURIComponent(nextFilename)}`;
      const nextLabel = isGenericOrNoisyLabel(doc.label)
        ? `${formatDocTypeDisplayLabel(docType, chosenIdx)}${version ? ' (Updated)' : ''}`
        : doc.label;

      if (doc.localPath !== nextLocalPath || doc.label !== nextLabel || doc.docType !== docType) {
        rowChanged = true;
      }

      return {
        ...doc,
        localPath: nextLocalPath,
        label: nextLabel,
        docType
      };
    });

    if (rowChanged) {
      setTenderCachedDossiersRaw(row.id, JSON.stringify(updatedDossiers));
      tendersUpdated++;
    }
  }

  return { tendersUpdated, filesRenamed };
}

/**
 * One-time local PDF/DOCX text-based docType upgrade for existing cached dossiers whose
 * type was unknown or guessed from URL (`other` / `notice`), renaming upgraded files cleanly.
 */
export async function reclassifyExistingDossiersFromText(options?: { force?: boolean }): Promise<{ filesReclassified: number }> {
  if (!options?.force && getAppSetting('dossier_text_classify_v1') === 'done') {
    return { filesReclassified: 0 };
  }

  const { extractDocumentText, inferDocTypeFromText } = await import('./documentExtractor.js');
  const rows = getAllTendersWithDossiers();
  let filesReclassified = 0;

  for (const row of rows) {
    let dossiers: CachedDossier[];
    try {
      dossiers = JSON.parse(row.cached_dossiers || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(dossiers) || dossiers.length === 0) continue;

    const tenderDir = path.resolve(DOSSIERS_DIR, row.id);
    if (!fs.existsSync(tenderDir)) continue;

    let rowChanged = false;
    const updatedList = [...dossiers];
    for (let i = 0; i < updatedList.length; i++) {
      const doc = updatedList[i];
      if (doc.docType && doc.docType !== 'other' && doc.docType !== 'notice') continue;
      if (
        doc.mimeType !== 'application/pdf' &&
        doc.mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
        !/\.(pdf|docx)$/i.test(doc.localPath || '')
      ) {
        continue;
      }

      const filename = safeDecodeURIComponent(path.basename(doc.localPath || ''));
      const diskPath = path.resolve(tenderDir, filename);
      if (!diskPath.startsWith(tenderDir + path.sep) || !fs.existsSync(diskPath)) continue;

      try {
        const buf = fs.readFileSync(diskPath);
        const extracted = await extractDocumentText(buf, doc.mimeType || getMimeTypeFromExt(filename));
        if (!extracted.text || extracted.text.trim().length < 40) continue;

        const nextType = inferDocTypeFromText(extracted.text, (doc.docType as DocType) || 'other');
        if (!shouldUpgradeDocType(doc.docType as DocType | undefined, nextType)) continue;

        const { dossier: renamedDoc, renamed } = renameDossierToCanonical(row, doc, nextType, updatedList);
        updatedList[i] = renamedDoc;
        rowChanged = true;
        if (renamed || renamedDoc.docType !== doc.docType) {
          filesReclassified++;
        }
      } catch {}
    }

    if (rowChanged) {
      setTenderCachedDossiersRaw(row.id, JSON.stringify(updatedList));
    }
  }

  setAppSetting('dossier_text_classify_v1', 'done');
  return { filesReclassified };
}

/** Reads a cached dossier's bytes from disk, or null if it is missing. */
export function readCachedDossier(tenderId: string, dossier: CachedDossier): Buffer | null {
  const filename = safeDecodeURIComponent(path.basename(dossier.localPath || ''));
  if (!filename) return null;
  const diskPath = path.resolve(DOSSIERS_DIR, tenderId, filename);
  if (!diskPath.startsWith(path.resolve(DOSSIERS_DIR) + path.sep) || !fs.existsSync(diskPath)) return null;
  return fs.readFileSync(diskPath);
}

/**
 * Moves tender folder to .trash with retry queue for Windows/Google Drive file locks
 */
export function purgeTenderFiles(tenderIds: string[]): { purged: string[]; queued: string[] } {
  return purgeTenderDirsOnDisk(
    DOSSIERS_DIR,
    TRASH_DIR,
    tenderIds,
    (id, folderPath, message) => enqueuePendingFilePurge(`purge-${id}-${Date.now()}`, folderPath, message)
  );
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
            const size = getPathSizeBytes(fullPath);

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
          const filename = safeDecodeURIComponent(path.basename(doc.localPath));
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
            result.trashCleanedBytes += getPathSizeBytes(itemPath);
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
