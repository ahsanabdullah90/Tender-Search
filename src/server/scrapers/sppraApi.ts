import { RawScrapedItem, ScrapeResult } from './portalParsers.js';
import { PortalDefinition } from './portalList.js';
import { parseDateString, formatClosingDate } from './dateParser.js';
import { maxFileBytes } from '../services/ingestBudget.js';
import { reportNetworkOutcome, PASSIVE_SLOW_DOC_MS } from '../services/networkMonitor.js';
import { createSslTolerantDispatcher } from './baseScraper.js';
import {
  CLOSED_STATUS_RE,
  resolvePaginationMaxPages,
  shouldEarlyStopKnownPage,
  KnownTenderStopEntry
} from './scraperUtils.js';

export const SPPRA_API_BASE = 'https://apiprd.eprocure.gov.pk';
export const SPPRA_LIST_URL = `${SPPRA_API_BASE}/websiteportal/publicportal/1.0.0/api/v1/publicportal/getallpublictenders`;
export const SPPRA_DOCS_URL = `${SPPRA_API_BASE}/websiteportal/publicportal/1.0.0/api/v1/publicportal/getallpublisheddocumentdetailbypdid`;
export const SPPRA_DOWNLOAD_URL = `${SPPRA_API_BASE}/documentmanagementsystem/dmspublicapi/1.0.0/api/v1/dmspublicapi/downloadportalfilebyguid`;
export const SPPRA_PORTAL_ORIGIN = 'https://portalsindh.eprocure.gov.pk';
export const SPPRA_OFFICE_ID = 31640;
export const SPPRA_DEFAULT_PAGE_SIZE = 50;
export const SPPRA_MAX_ATTEMPTS = 6;
export const SPPRA_RETRY_DELAYS_MS = [100, 200, 400, 800, 1200] as const;

let sppraDispatcher = createSslTolerantDispatcher();

/**
 * Returns the active Undici dispatcher pool used by SPPRA API requests.
 */
export function getSppraDispatcher() {
  return sppraDispatcher;
}

function rotateSppraDispatcher(failedDispatcher: typeof sppraDispatcher): void {
  if (sppraDispatcher !== failedDispatcher) return;
  sppraDispatcher = createSslTolerantDispatcher();
  void failedDispatcher.close().catch(() => {});
}

export interface SppraRetryOptions {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
}

function isRetryableSppraStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleepWithAbort(ms: number, signal?: AbortSignal, abortMessage: string = 'Request aborted'): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error(abortMessage));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(abortMessage));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchSppraJson<T = any>(
  url: string,
  payload: Record<string, unknown>,
  formatHttpError: (status: number) => string,
  opts?: SppraRetryOptions & { timeoutMs?: number; signal?: AbortSignal; abortMessage?: string }
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? SPPRA_MAX_ATTEMPTS);
  const retryDelays = opts?.retryDelaysMs ?? SPPRA_RETRY_DELAYS_MS;
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const abortMessage = opts?.abortMessage ?? 'Request aborted';

  if (opts?.signal?.aborted) {
    throw new Error(abortMessage);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new Error(abortMessage);
    }

    const attemptDispatcher = sppraDispatcher;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (opts?.signal) {
      opts.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: SPPRA_PUBLIC_HEADERS,
        signal: controller.signal,
        dispatcher: attemptDispatcher,
        body: JSON.stringify(payload)
      } as any);

      if (!res.ok) {
        // Drain error body so Undici recycles/closes the socket cleanly on transient WSO2 500s.
        if (typeof (res as any).text === 'function') {
          await (res as any).text().catch(() => '');
        }
        const err: any = new Error(formatHttpError(res.status));
        err.statusCode = res.status;
        lastError = err;

        if (!isRetryableSppraStatus(res.status) || attempt >= maxAttempts || opts?.signal?.aborted) {
          throw err;
        }
      } else {
        return (await res.json()) as T;
      }
    } catch (err: any) {
      if (opts?.signal?.aborted) {
        throw new Error(abortMessage);
      }
      if (typeof err?.statusCode === 'number' && !isRetryableSppraStatus(err.statusCode)) {
        throw err;
      }
      lastError = err;
      if (attempt >= maxAttempts) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onParentAbort);
      }
    }

    rotateSppraDispatcher(attemptDispatcher);
    const delayIdx = Math.min(attempt - 1, Math.max(0, retryDelays.length - 1));
    const delayMs = retryDelays.length > 0 ? retryDelays[delayIdx] : 0;
    await sleepWithAbort(delayMs, opts?.signal, abortMessage);
  }

  throw lastError;
}

export const SPPRA_PUBLIC_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  authorization: 'Basic YWRtaW46cHByYTEy',
  'content-type': 'application/json',
  officedetail: 'Sindh-PPRA-Dev',
  origin: SPPRA_PORTAL_ORIGIN,
  referer: `${SPPRA_PORTAL_ORIGIN}/`
};

export interface SppraTenderRecord {
  publishedDocumentID?: number;
  tR_DocumentTemplateID?: number;
  procurementPlansDetailID?: number;
  name?: string | null;
  description?: string | null;
  documentId?: number | null;
  documentGUID?: string | null;
  ppraTenderNumber?: string | null;
  tenderNumber?: string | null;
  tenderNumbers?: string | null;
  publishDate?: string | null;
  lastSubmissionDate?: string | null;
  bidOpeningDate?: string | null;
  bidValidityDate?: string | null;
  departmentName?: string | null;
  statusName?: string | null;
  location?: string | null;
  procurementCategory?: string | null;
  estimatedCost?: string | number | null;
  procurementMethod?: string | null;
  procurementProcedure?: string | null;
}

export interface SppraPublishedDocRecord {
  dmS_FileID?: number | null;
  dmS_FileGUID?: string | null;
  documentTemplateName?: string | null;
  displayName?: string | null;
  isCorrigendum?: number | boolean | null;
}

export interface SppraDownloadFileParams {
  fileId: number;
  guid: string;
  label?: string;
}

/**
 * Builds a synthetic HTTPS URL representing a Sindh SPPRA DMS file downloadable via
 * `downloadportalfilebyguid` POST API.
 */
export function buildSppraDownloadUrl(fileId: number, guid: string, label?: string): string {
  const url = new URL(SPPRA_DOWNLOAD_URL);
  url.searchParams.set('id', String(fileId));
  url.searchParams.set('guid', guid.trim());
  if (label && label.trim()) {
    url.searchParams.set('name', label.trim());
  }
  return url.toString();
}

/**
 * Parses a synthetic Sindh SPPRA DMS download URL back into `{ fileId, guid, label }`.
 */
export function parseSppraDownloadUrl(rawUrl: string): SppraDownloadFileParams | null {
  if (!rawUrl || !rawUrl.includes('downloadportalfilebyguid')) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.endsWith('eprocure.gov.pk')) return null;
    if (!parsed.pathname.toLowerCase().includes('downloadportalfilebyguid')) return null;
    const idStr = parsed.searchParams.get('id');
    const guid = parsed.searchParams.get('guid')?.trim();
    const label = parsed.searchParams.get('name')?.trim() || undefined;
    const fileId = idStr ? Number(idStr) : NaN;
    if (!Number.isFinite(fileId) || fileId <= 0 || !guid) return null;
    return { fileId, guid, label };
  } catch {
    return null;
  }
}

export function isSppraDownloadUrl(rawUrl: string): boolean {
  return parseSppraDownloadUrl(rawUrl) !== null;
}

/**
 * Extracts `publishedDocumentID` from a SPPRA tender `direct_url` (`.../#/?tender=...&pdid=717150`).
 */
export function extractSppraPublishedDocId(directUrl?: string | null): number | null {
  if (!directUrl) return null;
  const match = directUrl.match(/[?&]pdid=(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseSppraIsoDate(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (!s || s.startsWith('0001-01-01')) return undefined;
  // SPPRA returns local Pakistan Standard Time (UTC+05:00) timestamps without timezone suffix
  return parseDateString(s) ?? undefined;
}

function formatEstimatedCostPkr(raw?: string | number | null): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const num = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(num) || num <= 0) return undefined;
  if (num >= 1_000_000) {
    const m = (num / 1_000_000).toFixed(2).replace(/\.00$/, '');
    return `PKR ${m}M (${num.toLocaleString('en-US')})`;
  }
  return `PKR ${num.toLocaleString('en-US')}`;
}

/**
 * Maps a single raw SPPRA EPADS JSON record into a normalized `ScrapedTender`.
 * Returns `null` for non-open (closed/cancelled/completed) or malformed records.
 */
export function mapSppraRecordToScrapedTender(record: SppraTenderRecord): RawScrapedItem | null {
  const title = (record.name || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return null;

  const statusName = (record.statusName || '').trim();
  if (statusName && CLOSED_STATUS_RE.test(statusName)) {
    return null;
  }

  const referenceNo = (record.tenderNumbers || record.tenderNumber || record.ppraTenderNumber || '').trim() || undefined;
  const organization = (record.departmentName || '').replace(/\s+/g, ' ').trim() || 'Sindh Public Procurement Regulatory Authority';

  const rawLocation = (record.location || '').replace(/\s+/g, ' ').trim();
  const location = rawLocation
    ? (/sindh/i.test(rawLocation) ? rawLocation : `${rawLocation}, Sindh`)
    : 'Sindh, Pakistan';

  const publishDate = parseSppraIsoDate(record.publishDate);
  const closingDate = parseSppraIsoDate(record.lastSubmissionDate);

  const pdid = Number(record.publishedDocumentID);
  const queryParts: string[] = [];
  if (referenceNo) queryParts.push(`tender=${encodeURIComponent(referenceNo)}`);
  if (Number.isFinite(pdid) && pdid > 0) queryParts.push(`pdid=${pdid}`);
  const directUrl = queryParts.length > 0
    ? `${SPPRA_PORTAL_ORIGIN}/#/?${queryParts.join('&')}`
    : `${SPPRA_PORTAL_ORIGIN}/#/`;

  const attachmentUrls: string[] = [];
  if (record.documentId && Number(record.documentId) > 0 && record.documentGUID && String(record.documentGUID).trim()) {
    attachmentUrls.push(
      buildSppraDownloadUrl(Number(record.documentId), String(record.documentGUID).trim(), 'Tender Notice')
    );
  }

  const descParts: string[] = [];
  if (record.description && record.description.trim()) {
    descParts.push(record.description.trim());
  } else {
    descParts.push(title);
  }
  const metaParts: string[] = [];
  if (referenceNo) metaParts.push(`Ref: ${referenceNo}`);
  if (organization) metaParts.push(`Department: ${organization}`);
  if (rawLocation) metaParts.push(`Location: ${location}`);
  const costLabel = formatEstimatedCostPkr(record.estimatedCost);
  if (costLabel) metaParts.push(`Estimated Cost: ${costLabel}`);
  if (closingDate) metaParts.push(`Closing: ${formatClosingDate(closingDate) || closingDate}`);
  if (record.procurementMethod) metaParts.push(`Method: ${record.procurementMethod}`);
  if (record.procurementProcedure) metaParts.push(`Procedure: ${record.procurementProcedure}`);

  const description = metaParts.length > 0
    ? `${descParts.join(' — ')} | ${metaParts.join(' • ')}`
    : descParts.join(' — ');

  return {
    title,
    organization,
    referenceNo,
    publishDate,
    closingDate,
    location,
    directUrl,
    description,
    attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined
  };
}

/**
 * Fetches one page of active public tenders from the Sindh SPPRA EPADS JSON API.
 */
export async function fetchSppraTendersPage(
  pageNumber: number = 1,
  pageSize: number = SPPRA_DEFAULT_PAGE_SIZE,
  timeoutMs: number = 20000,
  retryOptions?: SppraRetryOptions
): Promise<{ totalRecords: number; records: SppraTenderRecord[] }> {
  const json = await fetchSppraJson(
    SPPRA_LIST_URL,
    {
      pagination: {
        pageNumber: String(pageNumber),
        pageSize: String(pageSize),
        orderBy: '',
        orderByColumnName: '',
        approvalStatusID: 0,
        refTypeID: 0
      },
      filter: {
        sortOrder: '',
        activityStatus: null,
        keywords: '',
        tenderNo: '',
        departmentName: null,
        dateOfAdvertisement: null,
        closingDate: null,
        selectedWorth: null
      },
      loggedInUserID: 1,
      loggedInUserOfficeID: SPPRA_OFFICE_ID
    },
    (status) => `SPPRA API HTTP ${status} on page ${pageNumber}`,
    {
      timeoutMs,
      maxAttempts: retryOptions?.maxAttempts,
      retryDelaysMs: retryOptions?.retryDelaysMs
    }
  );
  const records: SppraTenderRecord[] = Array.isArray(json?.data?.records) ? json.data.records : [];
  const totalRecords = Number(json?.data?.totalRecords ?? records.length) || records.length;
  return { totalRecords, records };
}

/**
 * Scrapes Sindh SPPRA via its official public EPADS JSON API with quick/deep pagination
 * and DB early-stop when page >= 2 repeats already-known unchanged notices.
 */
export async function scrapeSppraPortal(
  portal: PortalDefinition,
  options?: {
    depth?: 'quick' | 'deep';
    knownMap?: Map<string, KnownTenderStopEntry> | null;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelaysMs?: readonly number[];
  }
): Promise<ScrapeResult> {
  const depth = options?.depth === 'deep' ? 'deep' : 'quick';
  const maxPages = resolvePaginationMaxPages(portal, depth, 2);

  const allItems: RawScrapedItem[] = [];
  const seenKeys = new Set<string>();
  let pagesScanned = 0;

  for (let page = 1; page <= maxPages; page++) {
    let records: SppraTenderRecord[];
    try {
      const pageData = await fetchSppraTendersPage(page, SPPRA_DEFAULT_PAGE_SIZE, options?.timeoutMs ?? 20000, {
        maxAttempts: options?.maxAttempts,
        retryDelaysMs: options?.retryDelaysMs
      });
      records = pageData.records;
    } catch (err: any) {
      if (pagesScanned > 0) {
        console.warn(`[SPPRA] Stopping pagination on page ${page} after collecting ${allItems.length} item(s): ${err?.message || err}`);
        break;
      }
      throw err;
    }
    pagesScanned++;
    if (records.length === 0) break;

    const pageItems: RawScrapedItem[] = [];

    for (const rec of records) {
      const mapped = mapSppraRecordToScrapedTender(rec);
      if (!mapped) continue;
      const key = (mapped.referenceNo || mapped.directUrl || mapped.title).toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      allItems.push(mapped);
      pageItems.push(mapped);
    }

    if (pageItems.length === 0) break;
    if (page >= 2 && shouldEarlyStopKnownPage(pageItems, options?.knownMap)) {
      break;
    }
    if (records.length < SPPRA_DEFAULT_PAGE_SIZE) break;
  }

  return {
    items: allItems,
    hitlRequired: false,
    pagesScanned
  };
}

/**
 * Fetches PA Published Documents (Standard Bidding Document, Corrigenda, BOQ, etc.)
 * for a Sindh SPPRA tender by its `publishedDocumentID`.
 */
export async function fetchSppraPublishedDocuments(
  publishedDocumentId: number,
  timeoutMs: number = 15000,
  retryOptions?: SppraRetryOptions
): Promise<string[]> {
  if (!Number.isFinite(publishedDocumentId) || publishedDocumentId <= 0) return [];
  const json = await fetchSppraJson(
    SPPRA_DOCS_URL,
    {
      Id: publishedDocumentId,
      loggedInUserID: 1,
      loggedInUserOfficeID: 1
    },
    (status) => `SPPRA published docs HTTP ${status} for pdid=${publishedDocumentId}`,
    {
      timeoutMs,
      maxAttempts: retryOptions?.maxAttempts,
      retryDelaysMs: retryOptions?.retryDelaysMs
    }
  );
  const list: SppraPublishedDocRecord[] = Array.isArray(json?.data) ? json.data : [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const fileId = Number(item.dmS_FileID);
    const guid = (item.dmS_FileGUID || '').trim();
    if (!Number.isFinite(fileId) || fileId <= 0 || !guid) continue;
    const isCorr = item.isCorrigendum === 1 || item.isCorrigendum === true;
    const rawLabel = (item.displayName || item.documentTemplateName || '').trim();
    const label = isCorr
      ? (rawLabel && /corrigendum/i.test(rawLabel) ? rawLabel : 'Corrigendum')
      : (rawLabel || 'Standard Bidding Document');
    const u = buildSppraDownloadUrl(fileId, guid, label);
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

/**
 * Downloads a Sindh SPPRA DMS file via `downloadportalfilebyguid` POST API, decodes its
 * base64 payload into a raw `Buffer`, and attaches `contentType` and `contentDisposition`
 * metadata compatible with `dossierManager` and `tenderAnalysis`.
 */
export async function downloadSppraFileBuffer(
  rawUrl: string,
  options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelaysMs?: readonly number[];
  }
): Promise<Buffer> {
  const params = parseSppraDownloadUrl(rawUrl);
  if (!params) {
    throw new Error(`Invalid SPPRA download URL: ${rawUrl}`);
  }
  if (options?.signal?.aborted) {
    throw new Error('File download aborted');
  }

  const timeoutMs = options?.timeoutMs ?? 45000;
  const limitBytes = options?.maxBytes ?? maxFileBytes();
  const startedAt = Date.now();

  const json = await fetchSppraJson(
    SPPRA_DOWNLOAD_URL,
    {
      loggedInUserOfficeID: SPPRA_OFFICE_ID,
      loggedInUserID: 1,
      ID: params.fileId,
      idsList: params.guid
    },
    (status) => `SPPRA file download HTTP ${status}`,
    {
      timeoutMs,
      signal: options?.signal,
      maxAttempts: options?.maxAttempts,
      retryDelaysMs: options?.retryDelaysMs,
      abortMessage: 'File download aborted'
    }
  );

  const base64Bytes = json?.data?.bytes;
  if (typeof base64Bytes !== 'string' || base64Bytes.length < 16) {
    throw new Error(`SPPRA DMS returned empty file payload for file ID ${params.fileId}`);
  }

  const buf = Buffer.from(base64Bytes, 'base64');
  if (buf.length > limitBytes) {
    throw new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  reportNetworkOutcome('apiprd.eprocure.gov.pk', true, {
    durationMs: Date.now() - startedAt,
    slowThresholdMs: PASSIVE_SLOW_DOC_MS
  });

  const contentType = (json?.data?.contentType || 'application/pdf').trim();
  const fileName = (json?.data?.fileName || '').trim();
  (buf as any).contentType = contentType;
  if (fileName) {
    (buf as any).contentDisposition = `attachment; filename="${fileName.replace(/"/g, '')}"`;
  }
  return buf;
}
